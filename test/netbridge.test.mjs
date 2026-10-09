// F1: ponte ligando dois motores emulados (host e convidado, memórias separadas), como na partida real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetBridge, clientQport, isOOB, oobText } from '../app/coop/netbridge.mjs';
import { EngineSim, NA_LOOPBACK } from '../sim/engine.mjs';
import { bumpAllocator, makeMemory, TEST_LAYOUT } from './helpers.mjs';

const L = TEST_LAYOUT;
const enc = new TextEncoder(), dec = new TextDecoder();
const oob = text => Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...enc.encode(text)]);
// pacote sequenciado cliente->servidor: seq u32, qport u16, payload (Netchan_Transmit com netsrc <= 0)
const seqFromClient = (seq, qport, payload) => {
  const b = new Uint8Array(6 + payload.length), v = new DataView(b.buffer);
  v.setUint32(0, seq, true); v.setUint16(4, qport, true); b.set(payload, 6); return b;
};

function world() {
  const hostMem = makeMemory(), heap = bumpAllocator(L);
  const host = { mem: hostMem, eng: new EngineSim(hostMem, L), bridge: createNetBridge({ buffer: hostMem, layout: L, malloc: heap.malloc, free: heap.free }), heap };
  const guests = [1, 2].map(() => {
    const mem = makeMemory();
    return { mem, eng: new EngineSim(mem, L), bridge: createNetBridge({ buffer: mem, layout: L }) };
  });
  // "rede": filas em memória, entregues por pump()
  const toHost = [], toGuest = new Map();
  const net = {
    attach(guest) {
      const k = host.bridge.openHostRing();
      toGuest.set(k, guest);
      guest.k = k;
      return k;
    },
    pump() {
      for (const g of toGuest.values()) g.bridge.drainClientOut(bytes => toHost.push([g.k, bytes]));
      for (const [k, bytes] of toHost.splice(0)) host.bridge.injectToServer(bytes, k);
      for (const [k, g] of toGuest) host.bridge.drainRing(k, bytes => g.bridge.injectToClient(bytes));
      host.bridge.pump();
      for (const g of toGuest.values()) g.bridge.pump();
    },
  };
  return { host, guests, net };
}

// "servidor" mínimo do host: responde getchallenge/connect e ecoa pacotes sequenciados com a porta de quem mandou.
function serverFrame(host, log) {
  for (let p; (p = host.eng.getLoopPacket(1));) {
    log.push({ port: p.from.port, oob: oobText(p.bytes), qport: clientQport(p.bytes) });
    const text = oobText(p.bytes);
    if (text?.startsWith('getchallenge')) host.eng.sendPacket(1, oob('challengeResponse 123'), p.from);
    else if (text?.startsWith('connect')) host.eng.sendPacket(1, oob('connectResponse'), p.from);
    else if (!text) host.eng.sendPacket(1, Uint8Array.from([...p.bytes.subarray(0, 4), 0xee, p.from.port & 0xff]), p.from);
  }
}

test('handshake de 2 convidados: cada um no seu ring k, sem tocar no cliente local do host', () => {
  const { host, guests, net } = world();
  const [a, b] = guests;
  const ka = net.attach(a), kb = net.attach(b);
  assert.ok(ka >= 2 && kb >= 2 && ka !== kb);
  const log = [];

  // cliente local do host continua funcionando pelo ring 1 (tag 0) -> resposta no ring 0
  host.eng.sendPacket(0, oob('getchallenge 0 "host"'));
  // convidados: `connect localhost` faz o cliente mandar OOB ao ring 1 da PRÓPRIA instância
  a.eng.sendPacket(0, oob('getchallenge 0 "a"'));
  b.eng.sendPacket(0, oob('getchallenge 0 "b"'));
  net.pump();
  serverFrame(host, log);
  net.pump();

  assert.deepEqual(log.map(x => [x.port, x.oob]).sort(), [[0, 'getchallenge 0 "host"'], [ka, 'getchallenge 0 "a"'], [kb, 'getchallenge 0 "b"']].sort());
  assert.equal(oobText(host.eng.getLoopPacket(0).bytes), 'challengeResponse 123');
  assert.equal(host.eng.getLoopPacket(0), null);
  for (const g of [a, b]) {
    const p = g.eng.getLoopPacket(0);
    assert.equal(oobText(p.bytes), 'challengeResponse 123');
    assert.equal(p.from.type, NA_LOOPBACK);
    assert.equal(g.eng.getLoopPacket(0), null);
  }

  // tráfego sequenciado: qport no byte 4, eco do servidor volta só para quem mandou
  a.eng.sendPacket(0, seqFromClient(1, 0x1234, enc.encode('usercmd-a')));
  b.eng.sendPacket(0, seqFromClient(1, 0x5678, enc.encode('usercmd-b')));
  net.pump(); log.length = 0; serverFrame(host, log); net.pump();
  assert.deepEqual(log.map(x => [x.port, x.qport]).sort(), [[ka, 0x1234], [kb, 0x5678]].sort());
  assert.deepEqual([...a.eng.getLoopPacket(0).bytes.subarray(4)], [0xee, ka & 0xff]);
  assert.deepEqual([...b.eng.getLoopPacket(0).bytes.subarray(4)], [0xee, kb & 0xff]);
  assert.equal(host.eng.getLoopPacket(0), null);
});

test('convidado sem servidor local: o motor dele drenando o ring 1 não atrapalha a ponte', () => {
  const { host, guests, net } = world();
  const [a] = guests;
  net.attach(a);
  const log = [];
  for (let i = 0; i < 40; ++i) {
    a.eng.sendPacket(0, seqFromClient(i, 7, enc.encode(`cmd${i}`)));
    if (i % 3 === 0) while (a.eng.getLoopPacket(1)); // Com_ServerPacketEvent drenando e descartando (sv_running sem estado 1)
    if (i % 4 === 3) { net.pump(); serverFrame(host, log); }
  }
  net.pump(); serverFrame(host, log);
  assert.equal(log.length, 40);
  assert.deepEqual(log.map(x => x.qport), Array(40).fill(7));
});

test('ring k fora do alcance (heap alto) é recusado sem escrever na memória; k explícito e fechamento', () => {
  const mem = makeMemory(), freed = [];
  const high = L.base + 70000 * L.stride; // k > 0xffff
  const bridge = createNetBridge({ buffer: mem, layout: L, malloc: () => high, free: p => freed.push(p) });
  assert.throws(() => bridge.openHostRing(), /fora do alcance/);
  assert.equal(freed.length, 4); // todas as tentativas devolvidas
  assert.throws(() => createNetBridge({ buffer: mem, layout: L }).openHostRing(), /sem malloc/);

  const b2 = createNetBridge({ buffer: mem, layout: L });
  assert.throws(() => b2.openHostRing(1), RangeError); // 0 e 1 são do motor
  assert.equal(b2.openHostRing(5), 5);
  assert.throws(() => b2.openHostRing(5), RangeError);
  assert.equal(b2.closeHostRing(5), true);
  assert.throws(() => b2.injectToServer(new Uint8Array(10), 5), /não aberto/);
});

test('contrapressão: ring cheio enfileira; o pump entrega na ordem quando o motor consome', () => {
  const mem = makeMemory(), eng = new EngineSim(mem, L);
  const bridge = createNetBridge({ buffer: mem, layout: L });
  for (let i = 0; i < 40; ++i) bridge.injectToClient(Uint8Array.of(i, 0, 0, 0));
  let s = bridge.stats();
  assert.equal(s.injectedToClient, 14); // ROOM = 16 - 2
  assert.equal(s.pending, 26);
  const got = [];
  while (got.length < 40) {
    for (let p; (p = eng.getLoopPacket(0));) got.push(p.bytes[0]);
    bridge.pump();
  }
  assert.deepEqual(got, Array.from({ length: 40 }, (_, i) => i));
  s = bridge.stats();
  assert.deepEqual([s.injectedToClient, s.pending, s.dropped], [40, 0, 0]);
  // pacote maior que o slot nunca entra
  assert.equal(bridge.injectToClient(new Uint8Array(1265)), false);
  assert.equal(bridge.stats().oversize, 1);
});

test('auxiliares: OOB, texto e qport', () => {
  assert.equal(isOOB(oob('x')), true);
  assert.equal(isOOB(Uint8Array.of(0xff, 0xff, 0xff)), false);
  assert.equal(oobText(oob('connect "\\protocol\\1044"')), 'connect "\\protocol\\1044"');
  assert.equal(oobText(Uint8Array.of(1, 2, 3, 4)), null);
  assert.equal(clientQport(seqFromClient(9, 0xbeef, [])), 0xbeef);
  assert.equal(clientQport(oob('getchallenge')), null);
  assert.equal(dec.decode(oob('ab').subarray(4)), 'ab');
});
