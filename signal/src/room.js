// Sala de co-op: lógica pura (sem APIs da Cloudflare), igual no Durable Object (do.js) e no servidor Node de
// desenvolvimento (dev-server.mjs). Protocolo: docs/COOP-ARCH.md §2 (WebSocket JSON, versão 1).
//
// Quem hospeda a sala injeta:
//   socket          { send(text), close(code, reason), save?(attachment) } — save guarda o que o socket precisa para
//                   voltar depois da hibernação do Durable Object (serializeAttachment); no Node é opcional
//   now()           relógio em epoch ms
//   setAlarm(at)    um despertador só (at em epoch ms, ou null para cancelar); quando tocar, chame room.alarm()
//   store           { save(snapshot), clear() } — estado da sala em disco; clear() = a sala acabou, apague tudo
//   ice()           Promise<RTCIceServer[]> (ice.js)
//   random(n)       Uint8Array com n bytes aleatórios
//
// Desenho: o estado da sala (jogadores, tokens, mapa) é um objeto serializável (snapshot); o que é de cada conexão
// (fila de hello, balde de taxa) fica só na memória. Depois de hibernar, a sala volta do snapshot e cada socket volta
// pelo seu attachment (restore). Prazos (tolerância do host, convidado caído, hello, sala vazia) viram um despertador
// só: o Durable Object pode dormir entre eles (setTimeout impediria a hibernação).
import { STUN_ONLY } from './ice.js';

export const VERSION = 1;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0 O 1 I L (spec §2)
export const CODE_LENGTH = 5;
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 símbolos: sorteio sem viés com 5 bits
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // 64: 32 chars = 192 bits
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAP_RE = /^[a-z0-9_]{1,48}$/; // zone do motor, ex. zombie_coast

export const LIMITS = Object.freeze({
  maxPlayers: 4, // host + 3
  maxMessageBytes: 16 * 1024,
  ratePerSecond: 50, // balde por socket: 50 mensagens/s, rajada de 100
  rateBurst: 100,
  hostGraceMs: 30e3, // host caiu: a sala espera a reentrada por 30 s
  guestGraceMs: 30e3, // convidado caiu: 30 s sem avisar ninguém (o WebRTC pode continuar de pé nesse meio-tempo)
  emptyTtlMs: 10 * 60e3, // sala sem nenhuma conexão some em 10 min
  helloTimeoutMs: 10e3, // socket que não manda hello em 10 s é fechado
  maxSockets: 12, // 4 jogadores + folga para reentradas e conexões ainda sem hello
  maxIds: 256, // ids nunca se repetem na sala; isso limita o conjunto guardado
  maxBadMessages: 20, // depois de tantas mensagens inválidas, fecha
  maxQueued: 16, // mensagens que chegam enquanto o hello espera o ICE
});

// Códigos de fechamento do WebSocket (o motivo de verdade vai antes, numa mensagem error/closed).
export const CLOSE = Object.freeze({ normal: 1000, tooBig: 1009, error: 4000, replaced: 4001, timeout: 4002,
  rate: 4008 });

export const ERRORS = Object.freeze({
  version: 'versão do protocolo diferente da do servidor: atualize o app',
  'room-not-found': 'sala não encontrada: confira o código (a sala pode ter acabado)',
  'room-full': 'sala cheia (máximo de 4 jogadores)',
  'bad-message': 'mensagem inválida',
  rate: 'mensagens demais em pouco tempo: conexão encerrada',
  forbidden: 'ação não permitida',
  name: 'nome inválido: use de 1 a 24 caracteres, sem caracteres de controle',
});

const defaultRandom = n => crypto.getRandomValues(new Uint8Array(n));

// Sorteio sem viés: descarta bytes acima do maior múltiplo do tamanho do alfabeto.
export function randomString(alphabet, length, random = defaultRandom) {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of random(length * 2)) {
      if (byte < limit) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const makeRoomCode = random => randomString(CODE_ALPHABET, CODE_LENGTH, random);
export const makePeerId = random => randomString(ID_ALPHABET, 8, random);
export const makeToken = random => randomString(TOKEN_ALPHABET, 32, random);

// Aceita minúsculas e espaços em volta (código digitado à mão); fora isso, só o alfabeto. Devolve null se inválido.
export function normalizeRoomCode(value) {
  if (typeof value !== 'string' || value.length > 16) return null;
  const code = value.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return null;
  return code;
}

// Controles, separadores de linha, marcas de direção (golpe do texto invertido) e caracteres invisíveis.
const BAD_NAME = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

// Nome de 1 a 24 caracteres (code points, depois de NFC e trim), com pelo menos um visível. null se inválido.
export function cleanName(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const name = value.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > 24 || BAD_NAME.test(name) || !VISIBLE.test(name)) return null;
  return name;
}

// Prazos configuráveis pelo ambiente, só para testes (wrangler dev --var HOST_GRACE_MS:1500, ou no dev-server).
// Em produção fique com os padrões de LIMITS.
const ENV_LIMITS = [['hostGraceMs', 'HOST_GRACE_MS'], ['guestGraceMs', 'GUEST_GRACE_MS'],
  ['emptyTtlMs', 'EMPTY_TTL_MS'], ['helloTimeoutMs', 'HELLO_TIMEOUT_MS']];
export function limitsFromEnv(env = {}) {
  const limits = {};
  for (const [key, name] of ENV_LIMITS) {
    const value = Number(env[name]);
    if (env[name] !== undefined && env[name] !== '' && Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

export const isMapZone = value => typeof value === 'string' && MAP_RE.test(value);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const publicPeer = p => ({ id: p.id, name: p.name, role: p.role, ready: p.ready });

// Bytes em UTF-8 sem alocar (o WebSocket entrega a string já decodificada).
function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; ++i) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; ++i; }
    else n += 3;
  }
  return n;
}

export class Room {
  constructor({ code = null, now = Date.now, setAlarm = () => {}, store = {}, ice = async () => STUN_ONLY,
    random = defaultRandom, log = () => {}, limits = {}, snapshot = null } = {}) {
    Object.assign(this, { now, setAlarm, store, ice, random, log });
    this.limits = { ...LIMITS, ...limits };
    this.code = code;
    this.origin = null; // origem pública do servidor (para o link de convite), a de quem criou a sala
    this.created = false;
    this.createdAt = null;
    this.hostId = null;
    this.lobby = { map: null };
    this.started = null; // { map, at } da última partida iniciada
    this.peers = new Map(); // id -> { id, name, role, ready, token, joinedAt, offlineAt, gone }
    this.tokens = new Map(); // token de reentrada -> id
    this.usedIds = new Set();
    this.closedReason = null;
    this.emptySince = null;
    this.conns = new Map(); // socket -> conexão (fase, id, balde de taxa…)
    this.online = new Map(); // id -> conexão ativa desse jogador
    this.alarmAt = null;
    this.dirty = false;
    this.counters = { signals: 0, dropped: 0, errors: 0 };
    if (snapshot) this.load(snapshot);
  }

  // ---- entrada (quem hospeda chama) ----

  // Socket novo, antes do hello. create: veio pela rota de criação (o código desta sala acabou de ser sorteado).
  attach(socket, { create = false, origin = null, code = null } = {}) {
    try {
      this.code ??= code;
      const conn = this.newConn(socket, { create, origin, at: this.now() });
      if (this.closedReason) { this.fail(conn, 'room-not-found', 'esta sala já acabou'); return false; }
      if (this.conns.size > this.limits.maxSockets) {
        this.fail(conn, 'room-full', 'conexões demais nesta sala');
        return false;
      }
      this.save(conn);
      return true;
    } finally { this.settle(); }
  }

  // O código desta sala está livre para uma criação? (o Durable Object responde 409 e o Worker sorteia outro)
  canCreate() {
    return !this.created && !this.closedReason && ![...this.conns.values()].some(conn => conn.create);
  }

  // Depois da hibernação: [{ socket, attachment }] de todos os sockets que continuam abertos. Não mexe no despertador:
  // o evento que acordou o objeto (mensagem, close, alarm, fetch) vem logo depois e acerta o próximo prazo; regravar
  // o alarm aqui, com um alarm prestes a tocar, faz o runtime cancelar esse disparo.
  restore(entries) {
    try {
      const now = this.now();
      for (const { socket, attachment: a } of entries) {
        if (this.conns.has(socket)) continue;
        this.code ??= a?.code ?? null;
        const conn = this.newConn(socket, { create: !!a?.create, origin: a?.origin ?? null, at: a?.at ?? now });
        if (!a?.id) continue; // ainda sem hello
        const peer = this.peers.get(a.id);
        if (!peer || peer.gone || this.closedReason) {
          this.fail(conn, 'room-not-found', 'a sala não existe mais');
          continue;
        }
        const other = this.online.get(peer.id);
        if (other) this.drop(other, CLOSE.replaced, 'replaced');
        conn.id = peer.id; conn.phase = 'in';
        this.online.set(peer.id, conn);
        if (peer.offlineAt !== null) { peer.offlineAt = null; this.dirty = true; }
      }
      // Quem estava online no último snapshot e não tem socket caiu enquanto o objeto dormia: o prazo começa agora.
      for (const peer of this.peers.values()) {
        if (peer.gone || peer.offlineAt !== null || this.online.has(peer.id)) continue;
        peer.offlineAt = now;
        this.dirty = true;
      }
      if (this.conns.size === 0 && this.created) this.emptySince ??= now;
    } finally { this.settle(false); }
  }

  // Mensagem do cliente (string = quadro de texto; qualquer outra coisa = binário, recusado). Devolve uma Promise
  // quando a mensagem é um hello (o welcome espera os servidores ICE); senão undefined.
  message(socket, data) {
    const conn = this.conns.get(socket);
    if (!conn) return this.settle();
    try {
      if (!this.take(conn)) return this.fail(conn, 'rate', ERRORS.rate, CLOSE.rate);
      if (typeof data !== 'string') return this.reject(conn, 'bad-message', 'só mensagens de texto (JSON)');
      const max = this.limits.maxMessageBytes;
      if (data.length > max || (data.length * 3 > max && utf8Length(data) > max)) {
        return this.fail(conn, 'bad-message', `mensagem maior que ${max / 1024} KiB`, CLOSE.tooBig);
      }
      let m = null;
      try { m = JSON.parse(data); } catch { /* cai na validação abaixo */ }
      if (!isPlainObject(m) || typeof m.t !== 'string') {
        return this.reject(conn, 'bad-message', 'esperado um objeto JSON com t');
      }
      if (conn.phase === 'hello') return this.hello(conn, m);
      if (conn.phase === 'wait') {
        if (conn.queue.length >= this.limits.maxQueued) return this.fail(conn, 'bad-message', 'espere o welcome');
        conn.queue.push(m);
        return undefined;
      }
      return this.dispatch(conn, m);
    } finally { this.settle(); }
  }

  // O socket fechou (do outro lado, ou por erro). Jogador que cai sem leave fica na sala esperando a reentrada.
  disconnect(socket) {
    const conn = this.conns.get(socket);
    // Socket que a sala já tinha largado: nada a fazer, mas pode ser o evento que acordou o objeto (acerta o alarm).
    try { if (conn) this.detach(conn); } finally { this.settle(); }
  }

  alarm() {
    this.alarmAt = null; // o despertador que tocou já foi consumido: o settle() marca o próximo
    try {
      const now = this.now(), L = this.limits;
      for (const conn of [...this.conns.values()]) {
        if (conn.phase === 'hello' && now - conn.openedAt >= L.helloTimeoutMs) {
          this.fail(conn, 'bad-message', 'o hello não chegou a tempo', CLOSE.timeout);
        }
      }
      if (!this.created || this.closedReason) return;
      const host = this.peers.get(this.hostId);
      if (host && host.offlineAt !== null && now - host.offlineAt >= L.hostGraceMs) return this.close('host-left');
      for (const peer of this.peers.values()) {
        if (peer.role !== 'guest' || peer.gone || peer.offlineAt === null) continue;
        if (now - peer.offlineAt < L.guestGraceMs) continue;
        // Continua com o token: pode voltar (mesmo id) enquanto a sala existir, se houver vaga.
        peer.gone = true; peer.ready = false; this.dirty = true;
        this.log(`sala ${this.code}: ${peer.name} (${peer.id}) não voltou`);
        this.broadcast({ t: 'peer-left', id: peer.id, reason: 'lost' });
      }
      const empty = this.conns.size === 0 && this.emptySince !== null;
      if (empty && now - this.emptySince >= L.emptyTtlMs) this.close('expired');
    } finally { this.settle(); }
  }

  // ---- estado ----

  snapshot() {
    return {
      v: 1, code: this.code, origin: this.origin, created: this.created, createdAt: this.createdAt, hostId: this.hostId,
      lobby: { ...this.lobby }, started: this.started && { ...this.started }, emptySince: this.emptySince,
      peers: [...this.peers.values()].map(p => ({ ...p })), usedIds: [...this.usedIds],
    };
  }

  load(s) {
    if (s?.v !== 1) return;
    Object.assign(this, { code: s.code, origin: s.origin ?? null, created: !!s.created, createdAt: s.createdAt ?? null,
      hostId: s.hostId ?? null, lobby: { map: s.lobby?.map ?? null }, started: s.started ?? null,
      emptySince: s.emptySince ?? null });
    for (const p of s.peers ?? []) {
      this.peers.set(p.id, { ...p });
      this.tokens.set(p.token, p.id);
    }
    this.usedIds = new Set(s.usedIds ?? []);
  }

  get closed() { return this.closedReason; }

  // Nada que valha guardar: sala nunca criada e sem sockets, ou já encerrada (o servidor Node descarta o objeto).
  get idle() { return !!this.closedReason || (!this.created && this.conns.size === 0); }

  info() {
    return { code: this.code, created: this.created, closed: this.closedReason, sockets: this.conns.size,
      players: this.present().map(p => ({ ...publicPeer(p), online: this.online.has(p.id) })), lobby: this.lobby,
      counters: { ...this.counters } };
  }

  present() { return [...this.peers.values()].filter(p => !p.gone); }

  // ---- hello ----

  hello(conn, m) {
    if (m.t !== 'hello') return this.fail(conn, 'bad-message', 'a primeira mensagem tem de ser hello');
    if (m.v !== VERSION) return this.fail(conn, 'version', `${ERRORS.version} (servidor: v${VERSION})`);
    if (m.role !== 'host' && m.role !== 'guest') return this.fail(conn, 'bad-message', 'role tem de ser host ou guest');
    const name = cleanName(m.name);
    if (!name) return this.fail(conn, 'name', ERRORS.name);
    let room = null, resume = null;
    if (m.room !== undefined && m.room !== null) {
      room = normalizeRoomCode(m.room);
      if (!room) return this.fail(conn, 'room-not-found', 'código de sala inválido');
    }
    if (m.resume !== undefined && m.resume !== null) {
      if (typeof m.resume !== 'string' || !TOKEN_RE.test(m.resume)) {
        return this.fail(conn, 'bad-message', 'token de reentrada inválido');
      }
      resume = m.resume;
    }
    const request = { role: m.role, name, room, resume };
    // Recusa logo o que já dá para recusar (sem gastar uma credencial TURN); o resto decide depois do ICE.
    const error = this.check(conn, request);
    if (error) return this.fail(conn, ...error);
    conn.phase = 'wait';
    conn.queue = [];
    return this.admitWithIce(conn, request);
  }

  async admitWithIce(conn, request) {
    let ice;
    try { ice = await this.ice(); } catch { ice = STUN_ONLY; }
    if (this.conns.get(conn.socket) !== conn) return; // fechou enquanto esperava
    try {
      this.admit(conn, request, ice);
      const queued = conn.queue ?? [];
      conn.queue = null;
      for (const m of queued) {
        if (this.conns.get(conn.socket) !== conn) break;
        this.dispatch(conn, m);
      }
    } finally { this.settle(); }
  }

  // [código, mensagem] se o hello não pode entrar agora; null se pode.
  check(conn, { role, room, resume }) {
    const L = this.limits;
    if (this.closedReason) return ['room-not-found', 'esta sala já acabou'];
    if (resume) {
      if (!this.created || (room && room !== this.code)) return ['room-not-found', ERRORS['room-not-found']];
      const peer = this.peers.get(this.tokens.get(resume));
      if (!peer || peer.role !== role) return ['forbidden', 'não deu para voltar à sala: token de reentrada inválido'];
      if (peer.gone && this.present().length >= L.maxPlayers) return ['room-full', ERRORS['room-full']];
      return null;
    }
    if (role === 'host') {
      if (room) return ['forbidden', 'para voltar como host, mande o token de reentrada (resume)'];
      if (!conn.create) return ['bad-message', 'para criar uma sala, conecte em /ws sem ?room='];
      if (this.created) return ['forbidden', 'esta sala já existe'];
      return null;
    }
    if (conn.create) return ['bad-message', 'para entrar numa sala, conecte em /ws?room=<código>'];
    if (!room || !this.created || room !== this.code) return ['room-not-found', ERRORS['room-not-found']];
    if (this.present().length >= L.maxPlayers) return ['room-full', ERRORS['room-full']];
    if (this.usedIds.size >= L.maxIds) return ['room-full', 'esta sala já recebeu entradas demais: crie outra'];
    return null;
  }

  admit(conn, request, ice) {
    const error = this.check(conn, request); // a sala pode ter mudado enquanto o ICE chegava
    if (error) return this.fail(conn, ...error);
    let peer, announce = false;
    if (request.resume) {
      peer = this.peers.get(this.tokens.get(request.resume));
      // Conexão antiga ainda aberta (meia-aberta: a rede trocou e o servidor ainda não percebeu): a nova assume.
      const old = this.online.get(peer.id);
      if (old) this.drop(old, CLOSE.replaced, 'replaced');
      announce = peer.gone;
      peer.gone = false;
      peer.offlineAt = null;
      this.log(`sala ${this.code}: ${peer.name} (${peer.id}, ${peer.role}) voltou`);
    } else if (request.role === 'host') {
      this.created = true;
      this.createdAt = this.now();
      this.origin = conn.origin;
      peer = this.newPeer('host', request.name);
      this.hostId = peer.id;
      this.log(`sala ${this.code} criada por ${peer.name} (${peer.id})`);
    } else {
      peer = this.newPeer('guest', request.name);
      announce = true;
      this.log(`sala ${this.code}: ${peer.name} (${peer.id}) entrou`);
    }
    this.dirty = true;
    conn.id = peer.id;
    conn.phase = 'in';
    this.online.set(peer.id, conn);
    this.save(conn);
    this.send(conn, {
      t: 'welcome', room: this.code, you: peer.id, role: peer.role, hostId: this.hostId,
      peers: this.present().filter(p => p.id !== peer.id).map(publicPeer), // os outros jogadores, sem você
      lobby: { map: this.lobby.map }, ice, resume: peer.token, invite: this.inviteUrl(),
      started: this.started, // extensão: partida já iniciada (convidado que volta no meio do jogo)
    });
    if (announce) this.broadcast({ t: 'peer-joined', peer: publicPeer(peer) }, conn);
  }

  newPeer(role, name) {
    let id, token;
    do id = makePeerId(this.random); while (this.usedIds.has(id));
    do token = makeToken(this.random); while (this.tokens.has(token));
    const peer = { id, name, role, ready: role === 'host', token, joinedAt: this.now(), offlineAt: null, gone: false };
    this.usedIds.add(id);
    this.peers.set(id, peer);
    this.tokens.set(token, id);
    return peer;
  }

  inviteUrl() { return `${this.origin ?? ''}/j/${this.code}`; }

  // ---- mensagens de quem já está na sala ----

  dispatch(conn, m) {
    switch (m.t) {
      case 'signal': return this.onSignal(conn, m);
      case 'lobby': return this.onLobby(conn, m);
      case 'ready': return this.onReady(conn, m);
      case 'start': return this.onStart(conn, m);
      case 'kick': return this.onKick(conn, m);
      case 'ping': return this.onPing(conn, m);
      case 'leave': return this.onLeave(conn);
      case 'hello': return this.warn(conn, 'bad-message', 'você já está na sala');
      default: return this.warn(conn, 'bad-message', 'tipo de mensagem desconhecido');
    }
  }

  // Estrela: só host ⇄ convidado. data é opaco ({ sdp } ou { candidate }). Destino que saiu ou está sem conexão:
  // descarta (melhor esforço, como o resto da sinalização; o WebRTC refaz a negociação quando precisa).
  onSignal(conn, m) {
    if (typeof m.to !== 'string' || !isPlainObject(m.data)) {
      return this.warn(conn, 'bad-message', 'signal precisa de to e data');
    }
    const from = this.peers.get(conn.id), to = this.peers.get(m.to);
    if (to && to.role === from.role) return this.warn(conn, 'forbidden', 'a sinalização só vai entre host e convidado');
    const target = to && !to.gone ? this.online.get(to.id) : undefined;
    if (!target) { ++this.counters.dropped; return; }
    ++this.counters.signals;
    this.send(target, { t: 'signal', from: from.id, data: m.data });
  }

  onLobby(conn, m) {
    if (conn.id !== this.hostId) return this.warn(conn, 'forbidden', 'só o host escolhe o mapa');
    const map = isPlainObject(m.data) ? m.data.map : undefined;
    if (!isMapZone(map)) return this.warn(conn, 'bad-message', 'mapa inválido');
    const changed = map !== this.lobby.map;
    this.lobby.map = map;
    this.broadcast({ t: 'lobby', data: { map } });
    if (!changed) return;
    this.dirty = true;
    // Mapa novo: o "pronto" de antes era para outro mapa (o convidado pode nem ter o pack ainda).
    for (const peer of this.present()) {
      if (peer.role !== 'guest' || !peer.ready) continue;
      peer.ready = false;
      this.broadcast({ t: 'peer-ready', id: peer.id, ready: false });
    }
  }

  onReady(conn, m) {
    const peer = this.peers.get(conn.id);
    if (peer.role !== 'guest') return this.warn(conn, 'forbidden', 'só convidados marcam pronto');
    if (typeof m.ready !== 'boolean') return this.warn(conn, 'bad-message', 'ready tem de ser true ou false');
    if (peer.ready !== m.ready) { peer.ready = m.ready; this.dirty = true; }
    this.broadcast({ t: 'peer-ready', id: peer.id, ready: peer.ready });
  }

  onStart(conn, m) {
    if (conn.id !== this.hostId) return this.warn(conn, 'forbidden', 'só o host inicia a partida');
    const map = m.map ?? this.lobby.map;
    if (!isMapZone(map)) return this.warn(conn, 'bad-message', 'escolha um mapa antes de iniciar');
    this.lobby.map = map;
    this.started = { map, at: this.now() };
    this.dirty = true;
    this.log(`sala ${this.code}: partida iniciada em ${map}`);
    this.broadcast({ t: 'start', map, at: this.started.at });
  }

  onKick(conn, m) {
    if (conn.id !== this.hostId) return this.warn(conn, 'forbidden', 'só o host pode expulsar');
    const target = typeof m.id === 'string' ? this.peers.get(m.id) : undefined;
    if (!target || target.role !== 'guest') return this.warn(conn, 'bad-message', 'esse jogador não está na sala');
    const targetConn = this.online.get(target.id);
    this.remove(target, 'kicked', targetConn);
    if (targetConn) {
      this.send(targetConn, { t: 'closed', reason: 'kicked' });
      this.drop(targetConn, CLOSE.normal, 'kicked');
    }
  }

  // ts opcional: {"t":"ping"} puro recebe {"t":"pong"} puro (no Durable Object, a resposta automática do runtime
  // devolve isso sem acordar o objeto: é o keepalive barato). Com ts, o pong traz também a hora do servidor (now),
  // que dá ao cliente o desvio de relógio para usar o at do start.
  onPing(conn, m) {
    if (m.ts === undefined) return this.send(conn, { t: 'pong' });
    if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) return this.warn(conn, 'bad-message', 'ts inválido');
    this.send(conn, { t: 'pong', ts: m.ts, now: this.now() });
  }

  onLeave(conn) {
    const peer = this.peers.get(conn.id);
    if (peer.role === 'host') return this.close('host-left'); // saída de propósito: sem tolerância
    this.log(`sala ${this.code}: ${peer.name} (${peer.id}) saiu`);
    this.remove(peer, 'left', conn);
    this.drop(conn, CLOSE.normal, 'left');
  }

  // Tira o jogador de vez (token invalidado). Quem já tinha sido anunciado como perdido não é anunciado de novo.
  remove(peer, reason, except) {
    this.peers.delete(peer.id);
    this.tokens.delete(peer.token);
    this.dirty = true;
    if (!peer.gone) this.broadcast({ t: 'peer-left', id: peer.id, reason }, except);
  }

  // Fim da sala: avisa todo mundo, fecha os sockets e apaga o estado.
  close(reason) {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.log(`sala ${this.code} encerrada: ${reason}`);
    for (const conn of [...this.conns.values()]) {
      this.send(conn, conn.phase === 'in' ? { t: 'closed', reason }
        : { t: 'error', code: 'room-not-found', message: 'a sala acabou' });
      this.drop(conn, CLOSE.normal, reason);
    }
    this.peers.clear();
    this.tokens.clear();
    this.online.clear();
    this.dirty = false;
    this.alarmAt = null;
    this.setAlarm(null);
    this.store.clear?.();
  }

  // ---- conexões ----

  newConn(socket, { create, origin, at }) {
    const conn = { socket, id: null, phase: 'hello', create, origin, openedAt: at, tokens: this.limits.rateBurst,
      last: this.now(), bad: 0, queue: null };
    this.conns.set(socket, conn);
    if (this.emptySince !== null) { this.emptySince = null; if (this.created) this.dirty = true; }
    return conn;
  }

  // Attachment do socket (sobrevive à hibernação; limite de 16 KiB, aqui são poucos bytes).
  save(conn) {
    try {
      conn.socket.save?.({ code: this.code, create: conn.create, origin: conn.origin, at: conn.openedAt, id: conn.id });
    } catch (error) { this.log(`attachment: ${error.message}`); }
  }

  // Balde de fichas por socket. Não sobrevive à hibernação de propósito: o objeto só dorme depois de ~10 s parado,
  // e nesse tempo o balde já teria enchido de novo.
  take(conn) {
    const now = this.now();
    conn.tokens = Math.min(this.limits.rateBurst, conn.tokens + (now - conn.last) * this.limits.ratePerSecond / 1000);
    conn.last = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  send(conn, message) {
    try { conn.socket.send(JSON.stringify(message)); } catch { /* socket fechando: o disconnect vem depois */ }
  }

  broadcast(message, except = null) {
    const text = JSON.stringify(message);
    for (const conn of this.conns.values()) {
      if (conn.phase !== 'in' || conn === except) continue;
      try { conn.socket.send(text); } catch { /* idem */ }
    }
  }

  // Erro que encerra a conexão.
  fail(conn, code, message = ERRORS[code], closeCode = CLOSE.error) {
    ++this.counters.errors;
    this.send(conn, { t: 'error', code, message });
    this.drop(conn, closeCode, code);
  }

  // Erro que não encerra (já está na sala); abuso continuado encerra.
  warn(conn, code, message = ERRORS[code]) {
    ++this.counters.errors;
    this.send(conn, { t: 'error', code, message });
    if (++conn.bad > this.limits.maxBadMessages) this.drop(conn, CLOSE.error, 'bad-messages');
  }

  reject(conn, code, message) {
    return conn.phase === 'in' ? this.warn(conn, code, message) : this.fail(conn, code, message);
  }

  // O servidor fecha o socket. Jogador cuja conexão cai assim (taxa, abuso) fica offline, como numa queda.
  drop(conn, code, reason) {
    if (this.conns.get(conn.socket) !== conn) return;
    this.detach(conn);
    try { conn.socket.close(code, reason); } catch { /* já fechado */ }
  }

  detach(conn) {
    this.conns.delete(conn.socket);
    if (conn.id && this.online.get(conn.id) === conn) {
      this.online.delete(conn.id);
      const peer = this.peers.get(conn.id);
      if (peer && !this.closedReason) {
        peer.offlineAt = this.now();
        this.dirty = true;
        this.log(`sala ${this.code}: ${peer.name} (${peer.id}) sem conexão`);
      }
    }
    if (this.conns.size === 0 && this.created && !this.closedReason) {
      this.emptySince = this.now();
      this.dirty = true;
    }
  }

  // Fim de cada evento: grava o estado se mudou e acerta o despertador para o prazo mais próximo.
  settle(schedule = true) {
    if (this.closedReason) return;
    if (this.dirty) {
      this.dirty = false;
      if (this.created) {
        try { this.store.save?.(this.snapshot()); } catch (error) { this.log(`store: ${error.message}`); }
      }
    }
    if (!schedule) return;
    const L = this.limits;
    let next = Infinity;
    for (const conn of this.conns.values()) {
      if (conn.phase === 'hello') next = Math.min(next, conn.openedAt + L.helloTimeoutMs);
    }
    for (const peer of this.peers.values()) {
      if (peer.gone || peer.offlineAt === null) continue;
      next = Math.min(next, peer.offlineAt + (peer.role === 'host' ? L.hostGraceMs : L.guestGraceMs));
    }
    if (this.created && this.conns.size === 0 && this.emptySince !== null) {
      next = Math.min(next, this.emptySince + L.emptyTtlMs);
    }
    let at = Number.isFinite(next) ? next : null;
    // Ronda: com a sala viva há sempre um despertador a no máximo emptyTtlMs. Se o runtime reiniciar sem avisar
    // (deploy, falha), as conexões somem sem webSocketClose; a ronda acorda o objeto, o restore nota que ninguém
    // está conectado e os prazos normais encerram a sala (sem ela, o estado ficaria no storage para sempre).
    // Um despertador futuro que já existe serve de ronda: não regrava o alarm a cada mensagem.
    if (at === null && this.created) {
      const now = this.now();
      at = this.alarmAt !== null && this.alarmAt > now ? this.alarmAt : now + L.emptyTtlMs;
    }
    if (at !== this.alarmAt) {
      this.alarmAt = at;
      this.setAlarm(at);
    }
  }
}
