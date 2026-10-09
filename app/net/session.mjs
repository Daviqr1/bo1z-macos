// Sessão de co-op da janela net: comandos do main (COOP-ARCH §4), estado da sala (campos de §3 que a rede conhece) e a
// ponte entre os enlaces WebRTC (peer.mjs) e o protocolo de pacotes (§1) no MessagePort da página do jogo.
//
// Estado (bo1z:net-state): { phase, role, room, invite, you, peers, signal, error, lobbyMap, startMap }
//   phase: 'idle' | 'connecting' | 'lobby' | 'starting' | 'error' ('playing' é do main, quando a página do mapa sobe)
//   you: { id, name } (+ ready no convidado)
//   peers: [{ id, name, role, ready, ping (ms | null), link ('direct'|'relay'|'connecting'|'lost'), loss (% | null) }]
//          (o host primeiro; no convidado, ping/link/perda dos outros convidados são os deles com o host, avisados
//          pelo host no ctl, porque a topologia é estrela)
//   signal: 'online' | 'connecting' | 'offline'
//   lobbyMap: zone do mapa escolhido (ou null); startMap: { zone, at } a cada start (at = epoch ms do servidor; um
//             start novo, mesmo para o mesmo mapa, muda o at)
//
// Princípio: a sinalização só monta a sala. Com a partida rodando, um problema no servidor de salas (queda, sala
// encerrada por tolerância vencida) não derruba um enlace P2P vivo; quem decide que o par se foi é o próprio enlace
// (15 s sem pong) ou uma saída explícita (leave/kick).
import { SignalClient } from './signal-client.mjs';
import { MAX_PACKET, PeerLink } from './peer.mjs';
import { isPlainObject, normalizeSignalUrl, parseRoomCode, realClock, sanitizeName } from './util.mjs';

const TICK_MS = 1000; // estado (ping/link envelhecem); a cada 2 ticks: { t:'net' } para a página e lista do host
const START_ECHO_MS = 2000; // host: espera o start voltar do servidor; sem eco, começa assim mesmo
const EXPLICIT_LEAVE = new Set(['left', 'leave', 'kicked', 'kick']);
const LINKS = new Set(['direct', 'relay', 'connecting', 'lost', 'lan']);

export const MESSAGES = Object.freeze({
  'config': 'Servidor de salas não configurado.',
  'code': 'Código de sala inválido (são 5 letras/números).',
  'no-map': 'Escolha um mapa antes de iniciar.',
  'offline': 'Sem conexão com o servidor de salas; tentando de novo…',
  'version': 'Versão do app diferente da do servidor. Atualize o app.',
  'room-not-found': 'Sala não encontrada. Confira o código ou peça um convite novo.',
  'room-full': 'A sala está cheia (até 4 jogadores).',
  'forbidden': 'O servidor recusou esta ação.',
  'name': 'Nome inválido.',
  'rate': 'Mensagens demais para o servidor de salas.',
  'bad-message': 'O servidor de salas não entendeu uma mensagem.',
  'host-left': 'O host saiu da sala.',
  'kicked': 'Você foi removido da sala.',
  'expired': 'A sala expirou.',
});
const err = (code, detail) => ({ code, message: MESSAGES[code] ?? detail ?? code });

export class NetSession {
  constructor({ WebSocket, RTCPeerConnection, clock = realClock, random = Math.random, log = () => {},
    onState = () => {}, peerOptions = {} }) {
    Object.assign(this, { WebSocket, RTCPeerConnection, clock, random, log, onState, peerOptions });
    this.config = { signalUrl: null, name: '' };
    this.port = null;
    this.counters = { fromPage: 0, toPage: 0, noPort: 0, noPeer: 0, badPkt: 0 };
    this.phase = 'idle';
    this.error = null;
    this.ticks = 0;
    this.#clear();
    this.ticker = clock.setInterval(() => this.#tick(), TICK_MS);
    this.#changed();
  }

  // Comando do main ({ cmd, args } de bo1z:net-cmd). Nunca lança: problema vira state.error.
  command(cmd, args) {
    try {
      switch (cmd) {
        case 'config': return this.#config(args);
        case 'create': return this.#create(args);
        case 'join': return this.#join(args);
        case 'leave': return this.leave();
        case 'setMap': return this.#setMap(args);
        case 'setReady': return this.#setReady(args);
        case 'start': return this.#start(args);
        case 'kick': return this.#kick(args);
        default: this.log(`comando desconhecido: ${cmd}`);
      }
    } catch (error) {
      this.log(`comando ${cmd} falhou: ${error.stack ?? error.message}`);
      this.error = err('internal', error.message);
      this.#changed();
    }
  }

  leave() {
    this.#teardown();
    this.phase = 'idle';
    this.error = null;
    this.#changed();
  }

  close() {
    this.leave();
    this.clock.clearInterval(this.ticker);
    if (this.port) { this.port.onmessage = null; try { this.port.close(); } catch {} this.port = null; }
  }

  // Port de pacotes de uma página do jogo (bo1z:net-port). O mais recente é o ativo; o anterior é fechado.
  attachPort(port) {
    const old = this.port;
    if (old && old !== port) { old.onmessage = null; try { old.close(); } catch { /* já fechado */ } }
    this.port = port;
    port.onmessage = event => this.#fromPage(event.data);
    port.start?.();
    this.log('port de pacotes novo (página do jogo)');
  }

  get state() {
    const peers = [...this.members.values()].map(p => this.#peerState(p));
    peers.sort((a, b) => (b.role === 'host') - (a.role === 'host'));
    return {
      phase: this.phase, role: this.role, room: this.room, invite: this.invite, you: this.you && { ...this.you },
      peers, signal: this.signalState, error: this.error, lobbyMap: this.lobbyMap,
      startMap: this.startMap && { ...this.startMap },
    };
  }

  stats() {
    return {
      mode: 'webrtc', role: this.role, room: this.room, signal: this.signalState, signalRtt: this.signal?.rtt ?? null,
      peers: [...this.links.values()].map(e => ({ ...e.link.stats(), slot: e.slot, joined: e.joined,
        name: this.members.get(e.id)?.name ?? null })),
      page: { ...this.counters },
    };
  }

  // ---- comandos

  #config(args) {
    if (!isPlainObject(args)) return;
    if ('signalUrl' in args) this.config.signalUrl = typeof args.signalUrl === 'string' && args.signalUrl || null;
    if ('name' in args) this.config.name = sanitizeName(args.name);
  }

  #create(args) {
    const a = isPlainObject(args) ? args : {};
    this.#open('host', { name: a.name, url: a.signalUrl, room: null, map: typeof a.map === 'string' ? a.map : null });
  }

  #join(args) {
    const a = isPlainObject(args) ? args : { code: args };
    const parsed = parseRoomCode(a.code);
    if (!parsed) { this.#fail(err('code')); return; }
    // O servidor do próprio convite é o que tem a sala.
    this.#open('guest', { name: a.name, url: a.signalUrl ?? parsed.server, room: parsed.code, map: null });
  }

  #setMap(args) {
    const zone = typeof args === 'string' ? args : isPlainObject(args) ? args.zone ?? args.map : null;
    if (this.role !== 'host' || typeof zone !== 'string' || !zone || zone.length > 64) {
      this.log(`setMap ignorado (${this.role ?? 'sem sala'}, ${zone})`);
      return;
    }
    this.desired.map = zone;
    this.lobbyMap = zone;
    this.signal?.send({ t: 'lobby', data: { map: zone } }); // fora do ar: o welcome da reconexão reaplica
    this.#changed();
  }

  #setReady(args) {
    const ready = typeof args === 'boolean' ? args : isPlainObject(args) ? args.ready === true : !!args;
    if (this.role !== 'guest') { this.log('setReady ignorado (não é convidado)'); return; }
    this.desired.ready = ready;
    if (this.you) this.you.ready = ready;
    this.signal?.send({ t: 'ready', ready });
    this.#changed();
  }

  #start(args) {
    if (this.role !== 'host' || !this.room) { this.log('start ignorado (só o host, numa sala)'); return; }
    const map = typeof args === 'string' ? args : isPlainObject(args) && typeof args.map === 'string' ? args.map
      : this.lobbyMap ?? this.desired.map;
    if (!map) { this.error = err('no-map'); this.#changed(); return; }
    if (!this.signal?.send({ t: 'start', map })) { this.error = err('offline'); this.#changed(); return; }
    this.error = null;
    this.clock.clearTimeout(this.startTimer);
    this.startTimer = this.clock.setTimeout(() => {
      this.startTimer = null;
      this.log('o servidor não devolveu o start; iniciando assim mesmo');
      this.#started(map, null, true);
    }, START_ECHO_MS);
  }

  #kick(args) {
    const id = typeof args === 'string' ? args : isPlainObject(args) ? args.id : null;
    if (this.role === 'host' && typeof id === 'string') this.signal?.send({ t: 'kick', id });
  }

  // ---- sala

  #clear() {
    Object.assign(this, {
      role: null, room: null, invite: null, you: null, hostId: null, name: '', lobbyMap: null, startMap: null,
      members: new Map(), // id -> { id, name, role, ready } (sem nós)
      links: new Map(), // id -> { id, link, slot, joined, detached }
      remote: new Map(), // convidado: id -> { ping, link, loss } dos outros convidados (lista do host)
      desired: { map: null, ready: false }, // reaplicado depois de uma reconexão
      signal: null, signalState: 'offline', iceServers: [], orphan: null, startTimer: null, startLocal: null,
    });
  }

  #fail(error) {
    this.#teardown();
    this.phase = 'error';
    this.error = error;
    this.#changed();
  }

  #teardown() {
    this.clock.clearTimeout(this.startTimer);
    const signal = this.signal;
    this.signal = null;
    signal?.stop({ leave: true });
    for (const id of [...this.links.keys()]) this.#dropLink(id, 'saiu da sala');
    this.#clear();
  }

  #open(role, { name, url, room, map }) {
    this.#teardown();
    const raw = url ?? this.config.signalUrl;
    if (!raw) { this.#fail(err('config')); return; }
    let signalUrl;
    try { signalUrl = normalizeSignalUrl(raw); } catch (error) { this.#fail(err('config', error.message)); return; }
    Object.assign(this, { role, phase: 'connecting', error: null, name: sanitizeName(name ?? this.config.name) });
    this.desired = { map, ready: false };
    this.log(`${role === 'host' ? 'criando sala' : `entrando na sala ${room}`} em ${signalUrl}`);
    const signal = new SignalClient({ url: signalUrl, role, name: this.name, room, WebSocket: this.WebSocket,
      clock: this.clock, random: this.random, log: m => this.log(`sinalização: ${m}`) });
    this.signal = signal;
    const mine = fn => (...args) => { if (this.signal === signal) fn(...args); };
    signal.on('state', mine(s => { this.signalState = s; this.#changed(); }));
    // Servidor de salas inalcançável na entrada: avisa (e continua tentando); o welcome limpa o erro.
    signal.on('retry', mine(n => { if (!this.room && n >= 3) { this.error = err('offline'); this.#changed(); } }));
    signal.on('welcome', mine(m => this.#welcome(m)));
    signal.on('message', mine(m => this.#message(m)));
    signal.on('fatal', mine(e => this.#signalGone(err(e.code, e.message))));
    signal.on('closed', mine(reason => this.#signalGone(err(reason || 'closed', 'A sala foi encerrada.'))));
    signal.start();
    this.#changed();
  }

  #welcome(m) {
    if (this.room && (m.room !== this.room || m.you !== this.you?.id)) {
      // O servidor não reconheceu a reentrada: outra sala/identidade. Os enlaces antigos não valem mais.
      this.log(`reentrada virou sala ${m.room} / id ${m.you} (era ${this.room} / ${this.you?.id})`);
      for (const id of [...this.links.keys()]) this.#dropLink(id, 'sala nova');
      this.members.clear();
      this.remote.clear();
    }
    const first = !this.room;
    Object.assign(this, { room: m.room, invite: m.invite, hostId: m.hostId, iceServers: m.ice, error: null });
    this.you = { id: m.you, name: this.name, ...(this.role === 'guest' ? { ready: this.desired.ready } : {}) };
    if (this.phase === 'connecting') this.phase = 'lobby';
    this.lobbyMap = m.lobby.map;
    this.log(`${first ? 'na sala' : 'de volta à sala'} ${m.room} como ${m.you} (${m.peers.length} na lista, ` +
      `${m.ice.length} servidores ICE)`);

    const listed = new Map(m.peers.filter(p => p.id !== m.you).map(p => [p.id, { ...p }]));
    for (const [id, entry] of this.links) {
      if (listed.has(id)) { entry.detached = false; continue; }
      if (entry.link.alive) { entry.detached = true; listed.set(id, this.members.get(id) ?? this.#unknown(id)); }
      else this.#dropLink(id, 'fora da sala');
    }
    this.members = listed;
    for (const entry of this.links.values()) entry.link.setIceServers(this.iceServers);
    if (this.role === 'guest') this.#ensureHostLink();
    else for (const p of this.members.values()) if (p.role === 'guest') this.#link(p.id);
    // Sala já em partida: o convidado que chega (ou volta) vai direto para o mapa; o mesmo { zone, at } não repete.
    if (m.started && (this.startMap?.zone !== m.started.map || this.startMap?.at !== m.started.at))
      this.#started(m.started.map, m.started.at, false);

    // O que o usuário pediu enquanto a sinalização estava fora volta a valer.
    if (this.role === 'host' && this.desired.map && this.desired.map !== this.lobbyMap) {
      this.lobbyMap = this.desired.map;
      this.signal.send({ t: 'lobby', data: { map: this.desired.map } });
    }
    if (this.role === 'guest') {
      const me = m.peers.find(p => p.id === m.you);
      if ((me?.ready ?? false) !== this.desired.ready) this.signal.send({ t: 'ready', ready: this.desired.ready });
    }
    this.#changed();
  }

  #message(m) {
    switch (m.t) {
      case 'peer-joined': {
        const p = m.peer;
        if (p.id === this.you?.id) break;
        this.members.set(p.id, { ...p });
        const entry = this.links.get(p.id);
        if (entry) entry.detached = false;
        this.log(`entrou: ${p.name} (${p.id}, ${p.role})`);
        if (this.role === 'host' && p.role === 'guest') this.#link(p.id);
        break;
      }
      case 'peer-left': this.#peerLeft(m.id, m.reason); break;
      case 'peer-ready': {
        const p = this.members.get(m.id);
        if (p) p.ready = m.ready;
        if (m.id === this.you?.id && this.role === 'guest') this.you.ready = m.ready;
        break;
      }
      case 'signal': this.#signal(m.from, m.data); break;
      case 'lobby': this.lobbyMap = m.data.map; break;
      case 'start': this.#started(m.map, m.at, false); break;
      case 'error': this.log(`servidor: ${m.code} ${m.message}`); break;
    }
    this.#changed();
  }

  #peerLeft(id, reason) {
    if (this.role === 'guest' && id === this.hostId) { this.#signalGone(err('host-left')); return; }
    const entry = this.links.get(id);
    if (entry && !EXPLICIT_LEAVE.has(reason) && entry.link.alive) {
      this.log(`${id} caiu da sinalização (${reason || '?'}), mas o enlace P2P segue vivo: fica até cair`);
      entry.detached = true;
      return;
    }
    this.log(`saiu: ${this.members.get(id)?.name ?? '?'} (${id}, ${reason || '?'})`);
    this.members.delete(id);
    this.remote.delete(id);
    this.#dropLink(id, reason || 'saiu');
  }

  #signal(from, data) {
    if (this.role === 'guest') {
      if (from === this.hostId) this.links.get(from)?.link.signal(data);
      return;
    }
    if (!this.members.has(from)) this.members.set(from, this.#unknown(from)); // sinal antes do peer-joined
    this.#link(from).link.signal(data);
  }

  #started(map, at, local) {
    this.clock.clearTimeout(this.startTimer);
    this.startTimer = null;
    // Eco atrasado de um start que o host já começou sozinho: não navega duas vezes.
    if (!local && this.startLocal !== null && this.startMap?.zone === map && this.clock.now() - this.startLocal < 10000) {
      this.startLocal = null;
      return;
    }
    this.startLocal = local ? this.clock.now() : null;
    this.startMap = { zone: map, at: at ?? this.clock.wall() };
    this.lobbyMap = map;
    this.phase = 'starting';
    this.log(`partida: ${map}`);
    this.#changed();
  }

  // A sinalização acabou: erro fatal (ex.: reentrada numa sala que sumiu com o servidor) ou sala encerrada. Sem enlace
  // vivo, a sala acabou para nós. Com enlace vivo, o jogo segue P2P até ele cair, exceto quando fomos expulsos.
  #signalGone(error) {
    const alive = [...this.links.values()].some(e => e.link.alive);
    if (!this.room || !alive || error.code === 'kicked') { this.#fail(error); return; }
    this.log(`sinalização encerrada (${error.code}); o jogo segue P2P até o enlace cair`);
    this.orphan = error;
    this.error = error;
    const signal = this.signal;
    this.signal = null;
    signal?.stop({ leave: false });
    this.signalState = 'offline';
    this.#changed();
  }

  // ---- enlaces

  #unknown(id) { return { id, name: '?', role: id === this.hostId ? 'host' : 'guest', ready: false }; }

  #freeSlot() {
    const used = new Set([...this.links.values()].map(e => e.slot));
    let slot = 1;
    while (used.has(slot)) ++slot;
    return slot;
  }

  #ensureHostLink() {
    for (const id of [...this.links.keys()]) if (id !== this.hostId) this.#dropLink(id, 'host mudou');
    if (this.hostId) this.#link(this.hostId);
  }

  #link(id) {
    let entry = this.links.get(id);
    if (entry) return entry;
    const host = this.role === 'host';
    const link = new PeerLink({ id, initiator: !host, iceServers: this.iceServers,
      RTCPeerConnection: this.RTCPeerConnection, clock: this.clock, options: this.peerOptions,
      log: m => this.log(`par ${id}: ${m}`),
      // par fora da sinalização (só o P2P segura): o servidor recusaria o sinal
      sendSignal: data => { if (!this.links.get(id)?.detached) this.signal?.send({ t: 'signal', to: id, data }); } });
    entry = { id, link, slot: host ? this.#freeSlot() : 0, joined: false, detached: false };
    this.links.set(id, entry);
    link.onPacket = host ? b => this.#post({ t: 'pkt', id, b }) : b => this.#post({ t: 'pkt', b });
    link.on('up', () => this.#up(entry));
    link.on('lost', () => this.#lost(entry));
    link.on('change', () => this.#changed());
    link.on('ctl', m => this.#ctl(entry, m));
    return entry;
  }

  #dropLink(id, reason) {
    const entry = this.links.get(id);
    if (!entry) return;
    entry.link.close();
    this.links.delete(id);
    if (entry.joined) this.#post({ t: 'leave', id, reason });
  }

  #up(entry) {
    if (this.role === 'host' && !entry.joined) {
      entry.joined = true;
      this.#post(this.#joinMsg(entry));
    }
    this.#changed();
  }

  #lost(entry) {
    if (this.role === 'host' && entry.joined) {
      entry.joined = false;
      this.#post({ t: 'leave', id: entry.id, reason: 'lost' });
    }
    if (entry.detached || this.orphan) {
      if (entry.detached) this.members.delete(entry.id);
      this.#dropLink(entry.id, 'perdido');
    }
    if (this.orphan && !this.links.size) this.#fail(this.orphan);
    this.#changed();
  }

  #joinMsg(entry) { return { t: 'join', id: entry.id, slot: entry.slot, name: this.members.get(entry.id)?.name ?? '?' }; }

  #ctl(entry, m) {
    // Lista do host com o enlace de cada convidado (para o lobby do convidado mostrar o ping dos outros).
    if (this.role !== 'guest' || entry.id !== this.hostId || m.t !== 'peers' || !Array.isArray(m.peers)) return;
    this.remote.clear();
    for (const p of m.peers.slice(0, 8)) {
      if (!isPlainObject(p) || typeof p.id !== 'string' || p.id === this.you?.id) continue;
      this.remote.set(p.id, {
        ping: Number.isFinite(p.ping) ? Math.round(p.ping) : null,
        link: LINKS.has(p.link) ? p.link : 'connecting',
        loss: Number.isFinite(p.loss) ? p.loss : null,
      });
    }
    this.#changed();
  }

  #peerState(p) {
    const entry = this.links.get(p.id);
    const info = entry ? { ping: entry.link.ping, link: entry.link.link, loss: entry.link.loss }
      : this.remote.get(p.id) ?? { ping: null, link: 'connecting', loss: null };
    return { id: p.id, name: p.name, role: p.role, ready: p.ready, ...info };
  }

  // ---- página do jogo (protocolo §1)

  #post(msg) {
    if (!this.port) { ++this.counters.noPort; return; }
    try { this.port.postMessage(msg); ++this.counters.toPage; } catch { ++this.counters.noPort; }
  }

  #fromPage(m) {
    if (!isPlainObject(m)) return;
    if (m.t === 'pkt') {
      const b = m.b;
      if (!(b instanceof Uint8Array) || !b.length || b.length > MAX_PACKET) { ++this.counters.badPkt; return; }
      ++this.counters.fromPage;
      const entry = this.role === 'host' ? this.links.get(m.id) : this.links.get(this.hostId);
      if (!entry || (this.role === 'host' && !entry.joined)) { ++this.counters.noPeer; return; }
      entry.link.send(b);
    } else if (m.t === 'ready') {
      const rings = Array.isArray(m.rings) && m.rings.length ? `, rings ${m.rings.join(',')}` : '';
      this.log(`página pronta (${m.role ?? '?'}${rings})`);
      // Página nova (outro mapa, recarga) com convidados já na sala: reapresenta cada um.
      if (this.role !== 'host') return;
      for (const entry of this.links.values()) if (entry.joined) this.#post(this.#joinMsg(entry));
    } else if (m.t === 'full') {
      this.log(`a página não tem ring livre para ${m.id}`);
    }
  }

  #tick() {
    this.#changed();
    if (++this.ticks % 2) return;
    if (this.port && this.room) this.#post({ t: 'net', stats: this.stats() });
    if (this.role === 'host' && this.links.size) {
      const peers = [...this.links.values()]
        .map(e => ({ id: e.id, ping: e.link.ping, link: e.link.link, loss: e.link.loss }));
      for (const entry of this.links.values()) entry.link.sendCtl({ t: 'peers', peers });
    }
  }

  // Estado só sai quando muda (ping/link mudam no máximo uma vez por segundo).
  #changed() {
    if (this.pendingState) return;
    this.pendingState = true;
    queueMicrotask(() => {
      this.pendingState = false;
      const state = this.state, json = JSON.stringify(state);
      if (json === this.lastState) return;
      this.lastState = json;
      this.onState(state);
    });
  }
}
