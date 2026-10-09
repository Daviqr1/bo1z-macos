// Teste de ponta a ponta do co-op com o motor DE VERDADE, guiado pela API do lobby (como um jogador faria):
// sobe host e convidado (duas instâncias do app), host cria a sala, convidado entra, fica pronto, host inicia, os dois
// entram no mapa, confere no servidor do host que o convidado está ativo, deixa rodando N minutos medindo e grava um
// relatório. Serve para o modo "por IP" (UDP) e para o WebRTC (com o servidor de convite local ou publicado).
//
//   node tools/coop-e2e.mjs [--mode udp|webrtc] [--signal http://127.0.0.1:8787] [--map zombie_cod5_prototype]
//        [--minutes 5] [--home <pasta>] [--headless] [--replay] [--nozombies] [--out <pasta>]
//
// --headless: Linux sem tela/GPU (xvfb-run + WebGL2 por software; renderScale 0.3 e com_maxfps 20 no config.json da
// pasta de teste). No Mac, sem --headless, usa ~/Applications/BO1 Zombies.app (rode ./build.sh antes) com o perfil
// do --home (padrão: pasta temporária; os packs são baixados na primeira vez).
// --nozombies: +set ai_disableSpawn 1 (teste longo de rede sem ninguém morrer parado).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir, platform, homedir } from 'node:os';
import path from 'node:path';
import { connectPage, sleep } from './cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
const flag = name => argv.includes(name);
const mode = opt('--mode', 'udp'), signal = opt('--signal', ''), zone = opt('--map', 'zombie_cod5_prototype');
const minutes = Number(opt('--minutes', 5)), headless = flag('--headless');
const root = new URL('..', import.meta.url).pathname;
const home = opt('--home', mkdtempSync(path.join(tmpdir(), 'bo1z-e2e-')));
const out = opt('--out', path.join(home, 'logs', `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`));
mkdirSync(out, { recursive: true });
const report = { mode, zone, minutes, started: new Date().toISOString(), steps: [], samples: [], ok: false };
const step = (name, data = {}) => { const e = { t: new Date().toISOString(), name, ...data }; report.steps.push(e); console.log(`[${e.t.slice(11, 19)}] ${name}${Object.keys(data).length ? ' ' + JSON.stringify(data).slice(0, 300) : ''}`); };
const save = () => writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

// config de teste (só na pasta do teste)
const commands = { '*': [...(headless ? ['+set', 'com_maxfps', '20'] : []), ...(flag('--nozombies') ? ['+set', 'ai_disableSpawn', '1'] : [])] };
if (!existsSync(path.join(home, 'config.json')))
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'https://vel.gg/bo1z/', patches: true, volume: 0,
    renderScale: headless ? 0.3 : 1, commands, coop: { signal } }, null, 2));

const procs = [];
function launch(name, env) {
  const base = { ...process.env, BO1Z_HOME: home, BO1Z_MUTE: '1', ...(signal ? { BO1Z_SIGNAL: signal } : {}), ...env };
  let cmd, args;
  if (headless || platform() !== 'darwin') {
    const electron = path.join(root, 'node_modules/electron/dist/electron');
    cmd = 'xvfb-run'; args = ['-a', '-s', '-screen 0 1280x800x24', electron, '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', path.join(root, 'app')];
  } else {
    cmd = path.join(homedir(), 'Applications/BO1 Zombies.app/Contents/MacOS/Electron'); args = [];
  }
  // grupo de processos próprio: no fim mata o grupo inteiro (xvfb-run, Xvfb, Electron e os filhos dele)
  const p = spawn(cmd, args, { env: base, stdio: 'ignore', detached: true });
  procs.push(p);
  step(`subiu ${name}`, { pid: p.pid });
  return p;
}

async function page(port, match = 'vel.gg') {
  for (let i = 0; i < 120; ++i) {
    try {
      const p = await connectPage(port, { match });
      if (await p.evaluate(`document.readyState === 'complete' && location.hostname === 'vel.gg'`)) return p;
      p.close();
    } catch { /* subindo */ }
    await sleep(1000);
  }
  throw new Error(`DevTools ${port} sem página do vel.gg`);
}
const lobby = (p, fn, ...args) => p.evaluate(`__bo1zLobby.${fn}(${args.map(a => JSON.stringify(a)).join(',')}).then(s => JSON.stringify(s))`).then(JSON.parse);
async function waitState(p, cond, label, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const s = await lobby(p, 'getState');
    if (cond(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`${label}: estado ${JSON.stringify({ phase: s.phase, error: s.error, peers: s.peers?.length })}`);
    await sleep(500);
  }
}
async function screen(port) {
  const p = await page(port);
  const r = await p.evaluate(`JSON.stringify({ screen: document.body?.dataset.screen, url: location.pathname })`);
  p.close();
  return JSON.parse(r);
}
async function enterGame(port, label, ms = 600000) {
  const t0 = Date.now();
  for (;;) {
    let p;
    try { p = await page(port); } catch { await sleep(2000); continue; }
    const s = JSON.parse(await p.evaluate(`JSON.stringify({ screen: document.body?.dataset.screen, url: location.pathname })`).catch(() => '{}'));
    if (s.screen === 'ready') {
      const r = JSON.parse(await p.evaluate(`JSON.stringify((() => { const b = document.getElementById('play').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })())`));
      for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    }
    if (s.screen === 'error') {
      const detail = await p.evaluate(`JSON.stringify({ error: document.getElementById('error')?.textContent?.slice(0, 600), crash: String(five?.crashReport ?? '').slice(0, 4000) })`).catch(() => '{}');
      writeFileSync(path.join(out, `${label}-erro.json`), detail);
      p.close();
      throw new Error(`${label}: tela de erro: ${JSON.parse(detail).error ?? '?'}`);
    }
    p.close();
    if (s.screen === 'playing') { step(`${label} jogando`, s); return; }
    if (Date.now() - t0 > ms) throw new Error(`${label}: não entrou no jogo (${s.screen})`);
    await sleep(2000);
  }
}
async function shot(port, file) {
  const p = await page(port);
  const r = await p.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  p.close();
}
// Servidor do host: estados dos slots de cliente (svs.clients; endereços deste build, só diagnóstico).
const SLOTS = `(() => { const dv = new DataView(__bo1zKB.memory.buffer); const base = dv.getUint32(142360860, true); if (!base) return []; return [0,1,2,3].map(i => { const c = base + i * 544120; return { state: dv.getInt32(c, true), port: dv.getUint16(c + 40, true) }; }); })()`;
const sample = async (port) => {
  const p = await page(port);
  try {
    return JSON.parse(await p.evaluate(`JSON.stringify({ coop: globalThis.__bo1zCoop?.stats?.() ?? null, slots: ${SLOTS},
      view: five.console.map(x => x.message).filter(m => /KISAK_BROWSER view/.test(m)).slice(-1)[0]?.slice(20, 120) ?? null,
      lobby: null })`));
  } finally { p.close(); }
};

try {
  // perfil do convidado: cópia do do host (packs já baixados) quando existir
  if (existsSync(path.join(home, 'profile')) && !existsSync(path.join(home, 'profile-guest'))) {
    cpSync(path.join(home, 'profile'), path.join(home, 'profile-guest'), { recursive: true });
    rmSync(path.join(home, 'profile-guest', 'SingletonLock'), { force: true });
  }
  for (const port of [9334, 9335]) {
    const busy = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false);
    if (busy) throw new Error(`porta DevTools ${port} já em uso (instância antiga aberta?)`);
  }
  launch('host', { BO1Z_DEBUG_PORT: '9334' });
  const host = await page(9334);
  launch('convidado', { BO1Z_PROFILE: 'guest', BO1Z_DEBUG_PORT: '9335' });
  const guest = await page(9335);
  step('páginas no ar');

  let st;
  if (mode === 'udp') {
    st = await lobby(host, 'connectByAddress', { role: 'host', code: 'TESTE', name: 'Host', bind: '127.0.0.1' });
    await lobby(guest, 'connectByAddress', { role: 'guest', address: '127.0.0.1:27960', code: 'TESTE', name: 'Convidado' });
  } else {
    st = await lobby(host, 'create', { name: 'Host', map: zone });
    st = await waitState(host, s => s.phase === 'lobby' && s.room, 'sala criada');
    step('sala criada', { room: st.room, invite: st.invite });
    await lobby(guest, 'join', { code: st.room, name: 'Convidado' });
  }
  await lobby(host, 'setMap', zone);
  st = await waitState(host, s => s.peers.some(p => p.role === 'guest'), 'convidado na sala');
  step('convidado na sala', { peers: st.peers });
  await waitState(guest, s => s.phase === 'lobby', 'lobby do convidado');
  await lobby(guest, 'setReady', true);
  await waitState(host, s => s.peers.some(p => p.ready), 'convidado pronto');
  await lobby(host, 'start');
  step('host iniciou');
  host.close(); guest.close();
  await enterGame(9334, 'host');
  await enterGame(9335, 'convidado');
  await sleep(20000);
  await shot(9334, path.join(out, 'host-inicio.png'));
  await shot(9335, path.join(out, 'convidado-inicio.png'));

  // confere: 2 clientes ativos no servidor do host; convidado armado e com servidor sombra pausado
  const h0 = await sample(9334), g0 = await sample(9335);
  const active = h0.slots.filter(s => s.state === 5).length;
  step('verificação', { clientesAtivosNoHost: active, slots: h0.slots, convidado: { armed: g0.coop?.armed, pausedShadow: g0.coop?.pausedShadow } });
  if (active < 2) throw new Error('convidado não está ativo no servidor do host');

  if (flag('--replay')) {
    const replay = spawn(process.execPath, [path.join(root, 'tools/replay.mjs'), '9335', '--from', '60', '--duration', String(minutes * 60)], { stdio: 'ignore' });
    procs.push(replay);
    step('replay da gravação no convidado');
  }
  const end = Date.now() + minutes * 60e3;
  while (Date.now() < end) {
    await sleep(10000);
    const [h, g] = await Promise.all([sample(9334), sample(9335)]);
    const hs = await lobby(await page(9334), 'getState');
    const row = { t: new Date().toISOString(), hostSlots: h.slots.map(s => s.state), peers: hs.peers.map(p => ({ ping: p.ping, link: p.link })),
      host: h.coop && { in: h.coop.traffic?.in, out: h.coop.traffic?.out, clobbered: h.coop.bridge?.clobbered, phantom: h.coop.bridge?.phantom, cas: h.coop.bridge?.casRetries },
      guest: g.coop && { in: g.coop.traffic?.in, out: g.coop.traffic?.out, armed: g.coop.armed, paused: g.coop.pausedShadow, dropped: g.coop.bridge?.dropped },
      guestView: g.view };
    report.samples.push(row);
    console.log(`  ${row.t.slice(11, 19)} slots=${row.hostSlots.join('')} ping=${row.peers.map(p => p.ping).join(',')} host in/out=${row.host?.in}/${row.host?.out} conv in/out=${row.guest?.in}/${row.guest?.out}`);
    save();
    if (row.hostSlots.filter(s => s === 5).length < 2) { step('convidado saiu do servidor do host'); break; }
  }
  await shot(9334, path.join(out, 'host-fim.png'));
  await shot(9335, path.join(out, 'convidado-fim.png'));
  const last = report.samples.at(-1);
  report.ok = !!last && last.hostSlots.filter(s => s === 5).length >= 2;
  step(report.ok ? 'OK: convidado ficou no jogo do host até o fim' : 'FALHOU');
} catch (error) {
  step('erro', { message: error.message });
} finally {
  report.finished = new Date().toISOString();
  save();
  console.log(`relatório: ${path.join(out, 'report.json')}`);
  if (flag('--keep') && !report.ok) { console.log('--keep: instâncias continuam abertas (DevTools 9334/9335)'); process.exit(1); }
  for (const p of procs) try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(report.ok ? 0 : 1), 1500);
}
