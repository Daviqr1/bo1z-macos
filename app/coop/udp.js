// Transporte do co-op no processo principal (Node): UDP direto entre os apps. Serve para o teste local (127.0.0.1),
// rede de casa e Tailscale (IP 100.x fixo entre redes diferentes, sem servidor de convite nem TURN). Semântica UDP de
// propósito: o netchan do motor já cuida de perda e retransmissão.
//
// Datagrama: 'B' '1' tipo ...
//   1 HELLO   convidado -> host: [versão u8][código u8 len][código][nome utf8]
//   2 WELCOME host -> convidado: [versão u8][slot u8]
//   3 REJECT  host -> convidado: [motivo utf8]
//   4 DATA    pacote cru do motor (≤ 1264 B)
//   5 PING / 6 PONG: [t f64] (eco do relógio de quem mandou o PING)
//   7 BYE
//   8 CTL     JSON do lobby (≤ 1200 B): host -> convidados { t:'lobby', map, hostName } | { t:'start', map };
//             convidado -> host { t:'ready', ready }
'use strict';
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');

const VERSION = 1;
const T = { HELLO: 1, WELCOME: 2, REJECT: 3, DATA: 4, PING: 5, PONG: 6, BYE: 7, CTL: 8 };
const CTL_MAX = 1200;
const encodeCtl = obj => { const b = Buffer.from(JSON.stringify(obj)); if (b.length > CTL_MAX) throw new RangeError('CTL grande demais'); return b; };
const decodeCtl = body => { try { const o = JSON.parse(body.toString('utf8')); return o && typeof o === 'object' && typeof o.t === 'string' ? o : null; } catch { return null; } };
const MAX_PAYLOAD = 1264;
const PEER_TIMEOUT_MS = 10000;
// Quem erra o código 5 vezes em 1 min fica 10 min ignorado (o código tem só 5 letras; um pacote que entra vai direto
// para o parser de rede do motor). Não abra a porta 27960 no roteador: rede de casa ou Tailscale bastam.
const BAN_TRIES = 5, BAN_WINDOW_MS = 60e3, BAN_MS = 10 * 60e3;

function frame(type, body = null) {
  const b = Buffer.allocUnsafe(3 + (body ? body.length : 0));
  b[0] = 0x42; b[1] = 0x31; b[2] = type;
  if (body) b.set(body, 3);
  return b;
}
const parse = msg => (msg.length >= 3 && msg[0] === 0x42 && msg[1] === 0x31) ? { type: msg[2], body: msg.subarray(3) } : null;
const f64 = t => { const b = Buffer.allocUnsafe(8); b.writeDoubleLE(t); return b; };
const splitAddress = (s, defaultPort = 27960) => {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(String(s).trim());
  if (!m) throw new Error(`endereço inválido: ${s}`);
  return { address: m[1], port: Number(m[2] ?? defaultPort) };
};

class CoopHost extends EventEmitter {
  constructor({ port = 27960, bind = '0.0.0.0', maxGuests = 3, code = '', log = () => {}, now = () => performance.now() } = {}) {
    super();
    Object.assign(this, { port, bind, maxGuests, code, log, now });
    this.peers = new Map(); // "ip:port" -> { id, slot, name, address, port, last, rtt }
    this.byId = new Map();
    this.nextId = 1;
    this.counters = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, rejected: 0, junk: 0, banned: 0 };
    this.strikes = new Map(); // ip -> { tries, since, until }
  }

  strike(address) {
    const now = this.now(), s = this.strikes.get(address);
    if (!s || now - s.since > BAN_WINDOW_MS) { this.strikes.set(address, { tries: 1, since: now, until: 0 }); return; }
    if (++s.tries >= BAN_TRIES) { s.until = now + BAN_MS; this.log('coop', `${address} bloqueado por 10 min (código errado)`); }
  }

  start() {
    this.sock = dgram.createSocket({ type: this.bind.includes(':') ? 'udp6' : 'udp4' });
    this.sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    this.timer = setInterval(() => this.expire(), 1000);
    return new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(this.port, this.bind, () => { this.sock.off('error', reject); this.sock.on('error', e => this.log('udp', e.message)); this.port = this.sock.address().port; resolve(this.port); });
    });
  }

  onMessage(msg, rinfo) {
    const m = parse(msg);
    if (!m) { ++this.counters.junk; return; }
    const key = `${rinfo.address}:${rinfo.port}`;
    let peer = this.peers.get(key);
    if (!peer && this.strikes.get(rinfo.address)?.until > this.now()) { ++this.counters.banned; return; }
    if (m.type === T.HELLO) {
      const version = m.body[0], codeLen = m.body[1] ?? 0;
      const code = m.body.subarray(2, 2 + codeLen).toString('utf8'), name = m.body.subarray(2 + codeLen).toString('utf8').slice(0, 32);
      const reject = reason => { ++this.counters.rejected; this.sock.send(frame(T.REJECT, Buffer.from(reason)), rinfo.port, rinfo.address); };
      if (version !== VERSION) return reject(`versão ${version} != ${VERSION}`);
      if (this.code && code !== this.code) { this.strike(rinfo.address); return reject('código da sala errado'); }
      let fresh = false;
      if (!peer) {
        if (this.peers.size >= this.maxGuests) return reject('sala cheia');
        const used = new Set([...this.peers.values()].map(p => p.slot));
        let slot = 1; while (used.has(slot)) ++slot;
        peer = { id: this.nextId++, slot, name, address: rinfo.address, port: rinfo.port, last: this.now(), rtt: null };
        this.peers.set(key, peer);
        this.byId.set(peer.id, peer);
        fresh = true;
      }
      peer.last = this.now();
      // WELCOME antes do 'join': o que o host mandar no 'join' (lobby) chega depois do WELCOME no convidado
      this.sock.send(frame(T.WELCOME, Buffer.from([VERSION, peer.slot])), rinfo.port, rinfo.address);
      if (fresh) {
        this.log('coop', `entrou: ${name || '?'} (${key}) slot ${peer.slot}`);
        this.emit('join', peer.id, { name, slot: peer.slot, address: key });
      }
      return;
    }
    if (!peer) return; // DATA/PING de quem não fez HELLO: ignora
    peer.last = this.now();
    if (m.type === T.DATA) {
      if (m.body.length > MAX_PAYLOAD) return;
      ++this.counters.rx; this.counters.rxBytes += m.body.length;
      this.emit('packet', peer.id, new Uint8Array(m.body));
    } else if (m.type === T.PING) {
      this.sock.send(frame(T.PONG, m.body.subarray(0, 8)), rinfo.port, rinfo.address);
    } else if (m.type === T.PONG && m.body.length >= 8) {
      peer.rtt = this.now() - m.body.readDoubleLE(0);
    } else if (m.type === T.CTL && m.body.length <= CTL_MAX) {
      const o = decodeCtl(m.body);
      if (o) this.emit('ctl', peer.id, o);
    } else if (m.type === T.BYE) this.drop(key, 'saiu');
  }

  // Mensagem de lobby para um convidado (id) ou todos (id omitido).
  sendCtl(obj, id) {
    const body = frame(T.CTL, encodeCtl(obj));
    for (const peer of id === undefined ? this.byId.values() : [this.byId.get(id)].filter(Boolean))
      try { this.sock.send(body, peer.port, peer.address); } catch (error) { this.log('udp', error.message); }
  }

  send(id, bytes) {
    const peer = this.byId.get(id);
    if (!peer || bytes.length > MAX_PAYLOAD) return false;
    ++this.counters.tx; this.counters.txBytes += bytes.length;
    try { this.sock.send(frame(T.DATA, bytes), peer.port, peer.address); } catch (error) { this.log('udp', error.message); return false; }
    return true;
  }

  expire() {
    const now = this.now();
    for (const [key, peer] of this.peers) {
      if (now - peer.last > PEER_TIMEOUT_MS) this.drop(key, 'sem resposta');
      else this.sock.send(frame(T.PING, f64(now)), peer.port, peer.address);
    }
  }

  drop(key, reason) {
    const peer = this.peers.get(key);
    if (!peer) return;
    this.peers.delete(key);
    this.byId.delete(peer.id);
    this.log('coop', `saiu: ${peer.name || '?'} (${key}): ${reason}`);
    this.emit('leave', peer.id, reason);
  }

  stats() {
    return { role: 'host', port: this.port, code: this.code, ...this.counters,
      peers: [...this.byId.values()].map(p => ({ id: p.id, slot: p.slot, name: p.name, address: `${p.address}:${p.port}`, rtt: p.rtt && +p.rtt.toFixed(1) })) };
  }

  close() {
    clearInterval(this.timer);
    for (const peer of this.peers.values()) try { this.sock.send(frame(T.BYE), peer.port, peer.address); } catch {}
    try { this.sock?.close(); } catch {}
  }
}

class CoopGuest extends EventEmitter {
  constructor({ host, code = '', name = '', log = () => {}, now = () => performance.now() } = {}) {
    super();
    Object.assign(this, { code, name, log, now });
    this.target = splitAddress(host, 27960);
    this.welcomed = false;
    this.slot = 0;
    this.rtt = null;
    this.last = 0;
    this.counters = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, droppedBeforeWelcome: 0 };
  }

  start() {
    this.sock = dgram.createSocket({ type: this.target.address.includes(':') ? 'udp6' : 'udp4' });
    this.sock.on('message', (msg, rinfo) => {
      if (rinfo.port !== this.target.port) return;
      const m = parse(msg);
      if (!m) return;
      this.last = this.now();
      if (m.type === T.WELCOME) {
        if (!this.welcomed) { this.welcomed = true; this.slot = m.body[1]; this.log('coop', `na sala (slot ${this.slot})`); this.emit('welcome', this.slot); }
      } else if (m.type === T.REJECT) {
        this.log('coop', `recusado: ${m.body.toString('utf8')}`);
        this.emit('reject', m.body.toString('utf8'));
      } else if (m.type === T.DATA) {
        ++this.counters.rx; this.counters.rxBytes += m.body.length;
        this.emit('packet', new Uint8Array(m.body));
      } else if (m.type === T.PING) {
        this.sock.send(frame(T.PONG, m.body.subarray(0, 8)), this.target.port, this.target.address);
      } else if (m.type === T.PONG && m.body.length >= 8) {
        this.rtt = this.now() - m.body.readDoubleLE(0);
      } else if (m.type === T.CTL && m.body.length <= CTL_MAX) {
        const o = decodeCtl(m.body);
        if (o) this.emit('ctl', o);
      } else if (m.type === T.BYE) {
        this.welcomed = false;
        this.emit('lost', 'host saiu');
      }
    });
    this.sock.on('error', e => this.log('udp', e.message));
    const tick = () => {
      if (this.welcomed && this.now() - this.last > PEER_TIMEOUT_MS) { this.welcomed = false; this.emit('lost', 'sem resposta do host'); }
      if (!this.welcomed) this.hello();
      else this.sock.send(frame(T.PING, f64(this.now())), this.target.port, this.target.address);
    };
    this.timer = setInterval(tick, 1000);
    tick();
  }

  hello() {
    const code = Buffer.from(this.code), name = Buffer.from(this.name.slice(0, 32));
    this.sock.send(frame(T.HELLO, Buffer.concat([Buffer.from([VERSION, code.length]), code, name])), this.target.port, this.target.address);
  }

  send(bytes) {
    if (!this.welcomed) { ++this.counters.droppedBeforeWelcome; return false; }
    if (bytes.length > MAX_PAYLOAD) return false;
    ++this.counters.tx; this.counters.txBytes += bytes.length;
    try { this.sock.send(frame(T.DATA, bytes), this.target.port, this.target.address); } catch (error) { this.log('udp', error.message); return false; }
    return true;
  }

  sendCtl(obj) {
    if (!this.welcomed) return false;
    try { this.sock.send(frame(T.CTL, encodeCtl(obj)), this.target.port, this.target.address); return true; }
    catch (error) { this.log('udp', error.message); return false; }
  }

  stats() {
    return { role: 'guest', host: `${this.target.address}:${this.target.port}`, welcomed: this.welcomed, slot: this.slot,
      rtt: this.rtt && +this.rtt.toFixed(1), ...this.counters };
  }

  close() {
    clearInterval(this.timer);
    try { if (this.welcomed) this.sock.send(frame(T.BYE), this.target.port, this.target.address); } catch {}
    setTimeout(() => { try { this.sock?.close(); } catch {} }, 50);
  }
}

// Endereços para o convite do modo por IP: Tailscale (100.64.0.0/10) primeiro, depois IPv4 da rede local.
function inviteAddresses(port) {
  const out = [];
  for (const list of Object.values(require('node:os').networkInterfaces())) for (const a of list ?? []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const [x, y] = a.address.split('.').map(Number);
    out.push({ address: a.address, tailscale: x === 100 && y >= 64 && y < 128 });
  }
  out.sort((a, b) => b.tailscale - a.tailscale);
  return out.map(a => `${a.address}:${port}${a.tailscale ? ' (Tailscale)' : ''}`);
}

// Liga um transporte (CoopHost/CoopGuest) ao MessagePort da página (page.mjs). listen(handler) registra o handler de
// mensagens no port (MessagePortMain: port.on('message', e => handler(e.data))). Devolve unbind().
function bindPage(transport, role, port, listen, log = () => {}, statsEveryMs = 2000) {
  const post = m => { try { port.postMessage(m); } catch { /* port fechado */ } };
  const onPacket = role === 'host' ? (id, b) => post({ t: 'pkt', id, b }) : b => post({ t: 'pkt', b });
  const onJoin = (id, info) => post({ t: 'join', id, ...info });
  const onLeave = (id, reason) => post({ t: 'leave', id, reason });
  transport.on('packet', onPacket);
  if (role === 'host') { transport.on('join', onJoin); transport.on('leave', onLeave); }
  listen(m => {
    if (m?.t === 'pkt' && m.b) role === 'host' ? transport.send(m.id, m.b) : transport.send(m.b);
    else if (m?.t === 'ready') {
      log('página', `pronta (${m.role}${m.rings?.length ? `, rings ${m.rings.join(',')}` : ''})`);
      // página nova (outro mapa) com convidados já na sala: reapresenta cada um
      if (role === 'host') for (const p of transport.stats().peers) post({ t: 'join', id: p.id, slot: p.slot, name: p.name });
    } else if (m?.t === 'full') log('página', `sem ring para o convidado #${m.id}`);
  });
  const timer = statsEveryMs ? setInterval(() => post({ t: 'net', stats: transport.stats() }), statsEveryMs) : null;
  return () => {
    clearInterval(timer);
    transport.off('packet', onPacket);
    transport.off('join', onJoin);
    transport.off('leave', onLeave);
  };
}

// Código de sala: 5 caracteres sem 0 O 1 I L (spec §2).
function roomCode(random = require('node:crypto').randomInt) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => alphabet[random(alphabet.length)]).join('');
}

module.exports = { CoopHost, CoopGuest, bindPage, roomCode, splitAddress, inviteAddresses, VERSION, MAX_PAYLOAD };
