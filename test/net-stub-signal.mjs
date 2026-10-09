// Servidor de sinalização mínimo (COOP-ARCH §2) para os testes da janela net. O servidor de verdade é outra peça
// (signal/); aqui só o que a rede usa: hello/welcome com resume, sinais em estrela, lobby, ready, start, kick, ping e
// saída. Sem limite de taxa nem página de convite. Independente de transporte:
//   const handle = stub.attach({ send(text), close() });   handle.onMessage(text); handle.onClose();
// graceMs: quanto um socket caído (sem leave) segura a vaga para o resume; 0 = peer-left 'disconnected' na hora.
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomText = n => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export class StubSignal {
  constructor({ now = () => Date.now(), setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, graceMs = 0,
    ice = [], host = 'sinal.teste', echoStart = true } = {}) {
    Object.assign(this, { now, st, ct, graceMs, ice, host, echoStart });
    this.rooms = new Map();
    this.received = []; // [id|null, msg] de tudo o que chegou (para os testes conferirem)
  }

  attach(conn) {
    const client = { conn, member: null, room: null };
    const send = msg => { try { conn.send(JSON.stringify(msg)); } catch { /* fechado */ } };
    const fail = (code, message = code) => { send({ t: 'error', code, message }); conn.close(); };
    return {
      onMessage: text => {
        let m;
        try { m = JSON.parse(text); } catch { send({ t: 'error', code: 'bad-message', message: 'json' }); return; }
        this.received.push([client.member?.id ?? null, m]);
        if (!client.member) {
          if (m.t !== 'hello') { fail('bad-message', 'hello primeiro'); return; }
          this.#hello(client, m, send, fail);
          return;
        }
        this.#message(client, m, send);
      },
      onClose: () => this.#gone(client),
    };
  }

  // Derruba o socket de um membro sem avisar (queda de rede do lado do servidor).
  drop(id) {
    for (const room of this.rooms.values()) room.members.get(id)?.conn?.close();
  }

  members(code) { return [...(this.rooms.get(code)?.members.values() ?? [])]; }

  #broadcast(room, msg, except = null) {
    for (const m of room.members.values()) {
      if (m.id !== except && m.conn) try { m.conn.send(JSON.stringify(msg)); } catch { /* fechando */ }
    }
  }

  #hello(client, m, send, fail) {
    if (m.v !== 1) { fail('version'); return; }
    let room, member, fresh = false;
    if (m.role === 'host' && !m.room) {
      room = { code: randomText(5), hostId: null, members: new Map(), lobby: { map: null } };
      this.rooms.set(room.code, room);
    } else {
      room = this.rooms.get(m.room);
      if (!room) { fail('room-not-found'); return; }
    }
    member = [...room.members.values()].find(x => m.resume && x.resume === m.resume && x.role === m.role);
    if (member) {
      this.ct(member.grace);
      const old = member.conn; // socket antigo, se ainda pendurado (o novo assume antes, para o close não tirar a vaga)
      member.conn = client.conn;
      old?.close();
    } else {
      if (m.role === 'host' && room.hostId) { fail('forbidden', 'a sala já tem host'); return; }
      if (m.role === 'guest' && room.members.size >= 4) { fail('room-full'); return; }
      member = { id: randomText(8), name: String(m.name ?? '').slice(0, 32), role: m.role, ready: false,
        resume: randomText(24) };
      room.members.set(member.id, member);
      if (m.role === 'host') room.hostId = member.id;
      fresh = true;
    }
    member.conn = client.conn;
    Object.assign(client, { member, room });
    const pub = x => ({ id: x.id, name: x.name, role: x.role, ready: x.ready });
    send({ t: 'welcome', room: room.code, you: member.id, role: member.role, hostId: room.hostId,
      peers: [...room.members.values()].filter(x => x.id !== member.id).map(pub), lobby: { ...room.lobby },
      ice: this.ice, resume: member.resume, invite: `https://${this.host}/j/${room.code}`, started: room.started ?? null });
    if (fresh) this.#broadcast(room, { t: 'peer-joined', peer: pub(member) }, member.id);
  }

  #message(client, m, send) {
    const { member, room } = client;
    const host = member.role === 'host';
    switch (m.t) {
      case 'signal': {
        const to = room.members.get(m.to);
        if (!to || (!host && to.role !== 'host')) { send({ t: 'error', code: 'forbidden', message: 'estrela' }); return; }
        if (to.conn) to.conn.send(JSON.stringify({ t: 'signal', from: member.id, data: m.data }));
        return;
      }
      case 'lobby':
        if (!host) { send({ t: 'error', code: 'forbidden', message: 'só o host' }); return; }
        room.lobby = { map: m.data?.map ?? null };
        this.#broadcast(room, { t: 'lobby', data: room.lobby }, member.id);
        return;
      case 'ready':
        member.ready = m.ready === true;
        this.#broadcast(room, { t: 'peer-ready', id: member.id, ready: member.ready });
        return;
      case 'start':
        if (!host) { send({ t: 'error', code: 'forbidden', message: 'só o host' }); return; }
        room.started = { map: m.map, at: this.now() }; // como o signal/: quem chega depois vai direto para o mapa
        this.#broadcast(room, { t: 'start', ...room.started }, this.echoStart ? null : member.id);
        return;
      case 'kick': {
        const target = room.members.get(m.id);
        if (!host || !target || target.role === 'host') return;
        target.conn?.send(JSON.stringify({ t: 'closed', reason: 'kicked' }));
        this.#remove(room, target, 'kicked');
        return;
      }
      case 'ping': send({ t: 'pong', ts: m.ts }); return;
      case 'leave': this.#remove(room, member, 'left'); return;
      default: send({ t: 'error', code: 'bad-message', message: m.t });
    }
  }

  #remove(room, member, reason) {
    if (!room.members.has(member.id)) return;
    room.members.delete(member.id);
    this.ct(member.grace);
    const conn = member.conn;
    member.conn = null;
    conn?.close();
    if (member.role === 'host') {
      this.#broadcast(room, { t: 'closed', reason: 'host-left' });
      this.rooms.delete(room.code);
      for (const m of room.members.values()) { const c = m.conn; m.conn = null; this.ct(m.grace); c?.close(); }
      room.members.clear();
    } else this.#broadcast(room, { t: 'peer-left', id: member.id, reason });
  }

  #gone(client) {
    const { member, room } = client;
    if (!member || member.conn !== client.conn) return; // já saiu ou voltou por outro socket
    member.conn = null;
    if (!this.graceMs) { this.#remove(room, member, 'disconnected'); return; }
    member.grace = this.st(() => this.#remove(room, member, 'timeout'), this.graceMs);
  }
}
