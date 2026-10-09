// Smoke da extensão do navegador com o motor DE VERDADE: monta a extensão (scripts/build-extension.sh), abre o
// Chromium com ela (perfil persistente: o 1º carregamento do mapa baixa os packs do vel.gg, ~700 MB no Nacht) e prova,
// numa aba de mapa marcada como host e depois como convidado (estado de sala injetado no offscreen, sem rede):
//  - host: 'bo1z:kb' com memória (SharedArrayBuffer de 2 GiB) e malloc válidos, scanWasm com layout ok, ponte no Worker,
//    argumentos com sv_timeout; latência página -> offscreen -> página (p50/p99) com o motor rodando;
//  - convidado: sha256 do wasm conferido + G1, '+connect localhost:3074' depois de '+devmap <mapa>', noquit, e o
//    cliente do motor tentando o host pela ponte (getchallenge saindo pelo offscreen).
//
//   node tools/ext-smoke.mjs [--profile <pasta>] [--map nacht] [--port 9471] [--xvfb] [--out <pasta>] [--only host|guest]
//        [--keep]   (deixa o Chromium aberto no fim)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attach, clickPlay, launchChrome, navigate, probe, sleep, waitEval, waitTarget, waitUrl } from './ext-cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
const flag = name => argv.includes(name);
const root = new URL('..', import.meta.url).pathname;
const scratch = process.env.BO1Z_SCRATCH ?? path.join(os.tmpdir(), 'bo1z-ext');
const out = opt('--out', path.join(scratch, `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const profile = opt('--profile', path.join(scratch, 'ext-profile'));
const slug = opt('--map', 'nacht'), port = Number(opt('--port', 9471)), only = opt('--only', null);
mkdirSync(out, { recursive: true });

const t0 = Date.now();
const report = { started: new Date().toISOString(), slug, steps: [], host: null, guest: null, rtt: [], ok: false };
const step = (name, data) => {
  const e = { s: +((Date.now() - t0) / 1000).toFixed(1), name, ...(data === undefined ? {} : { data }) };
  report.steps.push(e);
  console.log(`[${String(e.s).padStart(6)} s] ${name}${data === undefined ? '' : ' ' + JSON.stringify(data).slice(0, 400)}`);
};
const save = () => writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const consoleLines = [];
const keepConsole = who => line => { if (/BO1Z_|KISAK_BROWSER (map-loaded|engine-initialized)|Com_ERROR|connect|challenge/i.test(line)) consoleLines.push(`${who} ${line.slice(0, 300)}`); };

// Referência com o motor no mesmo estado: ida e volta num MessageChannel dentro da própria página (duas tarefas na
// mesma thread) — mostra quanto da latência medida é a thread da página ocupada, e não o caminho da extensão.
const BASELINE = `(async () => {
  const pct = t => { t.sort((a, b) => a - b); const q = p => +t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(3); return { p50: q(.5), p99: q(.99), max: q(1) }; };
  const { port1, port2 } = new MessageChannel(), local = [];
  port2.onmessage = e => port2.postMessage(e.data);
  for (let i = 0; i < 400; ++i) { const t0 = performance.now(); await new Promise(r => { port1.onmessage = r; port1.postMessage(new Uint8Array(300)); }); local.push(performance.now() - t0); }
  port1.close(); port2.close();
  return { localChannel: pct(local) };
})()`;

let chrome = null;
try {
  const ext = path.join(out, 'ext');
  execFileSync(path.join(root, 'scripts/build-extension.sh'), [ext], { cwd: root, stdio: 'inherit',
    env: { ...process.env, BO1Z_EXT_ZIP: path.join(out, 'ext.zip') } });
  chrome = await launchChrome({ extension: ext, profile, port, xvfb: flag('--xvfb'), log: m => step(m) });
  const page = await attach(await waitTarget(port, t => t.type === 'page'), { onConsole: keepConsole('página') });
  await navigate(page, 'https://vel.gg/bo1z');
  const offTarget = await waitTarget(port, t => t.url.endsWith('/offscreen.html'), 30000);
  const off = await attach(offTarget, { onConsole: keepConsole('offscreen') });
  await off.evaluate(`new Promise(r => { const f = () => globalThis.__bo1zExtSession ? r(1) : setTimeout(f, 50); f(); })`, 20000);
  step('offscreen no ar', { url: offTarget.url });
  const landing = await page.evaluate(`(async () => { await __bo1zExt.api; const s = await __bo1zLobby.getState();
    return { lobby: typeof __bo1zLobby, phase: s.phase, maps: s.maps.length, ctl: !!__bo1zExt.ctl }; })()`, 30000);
  step('tela inicial com a extensão', landing);
  const base = await page.evaluate(BASELINE);
  report.rtt.push({ role: 'tela inicial', screen: 'landing', baseline: base });
  step('tela inicial: referência na própria página', base);
  // latência do caminho sem o motor (referência)
  for (const size of [300, 1264]) {
    const m = await page.evaluate(`__bo1zExt.api.then(a => a.measureRtt({ n: 400, size: ${size}, enc: 'b64' }))`);
    report.rtt.push({ role: 'tela inicial', screen: 'landing', ...m });
    step(`tela inicial: ida e volta b64 ${size} B`, m);
  }

  const roles = only ? [only] : ['host', 'guest'];
  for (const role of roles) {
    // sala na fase de lobby injetada no offscreen (sem rede) e o início de verdade: a sessão manda a aba para o mapa
    // com #bo1z-start (mantendo o ?renderer=webgl2 da tela inicial) e a página começa sozinha
    await navigate(page, 'about:blank');
    await navigate(page, 'https://vel.gg/bo1z?renderer=webgl2');
    await waitEval(page, `location.pathname === '/bo1z' && !!globalThis.__bo1zExt?.state`);
    await off.evaluate(`(() => { const s = __bo1zExtSession; s.owner = null; s.setState({ phase: 'lobby', mode: 'webrtc',
      role: '${role}', room: 'SMKTS', you: { id: 'smoke', name: 'Smoke ${role}' }, map: s.maps.find(m => m.slug === '${slug}') });
      s.beginGame(s.state.map.zone, 'smoke-${role}'); })()`);
    const url = await waitUrl(page, u => u.includes(`/bo1z/${slug}`));
    step(`${role}: a sessão levou a aba ao mapa (início automático)`, { url });
    const r = await runEngine(page, role, off);
    r.phase = await off.evaluate('__bo1zExtSession.getState().phase');
    r.verdict.playingPhase = r.phase === 'playing';
    r.ok = Object.values(r.verdict).every(Boolean);
    report[role] = r;
    save();
  }
  report.hub = await off.evaluate('__bo1zExtHub.stats()');
  report.ok = (!roles.includes('host') || report.host?.ok) && (!roles.includes('guest') || report.guest?.ok);
  step(report.ok ? 'OK' : 'FALHOU', { host: report.host?.verdict, guest: report.guest?.verdict });
} catch (error) {
  step('erro', { message: error.stack ?? error.message, stderr: chrome?.stderr().slice(-1500) });
} finally {
  report.console = consoleLines.slice(-400);
  report.finished = new Date().toISOString();
  save();
  console.log(`relatório: ${path.join(out, 'report.json')}`);
  if (!flag('--keep')) chrome?.close();
  setTimeout(() => process.exit(report.ok ? 0 : 1), 300);
}

async function runEngine(page, role, off) {
  const tStart = Date.now();
  let last = null, clicked = false, done = false, bridge = false;
  // host: até a ponte subir e o mapa carregar (1ª vez: download dos packs). Convidado: até o cliente do motor, já no
  // mapa sombra, começar a chamar o host pela ponte (sem host do outro lado ele fica na tela de carregamento).
  const finished = s => role === 'host' ? s.mapLoaded && s.coop : s.coop && s.connecting;
  while (Date.now() - tStart < 20 * 60e3) {
    last = await probe(page);
    if (last.errors?.length || last.screen === 'error') throw new Error(`${role}: erro na página ${JSON.stringify(last.errors)}`);
    if (last.coop && !bridge) { bridge = true; step(`${role}: ponte no ar`, { mode: last.coop.mode, ext: last.ext }); }
    if (last.screen === 'ready' && !clicked) clicked = await clickPlay(page);
    if (finished(last)) { done = true; break; }
    if ((Date.now() - tStart) % 30000 < 1000) step(`${role}: carregando`, { screen: last.screen, load: last.load });
    await sleep(1000);
  }
  if (!done) throw new Error(`${role}: não chegou ao fim (${JSON.stringify(last)})`);
  step(role === 'host' ? 'host: mapa carregado' : 'convidado: cliente chamando o host pela ponte', { screen: last.screen, s: (Date.now() - tStart) / 1000 });

  const r = await page.evaluate(`(async () => {
    const kb = __bo1zKB, api = await __bo1zExt.api, p = kb.malloc(64);
    const ok = p > 0 && p % 8 === 0 && p + 64 <= kb.memory.buffer.byteLength;
    kb.free(p);
    const L = api.layout;
    return { memoryBytes: kb.memory.buffer.byteLength, shared: kb.memory.buffer instanceof SharedArrayBuffer, malloc: p, mallocOk: ok,
      module: Object.keys(kb.module ?? {}), layout: L && { ok: L.ok, base: L.layout?.base, stride: L.layout?.stride,
      producers: L.producers, clientConnPtr: L.layout?.clientConnPtr, sha: L.sha, reason: L.reason },
      role: api.role, args: five.arguments, noquit: five.__bo1zNoQuit === true, coopMode: __bo1zCoop?.mode,
      stats: __bo1zCoop?.stats?.() ?? null, timings: __bo1zExt.timings, fiveTimings: five.timings };
  })()`);
  const at = r.args?.indexOf('+devmap');
  r.verdict = {
    kb: r.shared && r.memoryBytes === 2147418112 && r.mallocOk,
    layout: !!r.layout?.ok,
    bridge: r.coopMode === 'worker',
    role: r.role === role,
    args: role === 'host' ? r.args?.join(' ').includes('+set sv_timeout 30')
      : r.args?.[at + 2] === '+connect' && r.args?.[at + 3] === 'localhost:3074',
  };
  if (role === 'guest') {
    r.verdict.g1 = consoleLines.some(l => /wasm do convidado: G1/.test(l));
    r.verdict.noquit = r.noquit;
    // o cliente do motor chama o host ("connect" OOB, servidor sombra pausado) e os pacotes chegam ao offscreen
    r.handshake = await page.evaluate(`(globalThis.__bo1zCoop?.handshake ?? []).slice(-10)`);
    r.engineConsole = await page.evaluate(`five.console.map(x => x.message).filter(m => /localhost|connect|challenge|PLATFORM_DIS|sv_paused/i.test(m)).slice(-15)`);
    r.hub = await off.evaluate('__bo1zExtHub.stats()');
    r.stats = await page.evaluate('__bo1zCoop?.stats?.() ?? null');
    r.verdict.connecting = r.handshake.some(l => /out (getchallenge|connect)/.test(l)) && r.hub.some(c => c.fromPage > 0);
    r.verdict.armed = r.stats?.armed === true && r.stats?.pausedShadow === true;
  }
  // latência do caminho dos pacotes com o motor rodando (página -> isolado -> offscreen -> isolado -> página)
  const base = await page.evaluate(BASELINE);
  report.rtt.push({ role, screen: (await probe(page)).screen, baseline: base });
  step(`${role}: referência na própria página`, base);
  for (const [enc, size] of [['b64', 100], ['b64', 300], ['b64', 1264], ['latin1', 300], ['latin1', 1264], ['arr', 300], ['arr', 1264]]) {
    const m = await page.evaluate(`__bo1zExt.api.then(a => a.measureRtt({ n: 400, size: ${size}, enc: '${enc}' }))`);
    report.rtt.push({ role, screen: (await probe(page)).screen, ...m });
    step(`${role}: ida e volta ${enc} ${size} B`, m);
  }
  step(`${role}: veredito`, r.verdict);
  return r;
}
