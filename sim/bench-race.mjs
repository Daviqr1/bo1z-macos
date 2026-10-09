// Bench da corrida de 2 produtores no ring 1 do host com a cadência real da gravação (frames do motor a ~108 fps;
// a ponte injeta no ritmo de frames de "outro jogador", trecho diferente da mesma gravação).
// node sim/bench-race.mjs [segundos=20] [--stress]   (imprime JSON; --stress = sem pausas, para conferir a detecção)
import { runRace } from './race.mjs';
import { loadTraffic } from './traffic.mjs';

const args = process.argv.slice(2);
const seconds = Number(args.find(a => /^\d+(\.\d+)?$/.test(a)) ?? 20);
const stress = args.includes('--stress');
const traffic = await loadTraffic(undefined, { maxFrames: 200000 });
const half = traffic.frameMs.length >> 1;
const opts = stress
  ? { durationMs: seconds * 1000 }
  : { durationMs: seconds * 1000, frameMs: traffic.frameMs.slice(0, half), injectMs: traffic.frameMs.slice(half),
      packetLen: [60, 90, 120, 75], bridgeLen: [60, 140, 90, 110] };
const r = await runRace(opts);
const perPacket = r.injected ? r.detected / r.injected : 0;
console.log(JSON.stringify({ mode: stress ? 'stress' : 'gravação', seconds, recording: traffic.stats, injected: r.injected,
  engineSent: r.engine.sent, detected: r.detected, anomalies: r.anomalies, detectedPerInjected: perPacket,
  engine: r.engine, bridge: r.bridge }, null, 2));
