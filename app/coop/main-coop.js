// Co-op no processo principal: serve os módulos da página (https://vel.gg/__bo1z/coop/ e /__bo1z/lobby/), analisa o
// wasm (layout dos rings), garante o patch N1 no glue, e — quando esta máquina é convidado de uma partida — serve o
// engine.js e o wasm do convidado (estratégia shadow + patch G1). O estado da sala, os transportes (WebRTC na janela
// net, UDP no modo por IP) e a API do lobby ficam em session.js. Sem sala, tudo isto é inerte (o jogo solo não muda).
//
// config.json: "coop": { "signal": "https://bo1z-signal.<conta>.workers.dev", "port": 27960, "name": "" }
// Modo antigo por ambiente (scripts de teste): BO1Z_COOP=host|guest, BO1Z_COOP_HOST, BO1Z_COOP_PORT, BO1Z_COOP_BIND,
// BO1Z_COOP_CODE, BO1Z_COOP_NAME, BO1Z_COOP_START (guestStart). BO1Z_SIGNAL troca o servidor de convite.
//
// guestStart (testado com o motor real em 2026-10-09):
//   shadow (padrão): o convidado sobe o mesmo mapa com servidor local ("+devmap <mapa>") e logo em seguida
//            "+connect localhost:3074". O servidor local fica de pé (o motor só o derruba para o texto exato
//            "localhost") e fornece o que o cliente deste motor lê direto do servidor: zombiemode, árvores de
//            animação, configstrings, entidades do BSP. O cliente ignora o servidor local (porta 0; patch G1) e aceita o
//            host (porta 524, o tag que a ponte grava); depois a ponte pausa o servidor local (sv_paused).
//   connect: "+connect localhost" no lugar do devmap (sem servidor local). Não funciona neste motor: sem servidor,
//            zombiemode fica 0 (tabelas de rede diferentes) e o CL_DownloadsComplete compila scripts de servidor MP.
//   manual:  sobe solo; "connect localhost:3074" depois, pelo console (tools/console.mjs 9335 …).
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoopSession } = require('./session.js');
const { inviteAddresses } = require('./udp.js');

const MODULES = new Set(['page.mjs', 'netbridge.mjs', 'ring.mjs', 'layout.mjs', 'bridge-worker.mjs']); // wasmpatch/wasmscan/gluepatch ficam no main
const GLUE = 'KisakBlack-web.mjs', WASM = 'KisakBlack-web.wasm';
const LOBBY_CALLS = new Set(['getState', 'create', 'join', 'connectByAddress', 'leave', 'setMap', 'setReady', 'start', 'copyInvite']);

// URL do servidor de convite embutida no app (scripts/set-signal.sh grava depois do deploy do signal/): assim o app do
// convidado já sai sabendo para onde ir. config.json e BO1Z_SIGNAL têm prioridade.
function builtinSignal() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'defaults.json'), 'utf8')).signal || ''; } catch { return ''; }
}

function coopSettings(config, env = process.env) {
  const c = { role: 'off', port: 27960, bind: '0.0.0.0', host: '', code: '', name: '', maxGuests: 3, guestStart: 'shadow',
    ...(config.coop ?? {}) };
  c.signal = c.signal || builtinSignal();
  if (env.BO1Z_COOP) c.role = env.BO1Z_COOP;
  if (env.BO1Z_COOP_HOST) c.host = env.BO1Z_COOP_HOST;
  if (env.BO1Z_COOP_PORT) c.port = Number(env.BO1Z_COOP_PORT);
  if (env.BO1Z_COOP_BIND) c.bind = env.BO1Z_COOP_BIND;
  if (env.BO1Z_COOP_CODE) c.code = env.BO1Z_COOP_CODE;
  if (env.BO1Z_COOP_NAME) c.name = env.BO1Z_COOP_NAME;
  if (env.BO1Z_COOP_START) c.guestStart = env.BO1Z_COOP_START;
  if (env.BO1Z_SIGNAL) c.signal = env.BO1Z_SIGNAL;
  if (!['host', 'guest'].includes(c.role)) c.role = 'off';
  if (!c.name) c.name = os.hostname().split('.')[0].slice(0, 32);
  return c;
}

// Patches do engine.js do site no convidado (texto original, em tempo de execução; âncora que não bate = não aplica):
//  shadow/connect: muda os argumentos do motor logo antes de state.arguments = args (depois de todos os splices que
//           usam indexOf('+devmap')). O pack do mapa continua montado pela página como num jogo solo.
//  noquit:  a página sai do jogo quando vê "Com_ERROR: PLATFORM_DISCONNECTED_FROM_SERVER"; ao trocar de servidor o
//           convidado pode passar por isso, então no convidado a página não sai sozinha (Cmd+M volta ao menu).
function patchEngineForGuest(text, strategy) {
  const applied = [], once = (from, to, label) => {
    const n = text.split(from).length - 1;
    if (n !== 1) throw new Error(`engine.js ${label}: âncora encontrada ${n}x`);
    text = text.replace(from, to);
    applied.push(label);
  };
  if (strategy === 'connect' || strategy === 'shadow') {
    if (!text.includes("'+devmap', mapId")) throw new Error(`engine.js ${strategy}: sem +devmap`);
    const splice = strategy === 'connect' ? "args.splice(at, 2, '+connect', 'localhost')" : "args.splice(at + 2, 0, '+connect', 'localhost:3074')";
    once('state.arguments = args;', "if (globalThis.__bo1zCoopGuest) { const at = args.indexOf('+devmap'); " +
      `if (at >= 0) ${splice}; } state.arguments = args;`, strategy);
  }
  try {
    once("if (/Com_ERROR:\\s*PLATFORM_DISCONNECTED_FROM_SERVER/.test(message)) quit('disconnect');",
      "if (/Com_ERROR:\\s*PLATFORM_DISCONNECTED_FROM_SERVER/.test(message)) { if (!globalThis.__bo1zCoopGuest) quit('disconnect'); }", 'noquit');
  } catch { /* opcional */ }
  return { text, applied };
}

function setupCoop({ config, log, logDir, gameUrl, appDir = path.join(__dirname, '..'), home }) {
  const { ipcMain, MessageChannelMain, net, clipboard, BrowserWindow, powerSaveBlocker, webContents: allContents } = require('electron');
  const settings = coopSettings(config);
  const coopLog = path.join(logDir, `coop${process.env.BO1Z_PROFILE ? '-' + process.env.BO1Z_PROFILE : ''}.log`);
  const clog = (what, msg) => fs.appendFile(coopLog, `${new Date().toISOString()} [${what}] ${msg}\n`, () => {});
  const fetchText = async url => { const r = await net.fetch(url, { bypassCustomProtocolHandlers: true }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
  const session = new CoopSession({
    deps: { BrowserWindow, MessageChannelMain, clipboard, ipcMain, fetchText },
    appDir, log: clog, gameUrl, signalUrl: settings.signal, udpPort: settings.port,
    prefsFile: home ? path.join(home, `coop${process.env.BO1Z_PROFILE ? '-' + process.env.BO1Z_PROFILE : ''}.json`) : null,
  });
  let esm = null, layout = null;
  const loadEsm = () => (esm ??= Promise.all([import('./gluepatch.mjs'), import('./wasmscan.mjs'), import('./wasmpatch.mjs')])
    .then(([g, w, p]) => ({ applyN1: g.applyN1, N1_MARK: g.N1_MARK, scanWasm: w.scanWasm, patchGuestWasm: p.patchGuestWasm })));

  async function scan(bytes, source) {
    const { scanWasm } = await loadEsm();
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    layout = { ...scanWasm(bytes), sha, source };
    clog('wasm', `${source} sha256 ${sha.slice(0, 16)}…: ${layout.ok ? `rings em ${layout.layout.base}, ${layout.producers} produtores` : `co-op desligado: ${layout.reason}`}`);
    return layout;
  }

  const gameHost = new URL(gameUrl).hostname;
  const lobbyDir = path.join(appDir, 'lobby');
  const serveFile = (file, type) => new Response(fs.readFileSync(file), { status: 200, headers: {
    'content-type': type, 'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' } });
  const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

  // Chamado pelo handler https do main.js antes de qualquer outra coisa. Devolve Response ou null (segue o fluxo normal).
  async function handle(request, url) {
    if (url.hostname !== gameHost) return null;
    if (url.pathname.startsWith('/__bo1z/coop/')) {
      const name = url.pathname.slice('/__bo1z/coop/'.length);
      if (!MODULES.has(name)) return new Response('not found', { status: 404 });
      return serveFile(path.join(__dirname, name), TYPES['.mjs']);
    }
    if (url.pathname.startsWith('/__bo1z/lobby/')) {
      const name = url.pathname.slice('/__bo1z/lobby/'.length);
      const file = path.join(lobbyDir, name);
      if (!/^[a-z0-9_-]+\.[a-z0-9]+$/i.test(name) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
      return serveFile(file, TYPES[path.extname(name)] ?? 'application/octet-stream');
    }
    const role = session.gameRole();
    if (!role) return null; // jogo solo: nada muda
    const file = url.pathname.split('/').pop();
    if (file === WASM && url.pathname.includes('/artifacts/')) {
      const original = await net.fetch(request, { bypassCustomProtocolHandlers: true });
      if (!original.ok || request.headers.get('range')) return original;
      let body = Buffer.from(await original.arrayBuffer());
      await scan(body, 'página');
      if (role === 'guest' && session.guestStart() === 'shadow') {
        const { patchGuestWasm } = await loadEsm();
        const p = patchGuestWasm(body);
        clog('wasm', `patches do convidado: ${p.applied.map(a => a.label).join(', ') || 'nenhum'}${p.errors.length ? ` — falhas: ${p.errors.join('; ')}` : ''}`);
        if (!p.errors.length) body = Buffer.from(p.buf.buffer, p.buf.byteOffset, p.buf.byteLength);
        else if (layout) layout = { ...layout, ok: false, reason: `wasm do convidado sem patch: ${p.errors.join('; ')}` };
      }
      const headers = new Headers(original.headers);
      for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
      return new Response(body, { status: original.status, headers });
    }
    if (file === 'engine.js' && role === 'guest') {
      const original = await net.fetch(request, { bypassCustomProtocolHandlers: true });
      if (!original.ok) return original;
      const text = await original.text();
      const headers = new Headers(original.headers);
      for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
      try {
        const patched = patchEngineForGuest(text, session.guestStart());
        clog('engine', `engine.js do convidado: ${patched.applied.join(', ') || 'sem patch'} (${session.guestStart()})`);
        return new Response(patched.text, { status: 200, headers });
      } catch (error) {
        clog('engine', `${error.message}; convidado sobe solo (+devmap).`);
        return new Response(text, { status: 200, headers });
      }
    }
    return null;
  }

  // Glue final (patcheado ou original): sempre com N1 (o lobby pode abrir uma sala a qualquer momento; N1 é inerte).
  async function finishGlue(text) {
    const { applyN1, N1_MARK } = await loadEsm();
    if (text.includes(N1_MARK)) return text;
    try { return applyN1(text); } catch (error) { clog('glue', `N1 não aplicado: ${error.message}`); return text; }
  }

  // Página do jogo pediu o port de pacotes (preload, a cada navegação, só quando há partida de co-op).
  ipcMain.on('bo1z:coop-hello', event => { if (session.gameRole()) session.attachPage(event.sender); });
  ipcMain.on('bo1z:coop-active', (event, role) => session.pageActive(role));
  ipcMain.handle('bo1z:coop-layout', async () => {
    if (!session.gameRole()) return { ok: false, reason: 'sem partida de co-op' };
    if (layout) return layout;
    // A página pode ter tirado o wasm de um cache sem passar pelo protocolo: baixa e analisa aqui.
    const response = await net.fetch(new URL(`artifacts/${WASM}`, gameUrl).href, { bypassCustomProtocolHandlers: true });
    if (!response.ok) return { ok: false, reason: `wasm HTTP ${response.status}` };
    return scan(Buffer.from(await response.arrayBuffer()), 'main');
  });
  // API do lobby (§3): chamadas da página e estado empurrado para todas as páginas do vel.gg.
  ipcMain.handle('bo1z:lobby-call', async (event, { fn, args } = {}) => {
    if (!LOBBY_CALLS.has(fn)) throw new Error(`chamada desconhecida: ${fn}`);
    return session[fn](...(Array.isArray(args) ? args : []));
  });
  // Com sala aberta o sistema não suspende o app (App Nap no Mac, economia de energia no Windows): um host suspenso
  // congela o servidor e derruba os convidados. A tela ainda pode apagar.
  let blocker = null;
  session.on('state', state => {
    const busy = ['connecting', 'lobby', 'starting', 'playing'].includes(state.phase);
    if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!busy && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  });
  session.on('state', state => {
    for (const wc of allContents.getAllWebContents()) {
      try { if (!wc.isDestroyed() && new URL(wc.getURL()).hostname === gameHost) wc.send('bo1z:lobby-state', state); } catch { /* sem URL ainda */ }
    }
  });

  // Nome no placar do jogo e, no host, sv_timeout 30 (padrão do motor: 240 s), para quem cai sumir logo.
  const engineName = () => (session.getState().name || settings.name).replace(/[^A-Za-z0-9_.\- ]/g, '').trim().slice(0, 15) || 'Player';
  const withCoopCommands = commands => {
    const role = session.gameRole();
    if (!role) return commands;
    return { ...commands, '*': [...(commands?.['*'] ?? []), '+set', 'name', engineName(), ...(role === 'host' ? ['+set', 'sv_timeout', '30'] : [])] };
  };

  // Para o preload (bo1z:config, a cada página): papel do co-op nesta página e se ela deve começar sozinha.
  function preloadInfo(pageUrl) {
    const role = session.gameRole(), state = session.getState();
    let autostart = false;
    try { autostart = state.phase === 'starting' && !!state.map && new URL(pageUrl).pathname.replace(/\/$/, '').endsWith('/' + state.map.slug); } catch { /* sem URL */ }
    return { lobby: true, coop: role ? { role, guestStart: session.guestStart() } : null, autostart };
  }

  return {
    session, settings, handle, finishGlue, clog, glueName: GLUE, withCoopCommands, preloadInfo,
    get active() { return !!session.gameRole(); },
    onReady: () => session.refreshMaps(), // net.fetch só depois do app pronto
    // Linha de console da página que começa com BO1Z_COOP: vai para o log do co-op.
    consoleLine: message => { if (message.startsWith('BO1Z_COOP')) clog('página', message.slice(10, 4000)); },
    invite: () => session.getState().invite,
    copyInvite: () => session.copyInvite(),
    logFile: coopLog,
    close: () => session.close(),
  };
}

module.exports = { setupCoop, coopSettings, patchEngineForGuest, inviteAddresses };
