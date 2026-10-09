// F1+transporte: caminho completo sem Electron. Motor do convidado (ring 1) -> page.mjs -> MessagePort -> UDP
// (CoopGuest -> CoopHost em 127.0.0.1) -> MessagePort -> page.mjs do host -> ring 1 do host com tag k -> "servidor"
// -> ring k -> volta pelo mesmo caminho até o ring 0 do convidado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startCoop } from '../app/coop/page.mjs';
import { oobText } from '../app/coop/netbridge.mjs';
import { EngineSim } from '../sim/engine.mjs';
import { bumpAllocator, makeMemory, TEST_LAYOUT } from './helpers.mjs';

const { CoopHost, CoopGuest, bindPage, splitAddress, roomCode } = createRequire(import.meta.url)('../app/coop/udp.js');
const L = TEST_LAYOUT;
const enc = new TextEncoder();
const oob = text => Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...enc.encode(text)]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(5); } return true; };

function instance(role, layout = L) {
  const mem = makeMemory(layout), heap = bumpAllocator(layout);
  const kb = { memory: { buffer: mem }, malloc: heap.malloc, free: heap.free };
  const { port1, port2 } = new MessageChannel();
  const lines = [];
  const coop = startCoop({ role, port: port2, layout, kb, log: l => lines.push(l), statsEveryMs: 0 });
  return { eng: new EngineSim(mem, layout), coop, port1, port2, lines };
}

test('sala UDP local: handshake e tráfego sequenciado de ponta a ponta', async t => {
  const host = instance('host'), guest = instance('guest');
  const udpHost = new CoopHost({ port: 0, bind: '127.0.0.1', code: 'TESTE' });
  const port = await udpHost.start();
  const udpGuest = new CoopGuest({ host: `127.0.0.1:${port}`, code: 'TESTE', name: 'irmao' });
  const unbinds = [
    bindPage(udpHost, 'host', host.port1, h => host.port1.on('message', h), () => {}, 0),
    bindPage(udpGuest, 'guest', guest.port1, h => guest.port1.on('message', h), () => {}, 0),
  ];
  udpGuest.start();
  t.after(() => { unbinds.forEach(u => u()); udpGuest.close(); udpHost.close(); host.coop.stop(); guest.coop.stop(); host.port1.close(); guest.port1.close(); });

  assert.ok(await until(() => udpGuest.welcomed && host.coop.stats().peers && Object.keys(host.coop.stats().peers).length === 1), 'convidado não entrou');
  const k = Object.values(host.coop.stats().peers)[0];
  assert.ok(k >= 2 && k <= 0xffff);

  // "servidor" do host: responde OOB e ecoa sequenciados para a porta (ring) de quem mandou
  const seen = [];
  const server = setInterval(() => {
    for (let p; (p = host.eng.getLoopPacket(1));) {
      const text = oobText(p.bytes);
      seen.push([p.from.port, text]);
      if (text?.startsWith('getchallenge')) host.eng.sendPacket(1, oob('challengeResponse 42'), p.from);
      else if (!text) host.eng.sendPacket(1, Uint8Array.from([...p.bytes.subarray(0, 4), 0xee]), p.from);
    }
  }, 2);
  t.after(() => clearInterval(server));

  // cliente do convidado (connect localhost): manda ao ring 1 da própria instância, como o motor faz
  guest.eng.sendPacket(0, oob('getchallenge 0 "irmao"'));
  let reply = null;
  assert.ok(await until(() => (reply = guest.eng.getLoopPacket(0))), 'resposta não chegou ao ring 0 do convidado');
  assert.equal(oobText(reply.bytes), 'challengeResponse 42');
  assert.deepEqual(seen[0], [k, 'getchallenge 0 "irmao"']);

  // 200 pacotes sequenciados (seq u32, qport u16, payload) e os ecos de volta
  const echoes = [];
  for (let i = 0; i < 200; ++i) {
    const b = new Uint8Array(80); new DataView(b.buffer).setUint32(0, i, true); b[4] = 0x34; b[5] = 0x12;
    guest.eng.sendPacket(0, b);
    if (i % 10 === 9) await sleep(2);
    for (let p; (p = guest.eng.getLoopPacket(0));) echoes.push(new DataView(p.bytes.buffer).getUint32(0, true));
  }
  await until(() => { for (let p; (p = guest.eng.getLoopPacket(0));) echoes.push(new DataView(p.bytes.buffer).getUint32(0, true)); return echoes.length >= 195; });
  // UDP em localhost não perde na prática; a ponte não pode inventar nem duplicar
  assert.ok(echoes.length >= 195, `ecos ${echoes.length}`);
  assert.equal(new Set(echoes).size, echoes.length);
  assert.ok(seen.slice(1).every(([portSeen]) => portSeen === k));
  const hb = host.coop.stats().bridge, gb = guest.coop.stats().bridge;
  assert.deepEqual([hb.clobbered, hb.phantom, hb.dropped, gb.dropped, gb.readers.client.lost], [0, 0, 0, 0, 0]);
  assert.ok(host.lines.some(l => l.includes('oob in #1 getchallenge')), host.lines.join('\n'));
});

test('sala UDP: código errado é recusado; sala cheia; utilidades', async t => {
  const udpHost = new CoopHost({ port: 0, bind: '127.0.0.1', code: 'CERTO', maxGuests: 1 });
  const port = await udpHost.start();
  const bad = new CoopGuest({ host: `127.0.0.1:${port}`, code: 'ERRADO' });
  const ok = new CoopGuest({ host: `127.0.0.1:${port}`, code: 'CERTO' });
  const extra = new CoopGuest({ host: `127.0.0.1:${port}`, code: 'CERTO' });
  const reasons = { bad: null, extra: null };
  bad.on('reject', r => { reasons.bad = r; });
  extra.on('reject', r => { reasons.extra = r; });
  t.after(() => { bad.close(); ok.close(); extra.close(); udpHost.close(); });
  bad.start(); ok.start();
  assert.ok(await until(() => reasons.bad && ok.welcomed));
  extra.start();
  assert.ok(await until(() => reasons.extra));
  assert.equal(reasons.bad, 'código da sala errado');
  assert.equal(reasons.extra, 'sala cheia');
  assert.equal(bad.send(new Uint8Array(4)), false); // sem WELCOME não manda nada
  assert.equal(udpHost.stats().peers.length, 1);

  // 5 códigos errados em 1 min: o IP fica ignorado (nem REJECT recebe mais)
  udpHost.strikes.clear();
  for (let i = 0; i < 5; ++i) udpHost.strike('10.9.9.9');
  udpHost.onMessage(Buffer.from([0x42, 0x31, 1, 1, 0]), { address: '10.9.9.9', port: 1 });
  assert.equal(udpHost.stats().banned, 1);

  assert.deepEqual(splitAddress('100.64.1.2:27961'), { address: '100.64.1.2', port: 27961 });
  assert.deepEqual(splitAddress('100.64.1.2'), { address: '100.64.1.2', port: 27960 });
  assert.deepEqual(splitAddress('[fd7a::1]:5'), { address: 'fd7a::1', port: 5 });
  assert.match(roomCode(), /^[A-HJ-KM-NP-Z2-9]{5}$/);
});
