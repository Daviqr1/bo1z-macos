// F0: corrida de 2 produtores no ring 1 do host (cliente local do motor + ponte JS), com a ponte real (netbridge.mjs)
// na thread principal e o motor emulado num worker. Usado pelo teste (modo estresse) e pelo bench (cadência gravada).
import { Worker } from 'node:worker_threads';
import { createNetBridge } from '../app/coop/netbridge.mjs';
import { bumpAllocator, makeMemory, makePacket, TEST_LAYOUT } from '../test/helpers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// opts: { durationMs, spin, frameMs: [] (cadência do motor; vazio = sem pausa), injectMs: [] (intervalos entre injeções
//         da ponte; vazio = o mais rápido possível), packetLen: [], bridgeLen: [] }
export async function runRace(opts = {}) {
  const { durationMs = 1500, spin = 0, frameMs = [], injectMs = [], packetLen = [80], bridgeLen = [120] } = opts;
  const layout = TEST_LAYOUT, buffer = makeMemory(layout);
  const ctl = new SharedArrayBuffer(16), flags = new Int32Array(ctl);
  const heap = bumpAllocator(layout);
  const bridge = createNetBridge({ buffer, layout, malloc: heap.malloc, free: heap.free });
  const k = bridge.openHostRing();
  const worker = new Worker(new URL('./race-worker.mjs', import.meta.url), { workerData: { buffer, layout, ctl, spin, frameMs, packetLen } });
  const done = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  const ring1 = bridge.io.addr(1);
  let injected = 0, skippedFull = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < durationMs) {
    // Não deixa o ring encher (overrun é outra perda, não a corrida que queremos medir).
    if (((bridge.io.loadSend(ring1) - bridge.io.loadGet(ring1)) >>> 0) < 8) {
      bridge.injectToServer(makePacket(2, injected, bridgeLen[injected % bridgeLen.length]), k);
      ++injected;
    } else ++skippedFull;
    bridge.pump();
    if (injectMs.length) await sleep(injectMs[injected % injectMs.length]);
    else if (injected % 256 === 0) await sleep(0);
  }
  Atomics.store(flags, 0, 1);
  const engine = await done;
  await worker.terminate();
  const stats = bridge.stats();
  const missingBridge = injected - engine.fromBridge;
  const missingEngine = engine.sent - engine.fromEngine;
  const detected = stats.casRetries + stats.clobbered + stats.phantom;
  const anomalies = engine.corrupt + engine.stale + engine.foreignPort + Math.max(0, missingBridge) + Math.max(0, missingEngine);
  delete engine.bridgeSeqs;
  return { k, injected, skippedFull, engine, bridge: stats, missingBridge, missingEngine, detected, anomalies };
}
