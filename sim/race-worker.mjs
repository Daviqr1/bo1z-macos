// Worker do F0: faz o papel da thread do motor no host. A cada "frame": o cliente local manda 1 pacote (ring 1, tag 0)
// e o servidor drena o ring 1 inteiro (NET_GetLoopPacket), conferindo cada pacote. Roda até `stop` virar 1.
// workerData: { buffer, layout, ctl (SharedArrayBuffer Int32[4]: stop, frames, …), spin, frameMs[], packetLen[] }
import { parentPort, workerData } from 'node:worker_threads';
import { EngineSim } from './engine.mjs';
import { checkPacket, makePacket } from '../test/helpers.mjs';

const { buffer, layout, ctl, spin = 0, frameMs = [], packetLen = [80], engineProducer = 1, bridgeProducer = 2 } = workerData;
const eng = new EngineSim(buffer, layout);
eng.spin = spin;
const flags = new Int32Array(ctl);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const result = { sent: 0, frames: 0, fromEngine: 0, fromBridge: 0, corrupt: 0, stale: 0, foreignPort: 0, inconsistentLen: 0 };
const seenEngine = new Set(), seenBridge = new Set();

function drainServer() {
  for (let p; (p = eng.getLoopPacket(1));) {
    if (p.cursize !== p.bytes.length) ++result.inconsistentLen;
    const c = checkPacket(p.bytes);
    if (!c.ok) { ++result.corrupt; continue; }
    const seen = c.producer === engineProducer ? seenEngine : c.producer === bridgeProducer ? seenBridge : null;
    if (!seen) { ++result.corrupt; continue; }
    if (seen.has(c.seq)) { ++result.stale; continue; }
    seen.add(c.seq);
    // porta certa? pacote do motor tem tag 0; da ponte, o k do convidado
    if ((c.producer === engineProducer) !== (p.from.port === 0)) ++result.foreignPort;
  }
}

let frame = 0;
while (!Atomics.load(flags, 0)) {
  const len = packetLen[frame % packetLen.length];
  eng.sendPacket(0, makePacket(engineProducer, result.sent++, len));
  drainServer();
  ++frame;
  Atomics.store(flags, 1, frame);
  const ms = frameMs.length ? frameMs[frame % frameMs.length] : 0;
  if (ms > 0) Atomics.wait(sleeper, 0, 0, ms);
}
drainServer(); // o que a ponte publicou depois do último frame
result.frames = frame;
result.fromEngine = seenEngine.size;
result.fromBridge = seenBridge.size;
result.bridgeSeqs = [...seenBridge];
parentPort.postMessage(result);
