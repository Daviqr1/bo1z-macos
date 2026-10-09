// Worker do F0 para os caminhos de produtor único (sem corrida esperada):
//  mode 'produce': o servidor do motor manda pacotes para o ring do convidado (sendPacket(1, …, port k)) sem parar;
//                  a ponte lê na thread principal com o leitor passivo.
//  mode 'consume': o cliente do motor drena o ring 0 (NET_GetLoopPacket(0)); a ponte injeta (injectToClient).
// workerData: { buffer, layout, ctl, mode, port, spin, paceEvery }
import { parentPort, workerData } from 'node:worker_threads';
import { EngineSim, NA_LOOPBACK } from './engine.mjs';
import { checkPacket, makePacket } from '../test/helpers.mjs';

const { buffer, layout, ctl, mode, port = 0, spin = 0, paceEvery = 0 } = workerData;
const eng = new EngineSim(buffer, layout);
eng.spin = spin;
const flags = new Int32Array(ctl);
const out = { sent: 0, received: 0, corrupt: 0, outOfOrder: 0, wrongPort: 0, inconsistentLen: 0 };
let last = -1;

const consume = () => {
  for (let p; (p = eng.getLoopPacket(0));) {
    if (p.cursize !== p.bytes.length) ++out.inconsistentLen;
    const c = checkPacket(p.bytes);
    if (!c.ok) { ++out.corrupt; continue; }
    if (c.seq <= last) ++out.outOfOrder;
    last = c.seq;
    if (p.from.port !== port) ++out.wrongPort;
    ++out.received;
  }
};

while (!Atomics.load(flags, 0)) {
  if (mode === 'produce') {
    eng.sendPacket(1, makePacket(3, out.sent, 40 + (out.sent * 37) % 1224), { type: NA_LOOPBACK, port });
    ++out.sent;
    if (paceEvery && out.sent % paceEvery === 0) Atomics.wait(flags, 3, 0, 0.05);
  } else consume();
}
if (mode === 'consume') consume();
parentPort.postMessage(out);
