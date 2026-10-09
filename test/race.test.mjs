// F0/F1: concorrência real (worker_threads) entre a thread do "motor" (sim/engine.mjs) e a ponte (netbridge.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { createNetBridge } from '../app/coop/netbridge.mjs';
import { runRace } from '../sim/race.mjs';
import { DEFAULT_RECORDING, loadTraffic } from '../sim/traffic.mjs';
import { bumpAllocator, checkPacket, makeMemory, makePacket, TEST_LAYOUT } from './helpers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startWorker(workerData) {
  const worker = new Worker(new URL('../sim/single-worker.mjs', import.meta.url), { workerData });
  const done = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  return { worker, done };
}

test('2 produtores no ring 1 (estresse): a corrida acontece e os contadores da ponte a detectam', async () => {
  const r = await runRace({ durationMs: 1200, spin: 50 });
  // Sob estresse (centenas de milhares de pacotes/s) a corrida tem de aparecer, senão o teste não exercita nada.
  assert.ok(r.detected > 0, JSON.stringify(r));
  // Cada evento detectado (CAS refeito, clobber, fantasma) explica no máximo ~3 anomalias (pacote misturado, repetido
  // velho, perdido). Anomalia sem detecção correspondente indicaria um modo de falha que a ponte não vê.
  assert.ok(r.anomalies <= 3 * r.detected, `anomalias ${r.anomalies} > 3 × detectados ${r.detected}`);
  assert.equal(r.bridge.injectFailed, 0);
});

test('2 produtores no ring 1 na cadência da gravação: nenhuma anomalia sem detecção', { skip: !existsSync(DEFAULT_RECORDING) }, async () => {
  const traffic = await loadTraffic(undefined, { maxFrames: 20000 });
  const r = await runRace({ durationMs: 2000, frameMs: traffic.frameMs.slice(0, 10000), injectMs: traffic.frameMs.slice(10000) });
  assert.ok(r.injected > 100 && r.engine.sent > 100, JSON.stringify(r));
  assert.ok(r.anomalies <= 3 * r.detected, JSON.stringify(r));
});

test('produtor único (servidor -> ring k): o leitor passivo nunca entrega pacote misturado, mesmo atrasado', async () => {
  const layout = TEST_LAYOUT, buffer = makeMemory(layout), heap = bumpAllocator(layout);
  const bridge = createNetBridge({ buffer, layout, malloc: heap.malloc, free: heap.free });
  const k = bridge.openHostRing();
  const ctl = new SharedArrayBuffer(16), flags = new Int32Array(ctl);
  const { worker, done } = startWorker({ buffer, layout, ctl, mode: 'produce', port: k, spin: 20 });
  let delivered = 0, corrupt = 0, outOfOrder = 0, last = -1;
  const t0 = performance.now();
  while (performance.now() - t0 < 1000) {
    bridge.drainRing(k, bytes => {
      const c = checkPacket(bytes);
      if (!c.ok) ++corrupt; else { if (c.seq <= last) ++outOfOrder; last = c.seq; ++delivered; }
    });
    if (delivered % 7 === 0) await sleep(0); // atrasa de vez em quando para forçar perdas/slots reescritos
  }
  Atomics.store(flags, 0, 1);
  const produced = await done;
  await worker.terminate();
  const reader = bridge.stats().readers[k];
  assert.ok(delivered > 1000, `entregues ${delivered}`);
  assert.equal(corrupt, 0, JSON.stringify({ delivered, reader, produced }));
  assert.equal(outOfOrder, 0);
});

test('produtor único (ponte -> ring 0 do convidado): fila com contrapressão, sem perda nem mistura', async () => {
  const layout = TEST_LAYOUT, buffer = makeMemory(layout);
  const bridge = createNetBridge({ buffer, layout });
  const ctl = new SharedArrayBuffer(16), flags = new Int32Array(ctl);
  // o cliente do convidado só aceita pacotes com a porta do "localhost" resolvido (layout.clientServerPort)
  const { worker, done } = startWorker({ buffer, layout, ctl, mode: 'consume', port: layout.clientServerPort });
  const total = 60000;
  for (let i = 0; i < total; ++i) {
    bridge.injectToClient(makePacket(3, i, 40 + (i * 37) % 1224));
    if (i % 64 === 0) while (bridge.pump() > 256) await sleep(0); // quem chama respeita a fila (QUEUE_MAX = 512)
  }
  while (bridge.pump()) await sleep(1);
  const ring0 = bridge.io.addr(0);
  while (bridge.io.loadGet(ring0) !== bridge.io.loadSend(ring0)) await sleep(1);
  Atomics.store(flags, 0, 1);
  const got = await done;
  await worker.terminate();
  const stats = bridge.stats();
  assert.equal(stats.dropped, 0);
  assert.deepEqual({ received: got.received, corrupt: got.corrupt, outOfOrder: got.outOfOrder, inconsistentLen: got.inconsistentLen, wrongPort: got.wrongPort },
    { received: total, corrupt: 0, outOfOrder: 0, inconsistentLen: 0, wrongPort: 0 });
});
