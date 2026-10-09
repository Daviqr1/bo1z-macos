// Reinjeta o input gravado (registros `i` do grampo I1) numa instância do app, no mesmo ritmo, para repetir trajeto e
// ritmo de jogo sem ninguém no teclado (A/B de desempenho; no teste de co-op, mover o convidado enquanto você olha o host).
// node tools/replay.mjs [porta=9334] [gravação=recordings/live-20261009.jsonl.gz] [--from s] [--duration s] [--speed 1]
// Não é determinístico (a IA dos zumbis sorteia). Liga __bo1zReplaying para o grampo não regravar o próprio replay.
// Pula os tipos >= 5 (internos do site). O cursor de menu (4) e o pointer lock (3) vão junto.
import { connectPage, sleep } from './cdp.mjs';
import { loadTraffic } from '../sim/traffic.mjs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); if (i < 0) return dflt; const v = Number(argv[i + 1]); argv.splice(i, 2); return v; };
const from = flag('--from', 0), duration = flag('--duration', Infinity), speed = flag('--speed', 1);
const port = /^\d+$/.test(argv[0] ?? '') ? Number(argv.shift()) : 9334;
const recording = argv[0];

const { inputs } = await loadTraffic(recording);
if (!inputs.length) { console.error('gravação sem registros de input (k=i)'); process.exit(1); }
const t0 = inputs[0].t + from * 1000;
const events = inputs.filter(e => e.kind < 5 && e.t >= t0 && e.t < t0 + duration * 1000);
console.log(`[${port}] ${events.length} eventos, ${((events.at(-1).t - events[0].t) / 1000).toFixed(1)} s de jogo, velocidade ${speed}x`);

const page = await connectPage(port);
await page.evaluate(`(() => { globalThis.__bo1zReplaying = true; globalThis.__bo1zReplayQueue = []; return true; })()`);
// Manda em lotes de ~1 s; a página agenda cada evento com setTimeout relativo ao começo do lote.
const start = performance.now();
for (let i = 0; i < events.length;) {
  const batchStart = events[i].t, batch = [];
  while (i < events.length && events[i].t - batchStart < 1000) { const e = events[i++]; batch.push([(e.t - batchStart) / speed, e.kind, e.a, e.b]); }
  const due = (batchStart - events[0].t) / speed;
  const ahead = due - (performance.now() - start);
  if (ahead > 200) await sleep(ahead - 200);
  const sent = await page.evaluate(`(batch => {
    const input = globalThis.__bo1zKBInput ?? globalThis.__bo1zKB?.module?._KB_Input;
    if (!input) return -1;
    for (const [ms, kind, a, b] of batch) setTimeout(() => input(kind, a, b), Math.max(0, ms + ${Math.max(0, ahead > 200 ? 200 : ahead)}));
    return batch.length;
  })(${JSON.stringify(batch)})`);
  if (sent < 0) { console.error('sem KB_Input na página (glue sem I1/N1)'); break; }
  process.stdout.write(`\r[${port}] ${i}/${events.length} eventos`);
}
await sleep(1500);
await page.evaluate(`(() => { globalThis.__bo1zReplaying = false; return true; })()`);
console.log(`\n[${port}] fim do replay`);
page.close();
