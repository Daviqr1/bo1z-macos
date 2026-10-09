// Co-op pelo navegador de ponta a ponta, com o motor DE VERDADE: dois Chromium com a extensão (host e convidado), o
// servidor de sinalização local (signal/dev-server.mjs), a rede WebRTC da janela net do app (app/net) no offscreen.
// Como um jogador faria: o host cria a sala pela API do lobby na tela de mapas, o convidado abre o link de convite do
// navegador (#bo1z-join=…&s=…), fica pronto, o host inicia, as duas abas vão sozinhas para o mapa e o convidado entra
// no jogo do host (2 clientes ativos no servidor do host). Deixa rodar N minutos medindo ping/enlace/pacotes.
//
//   node tools/ext-e2e.mjs [--signal-dir signal] [--net app/net] [--map nacht] [--minutes 2] [--profile <perfil do
//        host, com os packs>] [--out <pasta>] [--xvfb] [--keep]
// O perfil do convidado é uma cópia do do host (packs já baixados). Para economizar CPU (duas cópias do motor com
// WebGL por software), o teste liga com_maxfps 20 pelo gancho de teste do próprio site (__kisakParity).
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attach, clickPlay, launchChrome, navigate, probe, sleep, targets, waitEval, waitTarget, waitUrl } from './ext-cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
const flag = name => argv.includes(name);
const root = new URL('..', import.meta.url).pathname;
const scratch = process.env.BO1Z_SCRATCH ?? path.join(os.tmpdir(), 'bo1z-ext');
const out = opt('--out', path.join(scratch, `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const signalDir = path.resolve(opt('--signal-dir', path.join(root, 'signal')));
const netDir = path.resolve(opt('--net', path.join(root, 'app/net')));
const hostProfile = opt('--profile', path.join(scratch, 'ext-profile'));
const slug = opt('--map', 'nacht'), minutes = Number(opt('--minutes', 2));
const SIGNAL_PORT = 8797;
mkdirSync(out, { recursive: true });

const t0 = Date.now();
const report = { started: new Date().toISOString(), slug, minutes, steps: [], samples: [], ok: false };
const step = (name, data) => {
  const e = { s: +((Date.now() - t0) / 1000).toFixed(1), name, ...(data === undefined ? {} : { data }) };
  report.steps.push(e);
  console.log(`[${String(e.s).padStart(6)} s] ${name}${data === undefined ? '' : ' ' + JSON.stringify(data).slice(0, 500)}`);
};
const save = () => writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const lines = { host: [], guest: [] };
const keep = who => line => { if (/BO1Z_|map-loaded|Com_ERROR|SV_DirectConnect|CS_ACTIVE|Going from|challenge/i.test(line)) lines[who].push(line.slice(0, 300)); };
const lobby = (page, fn, ...args) => page.evaluate(`__bo1zLobby.${fn}(${args.map(a => JSON.stringify(a)).join(',')})`, 15000);
async function waitState(page, cond, label, ms = 60000) {
  const t = Date.now();
  for (;;) {
    const s = await lobby(page, 'getState').catch(() => null);
    if (s && cond(s)) return s;
    if (Date.now() - t > ms) throw new Error(`${label}: ${JSON.stringify(s && { phase: s.phase, error: s.error, peers: s.peers })}`);
    await sleep(300);
  }
}
// Slots de cliente no servidor do host (svs.clients deste build do wasm; só diagnóstico, como tools/coop-e2e.mjs).
const SLOTS = `(() => { const dv = new DataView(__bo1zKB.memory.buffer); const base = dv.getUint32(142360860, true); if (!base) return [];
  return [0, 1, 2, 3].map(i => { const c = base + i * 544120; return { state: dv.getInt32(c, true), port: dv.getUint16(c + 40, true) }; }); })()`;

const procs = [];
let host = null, guest = null;
try {
  // sinalização local
  const signal = spawn(process.execPath, [path.join(signalDir, 'dev-server.mjs'), String(SIGNAL_PORT)],
    { env: { ...process.env, HOST: '127.0.0.1' }, detached: true, stdio: 'ignore' });
  const killSignal = () => { try { process.kill(-signal.pid, 'SIGKILL'); } catch { /* saiu */ } };
  procs.push(killSignal);
  process.once('exit', killSignal);
  const signalUrl = `http://127.0.0.1:${SIGNAL_PORT}`;
  await (async () => { for (let i = 0; i < 50; ++i) { if (await fetch(`${signalUrl}/health`).then(r => r.ok, () => false)) return; await sleep(200); } throw new Error('sinalização não subiu'); })();
  step('sinalização local no ar', { signalUrl });

  const ext = path.join(out, 'ext');
  execFileSync(path.join(root, 'scripts/build-extension.sh'), [ext], { cwd: root, stdio: 'inherit',
    env: { ...process.env, BO1Z_EXT_NET_DIR: netDir, BO1Z_EXT_ZIP: path.join(out, 'ext.zip') } });
  const guestProfile = path.join(out, 'profile-guest');
  if (existsSync(hostProfile)) {
    cpSync(hostProfile, guestProfile, { recursive: true });
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(path.join(guestProfile, f), { force: true });
  }
  // WebRTC entre dois navegadores na mesma máquina: candidatos com IP (sem mDNS, que não resolve aqui)
  const extraArgs = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
  host = await launchChrome({ extension: ext, profile: hostProfile, port: 9481, xvfb: flag('--xvfb'), extraArgs, log: m => step(`host: ${m}`) });
  guest = await launchChrome({ extension: ext, profile: guestProfile, port: 9482, xvfb: flag('--xvfb'), extraArgs, log: m => step(`convidado: ${m}`) });
  procs.push(() => host.close(), () => guest.close());

  const open = async (browser, who, name) => {
    const page = await attach(await waitTarget(browser.port, t => t.type === 'page'), { onConsole: keep(who) });
    await page.send('Page.enable');
    // gancho de teste do site: menos quadros por segundo (CPU) e sem som
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:
      "globalThis.__headlessInput = true; globalThis.__kisakParity = { commands: ['+set', 'com_maxfps', '20'], muted: true };" });
    await navigate(page, 'https://vel.gg/bo1z?renderer=webgl2');
    const sw = await attach(await waitTarget(browser.port, t => t.type === 'service_worker'));
    await sw.evaluate(`chrome.storage.local.set(${JSON.stringify({ name, signal: signalUrl })})`);
    sw.close();
    await waitEval(page, `location.pathname === '/bo1z' && !!globalThis.__bo1zExt?.state`);
    return page;
  };
  const hp = await open(host, 'host', 'Host');
  let st = await lobby(hp, 'create', { name: 'Host', map: (await lobby(hp, 'getState')).maps.find(m => m.slug === slug).zone });
  st = await waitState(hp, s => s.phase === 'lobby' && s.room, 'sala criada');
  step('host criou a sala', { room: st.room, invite: st.invite, browserInvite: st.browserInvite });

  // convidado: só abre o link do navegador
  const gp = await attach(await waitTarget(guest.port, t => t.type === 'page'), { onConsole: keep('guest') });
  await gp.send('Page.enable');
  await gp.send('Page.addScriptToEvaluateOnNewDocument', { source:
    "globalThis.__headlessInput = true; globalThis.__kisakParity = { commands: ['+set', 'com_maxfps', '20'], muted: true };" });
  const sw = await attach(await waitTarget(guest.port, t => t.type === 'service_worker'));
  await sw.evaluate(`chrome.storage.local.set(${JSON.stringify({ name: 'Irmao', signal: '' })})`);
  sw.close();
  await navigate(gp, st.browserInvite.replace('/bo1z/#', '/bo1z/?renderer=webgl2#'));
  await waitEval(gp, `location.pathname.startsWith('/bo1z') && location.hash === '' && !!globalThis.__bo1zExt?.state`);
  step('convidado abriu o convite (hash limpo da barra)', { url: await gp.evaluate('location.href') });
  let gs = await waitState(gp, s => s.phase === 'lobby' && s.peers.some(p => p.role === 'host'), 'convidado na sala');
  st = await waitState(hp, s => s.peers.some(p => p.role === 'guest' && p.link !== 'connecting' && p.ping !== null), 'enlace WebRTC', 60000);
  step('enlace WebRTC no ar', { host: st.peers, convidado: gs.peers });
  await lobby(gp, 'setReady', true);
  await waitState(hp, s => s.peers.some(p => p.ready), 'convidado pronto');
  await lobby(hp, 'start');
  step('host iniciou');

  // as duas abas vão sozinhas para o mapa e começam; clica para entrar quando o site pede
  await Promise.all([waitUrl(hp, u => u.includes(`/bo1z/${slug}`)), waitUrl(gp, u => u.includes(`/bo1z/${slug}`))]);
  step('as duas abas foram para o mapa');
  const enter = async (page, who) => {
    const t = Date.now();
    for (;;) {
      const s = await probe(page);
      if (s.screen === 'ready') await clickPlay(page);
      if (s.screen === 'playing' || (who === 'convidado' && s.coop?.stats?.traffic?.in > 50)) return s;
      if (s.screen === 'error' || s.errors?.length) throw new Error(`${who}: erro ${JSON.stringify(s.errors)}`);
      if (Date.now() - t > 15 * 60e3) throw new Error(`${who}: não entrou (${JSON.stringify(s)})`);
      await sleep(1000);
    }
  };
  await enter(hp, 'host');
  step('host no jogo');
  const gEnter = await enter(gp, 'convidado');
  step('convidado recebendo do host', { screen: gEnter.screen, coop: gEnter.coop?.stats?.traffic });

  // convidado ativo no servidor do host (state 5 = CS_ACTIVE) e a rede de cada lado
  const sample = async () => {
    const [h, g, hs, gs2] = await Promise.all([
      hp.evaluate(`({ slots: ${SLOTS}, coop: __bo1zCoop?.stats?.() ?? null, screen: document.body.dataset.screen })`),
      gp.evaluate(`({ coop: __bo1zCoop?.stats?.() ?? null, screen: document.body.dataset.screen })`),
      lobby(hp, 'getState'), lobby(gp, 'getState')]);
    return { t: new Date().toISOString(), slots: h.slots.map(s => s.state), hostScreen: h.screen, guestScreen: g.screen,
      phase: [hs.phase, gs2.phase], peers: hs.peers.map(p => ({ ping: p.ping, link: p.link, loss: p.loss })),
      host: h.coop && { in: h.coop.traffic.in, out: h.coop.traffic.out, clobbered: h.coop.bridge.clobbered, phantom: h.coop.bridge.phantom },
      guest: g.coop && { in: g.coop.traffic.in, out: g.coop.traffic.out, armed: g.coop.armed, paused: g.coop.pausedShadow } };
  };
  const tActive = Date.now();
  let row = await sample();
  while (row.slots.filter(s => s === 5).length < 2 && Date.now() - tActive < 180000) { await sleep(3000); row = await sample(); }
  step('verificação', row);
  if (row.slots.filter(s => s === 5).length < 2) throw new Error('convidado não ficou ativo no servidor do host');
  const end = Date.now() + minutes * 60e3;
  while (Date.now() < end) {
    await sleep(10000);
    row = await sample();
    report.samples.push(row);
    console.log(`  ${row.t.slice(11, 19)} slots=${row.slots.join('')} ping=${row.peers.map(p => `${p.ping}ms/${p.link}`).join(',')} ` +
      `host in/out=${row.host?.in}/${row.host?.out} conv in/out=${row.guest?.in}/${row.guest?.out}`);
    save();
    if (row.slots.filter(s => s === 5).length < 2) { step('convidado saiu do servidor do host'); break; }
  }
  for (const [page, who] of [[hp, 'host'], [gp, 'convidado']]) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) writeFileSync(path.join(out, `${who}.png`), Buffer.from(shot.result.data, 'base64'));
  }
  report.ok = row.slots.filter(s => s === 5).length >= 2;
  step(report.ok ? 'OK: convidado no jogo do host pelo navegador até o fim' : 'FALHOU');
} catch (error) {
  step('erro', { message: error.stack ?? error.message });
} finally {
  report.console = lines;
  report.finished = new Date().toISOString();
  save();
  console.log(`relatório: ${path.join(out, 'report.json')}`);
  if (!flag('--keep')) for (const kill of procs) kill();
  setTimeout(() => process.exit(report.ok ? 0 : 1), 300);
}
