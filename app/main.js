// BO1 Zombies.app: janela própria (Electron) para o port WebAssembly do vel.gg.
// Mac: perfil e cache dos packs ficam na imagem APFS do SSD externo (nada de jogo no disco interno).
// Windows: tudo em %LOCALAPPDATA%/BO1 Zombies (zip portátil, ver scripts/package-windows.sh; os packs são grandes demais
// para o AppData "Roaming").
const { app, BrowserWindow, Menu, dialog, ipcMain, net, session, shell } = require('electron');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_MAC = process.platform === 'darwin';
const IMAGE = '/Volumes/SSD/Games/HighballGames.sparseimage';
const VOLUME = '/Volumes/HighballGames';
// BO1Z_HOME troca a pasta inteira (testes); BO1Z_PROFILE=<nome> usa outro perfil do Chromium na mesma pasta (segunda
// instância no mesmo computador, ex.: convidado do teste local de co-op), com trava de instância única própria.
const HOME = process.env.BO1Z_HOME ?? (IS_MAC ? path.join(VOLUME, 'bo1z') : path.join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'BO1 Zombies'));
const PROFILE = process.env.BO1Z_PROFILE ?? '';
const SUFFIX = PROFILE ? '-' + PROFILE : '';
const CONFIG_FILE = path.join(HOME, 'config.json');
const LOG_FILE = path.join(HOME, 'logs', `game${SUFFIX}.log`);
const PERF_FILE = path.join(HOME, 'logs', `perf${SUFFIX}.jsonl`);

// commands: dvars por mapa (zone), entram antes do +devmap. devmap liga sv_cheats, então dvars de cheat valem.
const DEFAULT_CONFIG = {
  url: 'https://vel.gg/bo1z/',
  // serve o glue do motor (KisakBlack-web.mjs) com os patches de patches/manifest.json; no Windows fica desligado até
  // medir os patches de desempenho em D3D12 (spec §6)
  patches: IS_MAC,
  renderScale: 1, // pixels de render por pixel da janela (o site usa até 2x no Retina, limitado a 1920 de largura)
  debugPort: 9334, // DevTools só em 127.0.0.1: telemetria e comandos de console ao vivo
  volume: 0.3, // volume inicial do jogo (0 a 1) em mapas onde você ainda não mexeu no slider de Options
  webgpuFast: false,
  commands: {
    '*': [], // todos os mapas
    zombie_coast: ['+set', 'r_fog', '0'], // Call of the Dead sem névoa
  },
  // co-op (app/coop/): "signal" = servidor de convite (signal/README.md); "port" = porta UDP do modo "por IP"
  coop: { signal: '', port: 27960 },
};

function mountGamesImage() {
  if (!IS_MAC || process.env.BO1Z_HOME || fs.existsSync(VOLUME)) return;
  if (!fs.existsSync(IMAGE)) {
    dialog.showErrorBox('BO1 Zombies', `SSD externo não conectado (${IMAGE}).`);
    app.exit(1);
  }
  execFileSync('/usr/bin/hdiutil', ['attach', IMAGE, '-noverify', '-quiet']);
}

function loadConfig() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (error) {
    log('config', `config.json inválido, usando o padrão: ${error.message}`);
    return DEFAULT_CONFIG;
  }
}

function log(source, message) {
  fs.appendFile(LOG_FILE, `${new Date().toISOString()} [${source}] ${message}\n`, () => {});
}

mountGamesImage();
app.setPath('userData', path.join(HOME, 'profile' + SUFFIX));
const config = loadConfig();
const coop = require('./coop/main-coop.js').setupCoop({ config, log, logDir: path.dirname(LOG_FILE), gameUrl: config.url, home: HOME });

// Desempenho: GPU sem blocklist, nada de throttling quando a janela perde foco ou fica coberta.
for (const flag of ['ignore-gpu-blocklist', 'disable-background-timer-throttling',
  'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows'])
  app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '6144');
// WebRTC do co-op: candidatos com o IP local de verdade (sem mDNS), para dois jogadores na mesma casa ligarem direto.
require('./net/net-window.js').applyNetSwitches(app);
// WebGPU (Dawn): o jogo só manda comandos já validados no Chrome, então a validação por chamada e os bounds checks
// dos shaders são custo puro de CPU/GPU aqui. "webgpuFast": true no config.json liga (no A/B não ajudou).
if (config.webgpuFast) app.commandLine.appendSwitch('enable-dawn-features', 'skip_validation,disable_robustness');
const debugPort = process.env.BO1Z_DEBUG_PORT ?? config.debugPort;
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', String(debugPort));
}

// Links de convite: bo1z://join/<código>?s=<servidor> (e bo1z://ip/<endereço>/<código>). Mac: open-url; Windows/Linux:
// o link chega no argv (da primeira instância ou repassado pela segunda, via second-instance).
const pendingLinks = process.argv.filter(a => a.startsWith('bo1z://'));
if (!process.env.BO1Z_HOME) { // BO1Z_HOME = teste: não registra o protocolo no sistema
  if (process.defaultApp) app.setAsDefaultProtocolClient('bo1z', process.execPath, [path.resolve(process.argv[1] ?? '.')]);
  else app.setAsDefaultProtocolClient('bo1z');
}
function openLink(url) {
  if (!win) { pendingLinks.push(url); return; }
  if (win.isMinimized()) win.restore();
  win.focus();
  coop.session.handleLink(url).then(ok => { if (ok && !/\/bo1z\/?$/.test(new URL(win.webContents.getURL() || config.url).pathname)) win.loadURL(config.url); })
    .catch(error => log('link', error.message));
}
app.on('open-url', (event, url) => { event.preventDefault(); openLink(url); });

if (!app.requestSingleInstanceLock()) app.quit();

// Relido a cada página: mudanças no config.json valem ao entrar no próximo mapa, sem reiniciar o app.
ipcMain.on('bo1z:config', event => {
  Object.assign(config, loadConfig());
  const info = coop.preloadInfo(event.sender.getURL());
  event.returnValue = { commands: coop.withCoopCommands(config.commands), volume: config.volume, renderScale: config.renderScale,
    muted: process.env.BO1Z_MUTE === '1', coop: info.coop, lobby: info.lobby, autostart: info.autostart };
});

ipcMain.on('bo1z:perf', (event, summary) => {
  fs.appendFile(PERF_FILE, JSON.stringify(summary) + '\n', () => {});
});

// Glue patcheado: só substitui quando o original servido pelo site tem exatamente o sha256 contra o qual os patches
// foram feitos; se o vel.gg atualizar o motor, o original passa intacto.
const PATCH_DIR = path.join(__dirname, 'patches');
function installGluePatches() {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(PATCH_DIR, 'manifest.json'), 'utf8')); } catch { return; }
  // Arquivos extras por pack: patches/packs/<slug>/<caminho no pack>. Entram no manifest.json do mapa (o worker
  // de download confere tamanho e sha256 de cada um) e são servidos por nós quando o worker os pede (CDN ou site).
  const extras = {};
  const packsDir = path.join(PATCH_DIR, 'packs');
  const walk = (dir, rel) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name), rel + d.name + '/') : [rel + d.name]);
  for (const slug of fs.existsSync(packsDir) ? fs.readdirSync(packsDir) : []) {
    extras[slug] = walk(path.join(packsDir, slug), '').map(rel => {
      const bytes = fs.readFileSync(path.join(packsDir, slug, rel));
      return { rel, bytes, entry: { path: rel, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        kind: 'loose', priority: 'boot', class: 'boot' } };
    });
  }
  session.defaultSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    const coopResponse = await coop.handle(request, url);
    if (coopResponse) return coopResponse;
    const name = url.pathname.split('/').pop();
    for (const [slug, files] of Object.entries(extras)) {
      const hit = files.find(f => url.pathname.endsWith('/' + slug + '/' + f.rel) || url.pathname.endsWith('/' + slug + '/pack/' + f.rel));
      if (hit) {
        // O worker confere Content-Length (e Content-Range na retomada) contra o tamanho do manifest.
        const from = Number(/bytes=(\d+)-/.exec(request.headers.get('range') ?? '')?.[1] ?? 0);
        const body = hit.bytes.subarray(from), size = hit.bytes.length;
        const headers = { 'content-type': 'text/plain', 'content-length': String(body.length),
          'access-control-allow-origin': 'https://vel.gg', 'access-control-expose-headers': 'Content-Length, Content-Range',
          'cross-origin-resource-policy': 'cross-origin' };
        if (from) headers['content-range'] = `bytes ${from}-${size - 1}/${size}`;
        return new Response(body, { status: from ? 206 : 200, headers });
      }
      if (url.hostname === 'vel.gg' && url.pathname.endsWith('/' + slug + '/manifest.json')) {
        const original = await net.fetch(request, { bypassCustomProtocolHandlers: true });
        if (!original.ok) return original;
        const manifest = await original.json();
        for (const f of files) {
          if (manifest.files.some(e => e.path === f.rel)) continue;
          manifest.files.push(f.entry);
          manifest.total_bytes += f.entry.size;
          if (manifest.class_bytes) manifest.class_bytes.boot += f.entry.size;
        }
        const headers = new Headers(original.headers);
        for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
        return new Response(JSON.stringify(manifest), { status: 200, headers });
      }
    }
    const isGlue = name === coop.glueName && request.url.includes('/artifacts/');
    const entry = config.patches && request.url.includes('/artifacts/') ? manifest[name] : null;
    // O glue sempre passa por aqui: o co-op precisa do patch N1 (inerte sem sala), mesmo com patches: false.
    if (!entry && !isGlue) return net.fetch(request, { bypassCustomProtocolHandlers: true });
    const original = await net.fetch(request, { bypassCustomProtocolHandlers: true });
    if (!original.ok) return original;
    const body = Buffer.from(await original.arrayBuffer());
    const headers = new Headers(original.headers);
    for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
    let text = body;
    if (entry && crypto.createHash('sha256').update(body).digest('hex') !== entry.original)
      log('patch', `${name}: original mudou no site, servindo sem patch`);
    else if (entry && fs.existsSync(path.join(PATCH_DIR, entry.patched))) text = fs.readFileSync(path.join(PATCH_DIR, entry.patched));
    else if (entry) log('patch', `${name}: ${entry.patched} não existe (rode node patches/build-glue.mjs), servindo sem patch`);
    if (isGlue) text = await coop.finishGlue(text.toString('utf8'));
    return new Response(text, { status: entry || isGlue ? 200 : original.status, headers });
  });
}

let win;
function createWindow() {
  const gameOrigin = new URL(config.url).origin;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(new URL(details.requestingUrl).origin === gameOrigin));

  win = new BrowserWindow({
    width: 1280, height: 760, center: true, backgroundColor: '#000000', title: 'BO1 Zombies',
    // Sem tela cheia nativa do macOS (que abre outra mesa): o botão verde só maximiza e o "Fullscreen" do jogo
    // preenche a própria janela.
    fullscreenable: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, spellcheck: false,
    },
  });
  if (process.env.BO1Z_MUTE === '1') win.webContents.setAudioMuted(true);

  // Só o site do jogo abre na janela; qualquer outro link vai pro navegador padrão.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== gameOrigin) { event.preventDefault(); shell.openExternal(url); }
  });

  // Só as linhas de estatística do pipe WebGPU do motor (pipelines que bloquearam = engasgo); o resto do console é ignorado.
  win.webContents.on('console-message', ({ message }) => {
    if (message.startsWith('WEB_GPU')) fs.appendFile(PERF_FILE, JSON.stringify({ t: Date.now(), gpu: message.slice(0, 2000) }) + '\n', () => {});
    else coop.consoleLine(message);
  });
  win.webContents.on('render-process-gone', async (event, details) => {
    log('crash', JSON.stringify(details));
    const { response } = await dialog.showMessageBox(win, {
      type: 'error', message: 'O jogo caiu', detail: `Motivo: ${details.reason} (código ${details.exitCode}). Log: ${LOG_FILE}`,
      buttons: ['Recarregar', 'Sair'],
    });
    if (response === 0) win.loadURL(config.url); else app.quit();
  });

  win.loadURL(config.url);
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'BO1 Zombies', submenu: IS_MAC ? [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] : [{ role: 'quit' }] },
  { label: 'Jogo', submenu: [
    { label: 'Menu de mapas', accelerator: 'CmdOrCtrl+M', click: () => win?.loadURL(config.url) },
    { role: 'reload' }, ...(IS_MAC ? [{ role: 'zoom' }] : []), { role: 'toggleDevTools' },
  ] },
  { label: 'Co-op', submenu: [
    { label: 'Copiar convite', click: async () => { const text = await coop.copyInvite(); dialog.showMessageBox(win, { message: text ? `Convite copiado:\n${text}` : 'Nenhuma sala aberta. Use JOGAR COM AMIGOS na tela de mapas.' }); } },
    { label: 'Sair da sala', click: () => coop.session.leave() },
    { label: 'Abrir log do co-op', click: () => shell.openPath(coop.logFile) },
  ] },
]));

app.on('second-instance', (event, argv) => {
  const link = argv.find(a => a.startsWith('bo1z://'));
  if (link) openLink(link);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
// O host iniciou a partida (ou o convidado recebeu o início): a janela vai para a página do mapa.
coop.session.on('navigate', ({ url }) => win?.loadURL(url));
app.whenReady().then(() => {
  installGluePatches(); createWindow(); coop.onReady();
  for (const link of pendingLinks.splice(0)) openLink(link);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => coop.close());
