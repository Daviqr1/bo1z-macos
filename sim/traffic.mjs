// Modelo de tráfego a partir da gravação real (recordings/*.jsonl.gz): cadência de frames do motor (registros `f`,
// intervalos de present em ms) e ritmo de input (registros `i`). O motor manda no máximo 1 pacote de usercmd por frame
// do cliente, então a cadência de frames é a cadência de produtor do cliente local no ring 1 do host.
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

export const DEFAULT_RECORDING = new URL('../recordings/live-20261009.jsonl.gz', import.meta.url).pathname;

export async function* readRecording(path = DEFAULT_RECORDING) {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}

// { frameMs: number[], inputs: { t, kind, a, b }[], playingMs, stats }
// O relógio dos inputs é o performance.now() da página: zera a cada navegação. `inputs` é o trecho contínuo mais longo.
export async function loadTraffic(path = DEFAULT_RECORDING, { maxFrames = Infinity } = {}) {
  const frameMs = [], segments = [[]];
  let screen = null;
  for await (const r of readRecording(path)) {
    if (r.k === 's') screen = r.screen;
    else if (r.k === 'f' && screen === 'playing') {
      for (const ms of r.i) if (ms > 0 && ms < 1000 && frameMs.length < maxFrames) frameMs.push(ms);
    } else if (r.k === 'i') {
      for (let j = 0; j + 3 < r.ev.length; j += 4) {
        const e = { t: r.ev[j], kind: r.ev[j + 1], a: r.ev[j + 2], b: r.ev[j + 3] }, seg = segments.at(-1);
        if (seg.length && e.t < seg.at(-1).t) segments.push([e]); else seg.push(e);
      }
    }
  }
  const inputs = segments.reduce((a, b) => (b.length > a.length ? b : a));
  const sorted = Float64Array.from(frameMs).sort();
  const q = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
  const total = frameMs.reduce((a, b) => a + b, 0);
  const inputSpan = inputs.length ? inputs.at(-1).t - inputs[0].t : 0;
  return {
    frameMs, inputs, inputSegments: segments.length,
    stats: { frames: frameMs.length, playingSeconds: +(total / 1000).toFixed(1), fps: +(frameMs.length / (total / 1000)).toFixed(1),
      p50: q(0.5), p95: q(0.95), p99: q(0.99), inputs: inputs.length, inputSeconds: +(inputSpan / 1000).toFixed(1),
      inputsPerSecond: inputSpan ? +(inputs.length / (inputSpan / 1000)).toFixed(1) : 0 },
  };
}
