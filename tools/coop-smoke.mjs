// Smoke test do co-op no Electron de verdade, sem os arquivos do jogo: sobe duas instâncias do app (host 9334 e
// convidado 9335, perfis separados numa pasta temporária, sala UDP em 127.0.0.1), confere o que o main serve
// (glue com N1, engine.js do convidado, módulos /__bo1z/coop/) e troca um getchallenge/challengeResponse entre dois
// "motores" falsos (SharedArrayBuffer na página, rings no layout que o main tirou do wasm real do vel.gg).
// node tools/coop-smoke.mjs            (Mac)
// xvfb-run -a node tools/coop-smoke.mjs   (Linux sem tela)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectPage, sleep } from './cdp.mjs';

const root = new URL('..', import.meta.url).pathname;
const electron = createRequire(import.meta.url)('electron'); // caminho do binário (devDependency)
const home = mkdtempSync(path.join(tmpdir(), 'bo1z-smoke-'));
writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'https://vel.gg/bo1z/', patches: false, volume: 0, commands: {} }));
const procs = [];
class Failure extends Error {}
const fail = msg => { throw new Failure(msg); };
function cleanup(code) {
  for (const p of procs) try { p.kill('SIGTERM'); } catch {}
  for (const f of ['coop.log', 'coop-guest.log', 'game.log', 'game-guest.log']) {
    const file = path.join(home, 'logs', f);
    if (existsSync(file)) console.log(`\n--- ${f}\n${readFileSync(file, 'utf8').trim().split('\n').slice(-25).join('\n')}`);
  }
  setTimeout(() => process.exit(code), 500);
}

function launch(name, env) {
  const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []), path.join(root, 'app')];
  const p = spawn(electron, args, { env: { ...process.env, BO1Z_HOME: home, BO1Z_MUTE: '1', BO1Z_COOP_CODE: 'SMOKE', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', d => { const s = String(d); if (/error/i.test(s) && !/gpu|GLES|viz|dbus|Fontconfig|ALSA/i.test(s)) process.stderr.write(`[${name}] ${s}`); });
  procs.push(p);
  return p;
}

// Espera a aba do vel.gg terminar de carregar (antes disso o evaluate pode cair no documento inicial, sem preload).
async function page(port) {
  for (let i = 0; i < 90; ++i) {
    try {
      const p = await connectPage(port);
      if (await p.evaluate(`document.readyState === 'complete' && location.hostname === 'vel.gg'`)) return p;
      p.close();
    } catch { /* ainda subindo */ }
    await sleep(500);
  }
  throw new Error(`DevTools ${port} não respondeu`);
}

// Motor falso: memória compartilhada com o mesmo layout do motor real. No convidado, a "conexão do cliente" já aponta
// para o host (serverAddress tipo 2, porta 524), que é quando a ponte do convidado passa a encaminhar.
const FAKE_ENGINE = `(() => {
  const mem = new SharedArrayBuffer(160 << 20); let top = 140000000;
  const dv = new DataView(mem), conn = 150000000;
  dv.setUint32(43783020, conn, true); dv.setInt32(conn + 16, 2, true); dv.setUint16(conn + 24, 524, true);
  globalThis.__bo1zKB = { memory: { buffer: mem }, malloc: n => { const p = (top + 15) & ~15; top = p + n; return p; }, free: () => {} };
  dispatchEvent(new Event('bo1z:kb'));
  return crossOriginIsolated;
})()`;

const RING_HELPERS = `
  const { RingIO } = await import('/__bo1z/coop/ring.mjs');
  const coop = globalThis.__bo1zCoop, L = coop.layout ?? coop.bridge.layout, io = new RingIO(globalThis.__bo1zKB.memory.buffer, L);
  const oob = t => Uint8Array.from([255, 255, 255, 255, ...new TextEncoder().encode(t)]);
  const text = b => b[0] === 255 ? new TextDecoder().decode(b.subarray(4)) : null;
  // consumidor no estilo NET_GetLoopPacket
  const take = ring => { const get = io.loadGet(ring); if (get === io.loadSend(ring)) return null;
    const slot = io.slotAddr(ring, get), len = io.i32[(slot + L.lenOff) >> 2], tag = io.i32[(slot + L.tagOff) >> 2];
    const bytes = io.u8.slice(slot, slot + len); Atomics.add(io.i32, (ring + L.getOff) >> 2, 1); return { bytes, tag }; };`;

try {
  launch('host', { BO1Z_COOP: 'host', BO1Z_COOP_BIND: '127.0.0.1', BO1Z_DEBUG_PORT: '9334' });
  const host = await page(9334);
  launch('convidado', { BO1Z_PROFILE: 'guest', BO1Z_COOP: 'guest', BO1Z_COOP_HOST: '127.0.0.1:27960', BO1Z_DEBUG_PORT: '9335' });
  const guest = await page(9335);
  console.log('instâncias no ar:', host.url, guest.url);

  for (const [name, p] of [['host', host], ['convidado', guest]]) {
    if (await p.evaluate(`typeof globalThis.__bo1zCoopHost`) !== 'object') fail(`${name}: preload sem __bo1zCoopHost`);
    const glue = await p.evaluate(`fetch('/bo1z/artifacts/KisakBlack-web.mjs').then(r => r.text()).then(t => t.includes('globalThis.__bo1zKB = {'))`);
    if (!glue) fail(`${name}: glue servido sem N1`);
  }
  const engineJs = await guest.evaluate(`fetch('/bo1z/engine.js').then(r => r.text()).then(t => t.includes("args.splice(at + 2, 0, '+connect', 'localhost:3074')"))`);
  if (!engineJs) fail('convidado: engine.js sem a estratégia shadow (+devmap … +connect localhost:3074)');
  const hostEngineJs = await host.evaluate(`fetch('/bo1z/engine.js').then(r => r.text()).then(t => t.includes('__bo1zCoopGuest'))`);
  if (hostEngineJs) fail('host: engine.js não deveria ser alterado');
  console.log('main serve glue com N1 e engine.js do convidado: ok');

  for (const [name, p] of [['host', host], ['convidado', guest]]) {
    if (!await p.evaluate(FAKE_ENGINE)) fail(`${name}: página sem crossOriginIsolated`);
    let ok = false;
    for (let i = 0; i < 60 && !ok; ++i) { await sleep(500); ok = await p.evaluate(`!!globalThis.__bo1zCoop`); }
    if (!ok) fail(`${name}: page.mjs não iniciou (layout/port)`);
  }
  console.log('page.mjs ativo nos dois (layout do wasm real + MessagePort): ok');

  // "servidor" do host: responde getchallenge no ring do remetente
  await host.evaluate(`(async () => {${RING_HELPERS}
    globalThis.__seen = [];
    setInterval(() => { for (let p; (p = take(io.addr(1)));) { const t = text(p.bytes); __seen.push([p.tag, t]);
      if (t?.startsWith('getchallenge')) io.publish(io.addr(p.tag & 0xffff), oob('challengeResponse 7'), 0); } }, 2);
    return true; })()`);
  // cliente do convidado: getchallenge no ring 1 da própria instância (como o motor faz com connect localhost)
  let reply = null;
  for (let i = 0; i < 40 && !reply; ++i) {
    reply = await guest.evaluate(`(async () => {${RING_HELPERS}
      if (!globalThis.__sent || performance.now() - globalThis.__sent > 1000) { io.publish(io.addr(1), oob('getchallenge 0 "smoke"'), 0); globalThis.__sent = performance.now(); }
      await new Promise(r => setTimeout(r, 250));
      for (let p; (p = take(io.addr(0)));) if (text(p.bytes)) return text(p.bytes);
      return null; })()`);
  }
  if (reply !== 'challengeResponse 7') fail(`resposta não chegou ao convidado (${reply})`);
  const seen = await host.evaluate(`JSON.stringify(__seen.slice(0, 3))`);
  console.log(`handshake pela sala UDP: ok (servidor viu ${seen}; convidado recebeu "${reply}")`);
  await sleep(1200); // estatísticas do Worker chegam a cada 1 s
  const stats = await host.evaluate(`JSON.stringify({ modo: __bo1zCoop.mode, ponte: __bo1zCoop.stats()?.bridge })`);
  console.log('ponte do host:', stats.slice(0, 400));
  const lobbyState = await host.evaluate(`__bo1zLobby.getState().then(s => JSON.stringify({ phase: s.phase, mode: s.mode, role: s.role, room: s.room, maps: s.maps.length }))`);
  console.log('estado da sala (lobby API):', lobbyState);
  console.log('\nSMOKE OK');
  cleanup(0);
} catch (error) {
  console.error(`FALHOU: ${error.message}`);
  cleanup(1);
}
