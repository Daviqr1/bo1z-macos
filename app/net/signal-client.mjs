// Cliente do protocolo de sinalização (COOP-ARCH §2): WebSocket JSON com o servidor signal/ (Worker + Durable Object).
// O servidor só serve para montar a sala e trocar SDP/candidatos; o jogo passa P2P. Por isso o cliente insiste:
// reconecta sozinho com backoff (com teto) e volta para a mesma vaga com o token "resume" do welcome.
//
// Eventos: 'state' ('offline' | 'connecting' | 'online'), 'welcome' (msg), 'message' (demais mensagens do servidor),
// 'fatal' ({ code, message }: erro que não adianta repetir; o cliente para), 'closed' (reason: a sala acabou),
// 'retry' (tentativas seguidas sem welcome, a cada nova espera).
import { Emitter, isPlainObject, realClock, sanitizeName } from './util.mjs';

export const SIGNAL_VERSION = 1;
export const MAX_MESSAGE = 16 * 1024;
const PING_MS = 10000;
const DEAD_MS = 30000; // nada do servidor por 3 pings: socket meio-aberto (NAT/Wi-Fi), fecha e reconecta
const CONNECT_TIMEOUT_MS = 10000; // abrir o socket e receber o welcome
const BACKOFF_BASE_MS = 500, BACKOFF_CAP_MS = 15000;
const QUEUE_MAX = 64, QUEUE_AGE_MS = 15000; // sinais WebRTC guardados enquanto reconecta (oferta perdida trava o par)
const OPEN = 1; // WebSocket.OPEN
// Erro em resposta ao hello (antes do welcome) é fatal: repetir o mesmo hello não muda nada (version,
// room-not-found, room-full, forbidden, name, bad-message). Só 'rate' tenta de novo, com backoff. Depois do welcome
// nenhum erro é fatal: um forbidden num sinal para quem acabou de sair não pode derrubar a sala.
const RETRY_CODES = new Set(['rate']);

const str = (x, max = 256) => typeof x === 'string' && x.length <= max;
const num = x => typeof x === 'number' && Number.isFinite(x);
const role = x => x === 'host' || x === 'guest';

function peer(p) {
  if (!isPlainObject(p) || !str(p.id, 64) || !p.id || !role(p.role)) return null;
  return { id: p.id, name: sanitizeName(p.name, '?'), role: p.role, ready: p.ready === true };
}

// RTCIceServer: só stun:/turn:/turns:, com credenciais em texto (o resto é ignorado).
function iceServer(s) {
  if (!isPlainObject(s)) return null;
  const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => str(u, 512) && /^(stun|turns?):/i.test(u));
  if (!urls.length) return null;
  const out = { urls };
  if (str(s.username, 512)) out.username = s.username;
  if (str(s.credential, 512)) out.credential = s.credential;
  return out;
}

// Confere uma mensagem do servidor e devolve uma cópia só com os campos conhecidos (ou null se não serve).
export function validateServerMessage(m) {
  if (!isPlainObject(m) || typeof m.t !== 'string') return null;
  switch (m.t) {
    case 'welcome': {
      if (!str(m.room, 16) || !str(m.you, 64) || !m.you || !role(m.role) || !str(m.hostId, 64)) return null;
      if (!Array.isArray(m.peers) || m.peers.length > 16) return null;
      const lobbyMap = isPlainObject(m.lobby) && str(m.lobby.map, 64) ? m.lobby.map : null;
      return { t: 'welcome', room: m.room, you: m.you, role: m.role, hostId: m.hostId,
        peers: m.peers.map(peer).filter(Boolean), lobby: { map: lobbyMap },
        ice: Array.isArray(m.ice) ? m.ice.slice(0, 16).map(iceServer).filter(Boolean) : [],
        resume: str(m.resume, 512) ? m.resume : null, invite: str(m.invite, 512) ? m.invite : null,
        // partida já em andamento (quem entra ou volta no meio do jogo vai direto para o mapa)
        started: isPlainObject(m.started) && str(m.started.map, 64) && m.started.map && Number.isFinite(m.started.at)
          ? { map: m.started.map, at: m.started.at } : null };
    }
    case 'peer-joined': { const p = peer(m.peer); return p ? { t: m.t, peer: p } : null; }
    case 'peer-left': return str(m.id, 64) ? { t: m.t, id: m.id, reason: str(m.reason, 64) ? m.reason : '' } : null;
    case 'peer-ready': return str(m.id, 64) && typeof m.ready === 'boolean' ? { t: m.t, id: m.id, ready: m.ready } : null;
    case 'signal': return str(m.from, 64) && isPlainObject(m.data) ? { t: m.t, from: m.from, data: m.data } : null;
    case 'lobby': {
      const map = isPlainObject(m.data) ? m.data.map ?? null : undefined;
      return map === null || str(map, 64) ? { t: m.t, data: { map } } : null;
    }
    case 'start': return str(m.map, 64) && m.map ? { t: m.t, map: m.map, at: num(m.at) ? m.at : null } : null;
    case 'pong': return num(m.ts) ? { t: m.t, ts: m.ts } : null;
    case 'error':
      return str(m.code, 64) ? { t: m.t, code: m.code, message: str(m.message, 1024) ? m.message : '' } : null;
    case 'closed': return { t: m.t, reason: str(m.reason, 64) ? m.reason : '' };
    default: return null;
  }
}

export class SignalClient extends Emitter {
  // url: já normalizada (normalizeSignalUrl). role 'host' | 'guest'; room: código (convidado) ou null (host cria).
  constructor({ url, role, name, room = null, WebSocket, clock = realClock, random = Math.random, log = () => {} }) {
    super();
    Object.assign(this, { url, role, name, room, WebSocket, clock, random, log });
    this.state = 'offline';
    this.resume = null;
    this.you = null;
    this.welcomed = false;
    this.stopped = true;
    this.attempts = 0;
    this.rtt = null;
    this.queue = [];
    this.counters = { connects: 0, invalid: 0, rx: 0, tx: 0 };
    this.ws = null;
    this.timers = { connect: null, retry: null, ping: null };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  // leave: avisa o servidor (sair de verdade). Sem leave, a vaga continua reservada para o resume.
  stop({ leave = true } = {}) {
    if (this.stopped) return;
    if (leave && this.welcomed) this.#raw({ t: 'leave' });
    this.stopped = true;
    this.#drop(null);
  }

  // Mensagens 'signal' esperam a reconexão (com limite de idade); as outras só saem com o socket no ar.
  send(msg) {
    if (this.welcomed && this.ws?.readyState === OPEN) return this.#raw(msg);
    if (msg.t === 'signal' && !this.stopped) {
      this.queue.push({ msg, at: this.clock.now() });
      if (this.queue.length > QUEUE_MAX) this.queue.shift();
    }
    return false;
  }

  #raw(msg) {
    const text = JSON.stringify(msg);
    if (text.length > MAX_MESSAGE) { this.log(`mensagem ${msg.t} grande demais (${text.length} B)`); return false; }
    try { this.ws.send(text); } catch (error) { this.log(`envio falhou: ${error.message}`); return false; }
    ++this.counters.tx;
    return true;
  }

  #setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.emit('state', state);
  }

  // Entrar ou voltar a uma sala: o código vai também na URL (?room=), porque o Worker escolhe o Durable Object da sala
  // no upgrade, antes do hello. Sem código (host criando), o Worker gera um.
  socketUrl() {
    if (!this.room) return this.url;
    const url = new URL(this.url);
    url.searchParams.set('room', this.room);
    return url.href;
  }

  #connect() {
    this.#setState('connecting');
    this.welcomed = false;
    ++this.counters.connects;
    let ws;
    try { ws = new this.WebSocket(this.socketUrl()); } catch (error) {
      this.log(`WebSocket: ${error.message}`);
      this.#retry();
      return;
    }
    this.ws = ws;
    this.lastRx = this.clock.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const hello = { t: 'hello', v: SIGNAL_VERSION, role: this.role, name: this.name };
      if (this.room) hello.room = this.room;
      if (this.resume) hello.resume = this.resume;
      this.#raw(hello);
    };
    ws.onmessage = event => { if (this.ws === ws) this.#onMessage(event.data); };
    ws.onerror = () => {}; // o close vem logo depois
    ws.onclose = event => { if (this.ws === ws) { this.log(`socket fechou (${event?.code ?? '?'})`); this.#retry(); } };
    this.timers.connect = this.clock.setTimeout(() => {
      if (this.ws === ws && !this.welcomed) { this.log('sem welcome em 10 s'); this.#retry(); }
    }, CONNECT_TIMEOUT_MS);
  }

  #onMessage(data) {
    this.lastRx = this.clock.now();
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) { ++this.counters.invalid; return; }
    let m;
    try { m = validateServerMessage(JSON.parse(data)); } catch { m = null; }
    if (!m) { ++this.counters.invalid; this.log(`mensagem inválida ignorada: ${data.slice(0, 120)}`); return; }
    ++this.counters.rx;
    if (m.t === 'error') {
      if (!this.welcomed && !RETRY_CODES.has(m.code)) { this.#fatal(m.code, m.message); return; }
      this.log(`erro do servidor: ${m.code} ${m.message}`); // se o servidor fechar o socket, a gente volta com resume
      this.emit('message', m);
      return;
    }
    if (m.t === 'closed') {
      this.log(`sala encerrada: ${m.reason}`);
      this.stopped = true;
      this.#drop(null);
      this.emit('closed', m.reason);
      return;
    }
    if (m.t === 'pong') { this.rtt = Math.max(0, this.clock.wall() - m.ts); return; }
    if (m.t === 'welcome') {
      if (m.role !== this.role) {
        this.#fatal('forbidden', `papel ${m.role} no welcome (esperado ${this.role})`);
        return;
      }
      this.clock.clearTimeout(this.timers.connect);
      Object.assign(this, { welcomed: true, attempts: 0, room: m.room, you: m.you });
      if (m.resume) this.resume = m.resume;
      this.#setState('online');
      this.clock.clearInterval(this.timers.ping);
      this.timers.ping = this.clock.setInterval(() => this.#ping(), PING_MS);
      this.emit('welcome', m);
      // Sinais guardados durante a queda (os velhos demais já não servem: o par refaz a negociação)
      const now = this.clock.now(), queued = this.queue.splice(0);
      for (const { msg, at } of queued) if (now - at <= QUEUE_AGE_MS) this.#raw(msg);
      return;
    }
    if (!this.welcomed) { ++this.counters.invalid; return; } // nada além de welcome/erro antes do welcome
    this.emit('message', m);
  }

  #ping() {
    if (this.clock.now() - this.lastRx > DEAD_MS) {
      this.log('servidor mudo há 30 s, reconectando');
      this.#retry();
      return;
    }
    this.#raw({ t: 'ping', ts: this.clock.wall() });
  }

  #fatal(code, message) {
    this.log(`erro fatal: ${code} ${message}`);
    this.stopped = true;
    this.#drop(null);
    this.emit('fatal', { code, message });
  }

  // Larga o socket atual (sem esperar o close dele) e, se não parou, agenda a próxima tentativa.
  #drop(then) {
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    for (const key of ['connect', 'retry']) this.clock.clearTimeout(this.timers[key]);
    this.clock.clearInterval(this.timers.ping);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000); } catch { /* já fechado */ }
    }
    if (this.stopped) { this.queue.length = 0; this.#setState('offline'); return; }
    then?.();
  }

  #retry() {
    this.#drop(() => {
      this.#setState('connecting');
      const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempts) * (0.5 + this.random() / 2);
      ++this.attempts;
      this.log(`reconectando em ${Math.round(delay)} ms (tentativa ${this.attempts})`);
      this.timers.retry = this.clock.setTimeout(() => { if (!this.stopped) this.#connect(); }, delay);
      this.emit('retry', this.attempts);
    });
  }
}
