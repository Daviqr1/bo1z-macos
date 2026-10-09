// Gravador passivo + tuner do BO1 Zombies.app (DevTools em 127.0.0.1:9334). Nunca envia input nem recarrega.
// node recorder.mjs <saida.jsonl> [horas]
// Grava: {k:'f'} intervals de present (ms) por segundo, {k:'g'} GPU %, {k:'m'} memória do motor a cada 10 s,
// {k:'i'} input do jogador ([t, tipo, a, b]... via _KB_Input), {k:'w'} linhas WEB_GPU/KISAK do console do site (lidas de five.console, sem assinar o console), {k:'s'} tela/mapa.
// Tuner: a cada página nova, antes do jogador escolher o mapa, soma os comandos de live-commands.json
// ({"*": [...], "<zone>": [...]}) aos de __kisakParity. Vale no próximo mapa que subir; nada muda na partida em curso.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
const [out, hours = '3'] = process.argv.slice(2);
const LIVE = new URL('../live-commands.json', import.meta.url).pathname;
const end = Date.now() + Number(hours) * 3600e3;
const write = o => appendFileSync(out, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gpu = () => new Promise(r => execFile('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], (e, so) =>
  r(Number((so ?? '').match(/"Device Utilization %"=(\d+)/)?.[1] ?? NaN))));
const liveCommands = () => { try { return JSON.parse(readFileSync(LIVE, 'utf8')); } catch { return {}; } };

const TUNE = extra => `(() => {
  if (globalThis.__bo1zTuned) return 'already';
  const prev = Object.getOwnPropertyDescriptor(globalThis, '__kisakParity'), extra = ${JSON.stringify(extra)};
  const map = () => document.documentElement?.dataset.map ?? new URLSearchParams(location.search).get('map');
  Object.defineProperty(globalThis, '__kisakParity', { configurable: true, get() {
    const base = (prev?.get ? prev.get() : prev?.value) ?? {};
    return { ...base, commands: [...(base.commands ?? []), ...(extra['*'] ?? []), ...(extra[map()] ?? [])] };
  } });
  globalThis.__bo1zTuned = true; return 'tuned';
})()`;

async function session() {
  const page = (await (await fetch('http://127.0.0.1:9334/json')).json()).find(t => t.type === 'page' && t.url.includes('vel.gg'));
  if (!page) return;
  const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map(); let closed = false;
  ws.onclose = () => { closed = true; };
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  let tick = 0, lastScreen = null, consoleSeen = 0;
  while (!closed && Date.now() < end) {
    const r = await evaluate(`(() => { const s = globalThis.five, e = s?.engine;
      let i = [], lost = 0;
      if (e) { if (globalThis.__recEngine !== e) { globalThis.__recEngine = e; globalThis.__recReader = e.presentReader(); }
        const f = __recReader(); if (f) { i = Array.from(f.intervals, x => Math.round(x * 10) / 10); lost = f.lost; } }
      const c = s?.console ?? [], total = c.length + (s?.consoleDiscarded ?? 0);
      return JSON.stringify({ i, lost, screen: document.body?.dataset.screen ?? null, map: document.documentElement.dataset.map ?? null,
        tuned: !!globalThis.__bo1zTuned, total, input: globalThis.__bo1zInputTap ? globalThis.__bo1zInputTap.splice(0) : [], c: c.slice(Math.max(0, c.length - (total - ${'${consoleSeen}'}))).filter(x => /WEB_GPU|KISAK_BROWSER (engine|map|ready|view)|Sys_Error|out of memory/i.test(x.message)).map(x => x.message.slice(0, 3000)) }); })()`
      .replace('${consoleSeen}', String(consoleSeen)));
    if (r) {
      const o = JSON.parse(r);
      if (o.i.length) write({ k: 'f', i: o.i, lost: o.lost });
      for (const text of o.c) write({ k: 'w', text });
      if (o.input.length) write({ k: 'i', ev: o.input }); // [t(ms page), tipo, a, b, ...] de _KB_Input (glue patcheado I1)
      consoleSeen = o.total;
      if (o.screen !== lastScreen) { write({ k: 's', screen: o.screen, map: o.map }); lastScreen = o.screen; }
      if (!o.tuned && (o.screen === 'landing' || o.screen === null || o.screen === 'download')) {
        const extra = liveCommands();
        if (Object.keys(extra).length) write({ k: 'tune', result: await evaluate(TUNE(extra)), extra });
      }
    }
    write({ k: 'g', gpu: await gpu() });
    if (++tick % 10 === 0) {
      const m = await evaluate(`JSON.stringify(globalThis.five?.engine?.telemetryMemory?.() ?? null)`);
      if (m && m !== 'null') write({ k: 'm', ...JSON.parse(m) });
    }
    await sleep(1000);
  }
  ws.close();
}
while (Date.now() < end) {
  try { await session(); } catch (error) { write({ k: 'err', error: String(error.message ?? error) }); }
  await sleep(3000);
}
