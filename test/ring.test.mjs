// F0: layout e protocolo dos rings, contra a emulação fiel do motor (sim/engine.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLayout, DEFAULT_LAYOUT, ringAddr } from '../app/coop/layout.mjs';
import { RingIO } from '../app/coop/ring.mjs';
import { EngineSim, NA_IP, NA_LOOPBACK, NA_BOT, NA_BROADCAST } from '../sim/engine.mjs';
import { checkPacket, makeMemory, makePacket, TEST_LAYOUT } from './helpers.mjs';

const L = TEST_LAYOUT;
const setup = () => { const buf = makeMemory(); return { buf, eng: new EngineSim(buf, L), io: new RingIO(buf, L) }; };

test('layout do motor analisado é coerente (§1.2)', () => {
  checkLayout(DEFAULT_LAYOUT);
  assert.equal(DEFAULT_LAYOUT.base, 0x817E4C0);
  assert.equal(DEFAULT_LAYOUT.stride, 16 * 1272 + 8);
  // loopbacks[2] cairia no ponteiro do dvar showpackets: o array real tem 2 rings
  assert.equal(ringAddr(DEFAULT_LAYOUT, 2), 135824336);
  // o maior k endereçável (0xffff) ainda cabe na memória de 2 GiB
  assert.ok(ringAddr(DEFAULT_LAYOUT, 0xffff) + DEFAULT_LAYOUT.stride <= DEFAULT_LAYOUT.memoryBytes);
  assert.throws(() => checkLayout({ ...DEFAULT_LAYOUT, slots: 8 }));
  assert.throws(() => checkLayout({ ...DEFAULT_LAYOUT, tagOff: 1260 }));
});

test('roteamento do motor: cliente -> ring 1 (tag 0); servidor -> ring port&0xffff; não-loopback descartado', () => {
  const { eng } = setup();
  assert.ok(eng.sendPacket(0, makePacket(1, 1, 50)));
  let p = eng.getLoopPacket(1);
  assert.equal(p.from.port, 0);
  assert.equal(p.from.type, NA_LOOPBACK);
  assert.equal(checkPacket(p.bytes).seq, 1);
  assert.equal(eng.getLoopPacket(1), null);

  assert.ok(eng.sendPacket(1, makePacket(2, 7, 60), { type: NA_LOOPBACK, port: 0 }));
  assert.equal(checkPacket(eng.getLoopPacket(0).bytes).seq, 7);
  // porta 0x10005 & 0xffff = 5: o servidor escreve no ring 5
  assert.ok(eng.sendPacket(1, makePacket(2, 8, 60), { type: NA_LOOPBACK, port: 0x10005 }));
  const io = new RingIO(eng.u8.buffer, L);
  assert.equal(io.loadSend(io.addr(5)), 1);

  for (const type of [NA_BOT, 1, NA_BROADCAST, NA_IP]) assert.equal(eng.sendPacket(1, makePacket(2, 9, 10), { type, port: 0 }), false);
});

test('wrap-around: 100 pacotes passando pelos 16 slots, em ordem, sem perda', () => {
  const { eng } = setup();
  const seen = [];
  const drain = () => { for (let p; (p = eng.getLoopPacket(1));) { assert.ok(checkPacket(p.bytes).ok); seen.push(checkPacket(p.bytes).seq); } };
  for (let i = 0; i < 100; ++i) {
    eng.sendPacket(0, makePacket(1, i, 20 + i));
    if (i % 3 === 2) drain();
  }
  drain();
  assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => i));
});

test('overrun: com send-get >= 17 o consumidor pula para send-16; com 16 pendentes lê todos', () => {
  for (const [pending, expectFirst] of [[16, 0], [17, 1], [40, 24]]) {
    const { eng } = setup();
    for (let i = 0; i < pending; ++i) eng.sendPacket(0, makePacket(1, i, 30));
    const seen = [];
    for (let p; (p = eng.getLoopPacket(1));) { assert.ok(checkPacket(p.bytes).ok); seen.push(checkPacket(p.bytes).seq); }
    assert.equal(seen.length, 16, `pendentes=${pending}`);
    assert.equal(seen[0], expectFirst);
    assert.equal(seen.at(-1), pending - 1);
  }
});

test('pacote de 1264 B (máximo) passa; 1265 B é recusado pela ponte', () => {
  const { eng, io } = setup();
  const ring1 = io.addr(1);
  const big = makePacket(9, 1, 1264);
  assert.ok(io.publish(ring1, big, 3).ok);
  const p = eng.getLoopPacket(1);
  assert.equal(p.bytes.length, 1264);
  assert.equal(p.cursize, 1264);
  assert.equal(p.from.port, 3);
  assert.ok(checkPacket(p.bytes).ok);
  assert.throws(() => io.publish(ring1, new Uint8Array(1265), 3), RangeError);
});

test('publish da ponte: tag vira from.port no consumidor do motor; contadores u32', () => {
  const { eng, io } = setup();
  const ring1 = io.addr(1);
  for (let i = 0; i < 40; ++i) {
    const r = io.publish(ring1, makePacket(5, i, 100), 0xfffe);
    assert.deepEqual([r.ok, r.seq, r.retries], [true, i, 0]);
    const p = eng.getLoopPacket(1);
    assert.equal(p.from.port, 0xfffe);
    assert.equal(checkPacket(p.bytes).seq, i);
  }
});

test('leitor passivo: não mexe no get do motor e vê os mesmos pacotes que o consumidor do motor', () => {
  const { eng, io } = setup();
  const ring1 = io.addr(1), reader = io.reader(ring1);
  const viaReader = [], viaEngine = [];
  for (let i = 0; i < 50; ++i) {
    eng.sendPacket(0, makePacket(1, i, 40));
    if (i % 2) reader.drain(b => viaReader.push(checkPacket(b).seq));
    if (i % 5 === 0) for (let p; (p = eng.getLoopPacket(1));) viaEngine.push(checkPacket(p.bytes).seq);
  }
  reader.drain(b => viaReader.push(checkPacket(b).seq));
  for (let p; (p = eng.getLoopPacket(1));) viaEngine.push(checkPacket(p.bytes).seq);
  const all = Array.from({ length: 50 }, (_, i) => i);
  assert.deepEqual(viaReader, all);
  assert.deepEqual(viaEngine, all);
  assert.deepEqual([reader.lost, reader.torn, reader.bad], [0, 0, 0]);
});

test('leitor passivo atrasado: conta perdidos e descarta o slot que pode estar sendo reescrito', () => {
  const { eng, io } = setup();
  const reader = io.reader(io.addr(1));
  for (let i = 0; i < 30; ++i) eng.sendPacket(0, makePacket(1, i, 40));
  const seen = [];
  reader.drain(b => seen.push(checkPacket(b).seq));
  // 30 publicados, 16 ainda no ring (14..29); o 14 é descartado (o produtor do 30 escreveria nele)
  assert.equal(reader.lost, 14);
  assert.equal(reader.torn, 1);
  assert.deepEqual(seen, Array.from({ length: 15 }, (_, i) => 15 + i));
});

test('leitor passivo: len corrompido (> maxLen) é descartado, não copiado', () => {
  const { eng, io } = setup();
  const ring1 = io.addr(1), reader = io.reader(ring1);
  eng.sendPacket(0, makePacket(1, 1, 40));
  io.i32[(io.slotAddr(ring1, 0) + L.lenOff) >> 2] = 5000;
  eng.sendPacket(0, makePacket(1, 2, 40));
  const seen = [];
  reader.drain(b => seen.push(checkPacket(b).seq));
  assert.deepEqual(seen, [2]);
  assert.equal(reader.bad, 1);
});

test('contadores perto de 2^32: leitor e publish continuam certos na virada', () => {
  const { io } = setup();
  const ring = io.addr(1), start = 0xfffffff8;
  io.i32[(ring + L.sendOff) >> 2] = start | 0;
  io.i32[(ring + L.getOff) >> 2] = start | 0;
  const reader = io.reader(ring);
  const seen = [];
  for (let i = 0; i < 20; ++i) {
    const r = io.publish(ring, makePacket(1, i, 30), 0);
    assert.equal(r.seq, (start + i) >>> 0);
    reader.drain(b => seen.push(checkPacket(b).seq));
  }
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(io.loadSend(ring), (start + 20) >>> 0);
});
