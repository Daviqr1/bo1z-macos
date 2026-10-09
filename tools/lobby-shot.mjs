// Fotos e conferência do lobby (app/lobby/) na página de verdade do vel.gg, sem o app: abre https://vel.gg/bo1z/ no
// Chromium headless, serve app/lobby/* em https://vel.gg/__bo1z/lobby/ (interceptação do DevTools, como o main faz),
// instala um __bo1zLobby FALSO com o estado de cada cena, monta o lobby como o preload e salva um PNG por cena.
// Cada cena também confere o DOM (textos, foco, teclado, chamadas à API); se algo não bater, sai com código 1.
//
// Uso: node tools/lobby-shot.mjs [--out <pasta>] [--only <trecho do nome>] [--chrome <binário>]
// Saída padrão: $BO1Z_SHOTS ou <tmp>/bo1z-lobby-shots. Proxy: usa $HTTPS_PROXY se houver.
// Na página do mapa, wasm/glue/packs/vídeos são bloqueados: só a página e o indicador aparecem (o motor não sobe).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lobbyDir = path.join(root, 'app', 'lobby');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const OUT = path.resolve(arg('--out', process.env.BO1Z_SHOTS ?? path.join(tmpdir(), 'bo1z-lobby-shots')));
const ONLY = arg('--only', '');
const CHROMES = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'];
const CHROME = arg('--chrome', process.env.CHROME ?? CHROMES.find(p => existsSync(p)));
const LANDING = 'https://vel.gg/bo1z/', MAP_PAGE = 'https://vel.gg/bo1z/cotd';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- estados de exemplo (formato do State do docs/COOP-ARCH.md §3)
const MAPS = [
  { zone: 'zombie_theater', slug: 'kino', name: 'Kino der Toten' },
  { zone: 'zombie_pentagon', slug: 'five', name: 'Five' },
  { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' },
];
const COTD = MAPS[2];
const INVITE = 'https://bo1z-signal.exemplo.workers.dev/j/K7QX2';
const blank = { phase: 'idle', mode: null, role: null, room: null, invite: null, you: null, map: null, peers: [],
  signal: 'n/a', error: null, name: 'Davi', maps: MAPS };
const GUEST1 = { id: 'g1aaaaaa', name: 'Irmão', role: 'guest', ready: true, ping: 24, link: 'direct', loss: 0 };
const GUEST2 = { id: 'g2bbbbbb', name: 'Primo do Rio', role: 'guest', ready: false, ping: 87, link: 'relay', loss: 1.2 };
const HOST = { id: 'h0st0000', name: 'Davi', role: 'host', ready: true, ping: 32, link: 'direct', loss: 0 };
const hostLobby = { ...blank, phase: 'lobby', mode: 'webrtc', role: 'host', room: 'K7QX2', invite: INVITE,
  you: { id: HOST.id, name: 'Davi' }, map: COTD, signal: 'online', peers: [GUEST1, GUEST2] };
const guestLobby = { ...blank, phase: 'lobby', mode: 'webrtc', role: 'guest', room: 'K7QX2', invite: INVITE,
  you: { id: GUEST1.id, name: 'Irmão', ready: true }, map: COTD, signal: 'online',
  peers: [HOST, { ...GUEST2, ping: 140, loss: 4 }] };
const EVIL = '<img src=x onerror=1>Zé'; // 23 caracteres: cabe no limite de 24 do nome

// Atalhos no contexto da página (o bootScript define): __q(seletor), __all(seletor), __text(seletor), __called(nome).
const closed = `__q('#bo1z-lobby .bz-backdrop').hidden`;
const called = (fn, test = 'true') => `__lobbyCalls().some(c => c[0] === '${fn}' && (${test}))`;

// ---- cenas: estado inicial, página, tamanho, passos (cada passo pode clicar, digitar, conferir e fotografar)
const SCENES = [
  { name: '01-menu-item', state: blank, steps: [
    ['check', 'item no menu', `__text('#bo1z-coop-item')?.includes('JOGAR COM AMIGOS')`],
    ['check', 'painel fechado', closed],
    ['shot'],
    ['hover', '#bo1z-coop-item'], ['wait', 150], ['shot', '02-menu-item-realce'],
    ['eval', `document.activeElement?.blur()`],
    ['key', 'ArrowUp'],
    ['check', 'primeira seta vai para a linha realçada (Kino)', `document.activeElement?.dataset.pick === 'kino'`],
    ['key', 'ArrowUp'],
    ['check', 'seta para cima a partir do Kino dá a volta até o HELL MODE', `document.activeElement?.id === 'horde-toggle'`],
    ['key', 'ArrowUp'],
    ['check', 'e depois o item JOGAR COM AMIGOS', `document.activeElement?.id === 'bo1z-coop-item'`],
    ['key', 'Enter'], ['wait', 300],
    ['check', 'Enter no item abre o painel', `!${closed} && __lobbyHandle.view === 'home'`],
    ['check', 'foco dentro do painel', `!!document.activeElement?.closest('.bz-panel')`],
    ['check', 'nome salvo no campo', `__q('[data-nav=name]').value === 'Davi'`],
    ['check', 'arte do mapa do site', `__q('#bo1z-lobby img.bz-art-img')?.src.startsWith('${LANDING}art/mapselect-panel-')`],
    ['check', 'granulado (SVG embutido no CSS) decodifica', `(async () => {
      const bg = getComputedStyle(__q('.bz-panel'), '::before').backgroundImage;
      const img = new Image(); img.src = bg.slice(5, -2); await img.decode(); return img.width === 180; })()`],
    ['wait', 600], ['shot', '03-painel-inicial'],
    ['key', 'ArrowRight'], ['wait', 50],
    ['check', 'setas ←→ não trocam o mapa fora do seletor', `__lobbyCalls().length === 0`],
    ['eval', `window.__mapa = __text('.bz-cycle-value')`],
    ['focus', '[data-nav=map]'], ['key', 'ArrowRight'], ['wait', 300],
    ['check', '→ no seletor troca o mapa e mantém o foco',
      `__text('.bz-cycle-value') !== window.__mapa && document.activeElement?.dataset.nav === 'map'`],
    ['click', '[data-nav=create]'], ['wait', 200],
    ['check', 'CRIAR SALA chama create com nome e mapa', called('create', `c[1].name === 'Davi' && /^zombie_/.test(c[1].map)`)],
    ['key', 'Escape'], ['wait', 100],
    ['check', 'Esc fecha o painel', `${closed} && document.activeElement?.id === 'bo1z-coop-item'`],
  ] },
  { name: '04-host-2-convidados', state: hostLobby, steps: [
    ['wait', 400],
    ['check', 'convite pendente: painel abre sozinho na sala', `__lobbyHandle.view === 'room'`],
    ['check', '4 linhas no grupo (host + 2 convidados + vaga)', `__all('.bz-member').length === 4 && __all('.bz-empty').length === 1`],
    ['check', 'selos DIRETO e RELAY', `__all('.bz-badge').map(b => b.textContent).join() === 'DIRETO,RELAY'`],
    ['check', 'ping em ms', `__all('.bz-ping').map(b => b.textContent).join() === '24 ms,87 ms'`],
    ['check', 'código da sala', `__text('.bz-code') === 'K7QX2'`],
    ['check', 'selo da sala no item do menu', `__text('.bz-item-badge') === 'SALA K7QX2 · 3/4'`],
    ['wait', 700], ['shot'],
    ['click', '[data-nav=start]'], ['wait', 250],
    ['check', 'iniciar com convidado não pronto pede confirmação', `!__q('.bz-confirm').hidden && !${called('start')}`],
    ['shot', '05-confirmar-inicio'],
    ['key', 'Escape'], ['wait', 100],
    ['check', 'Esc cancela a confirmação', `__q('.bz-confirm').hidden && __lobbyHandle.view === 'room'`],
    ['click', '[data-nav=copy]'], ['wait', 200],
    ['check', 'COPIAR CONVITE mostra copiado', `__text('[data-nav=copy]').includes('COPIADO')`],
    ['shot', '06-convite-copiado'],
    ['set', { peers: [GUEST1, { ...GUEST2, ready: true, ping: 95 }] }], ['wait', 200],
    ['click', '[data-nav=start]'], ['wait', 200],
    ['check', 'todos prontos: inicia direto', `${called('start')} && __q('.bz-confirm').hidden`],
    ['set', { peers: [{ ...GUEST1, name: EVIL }] }], ['wait', 200],
    ['check', 'nome da rede entra como texto (sem HTML)',
      `__all('.bz-name-text')[1]?.textContent === ${JSON.stringify(EVIL)} && !__q('#bo1z-lobby img[src=x]')`],
  ] },
  { name: '07-host-sozinho', state: { ...hostLobby, peers: [] }, steps: [
    ['wait', 500],
    ['check', 'INICIAR apagado sem convidado pronto', `__q('[data-nav=start]').hasAttribute('data-dim')`],
    ['click', '[data-nav=start]'], ['wait', 200],
    ['check', 'pede confirmação para iniciar sozinho', `__text('.bz-confirm h3') === 'INICIAR SOZINHO?'`],
    ['shot'],
    ['click', '.bz-confirm [data-nav=yes]'], ['wait', 200],
    ['check', 'confirmado: start', called('start')],
  ] },
  { name: '08-convidado-aguardando', state: guestLobby, steps: [
    ['wait', 600],
    ['check', 'convidado vê PRONTO: SIM e não vê INICIAR', `__text('[data-nav=ready]')?.includes('SIM') && !__q('[data-nav=start]')`],
    ['check', 'convidado não troca o mapa', `!__q('[data-nav=map]')`],
    ['shot'],
    ['click', '[data-nav=ready]'], ['wait', 150],
    ['check', 'PRONTO chama setReady(false)', called('setReady', 'c[1] === false')],
  ] },
  { name: '09-erro-sala-cheia', state: { ...blank, phase: 'error', mode: 'webrtc', role: 'guest', room: 'K7QX2',
    error: { code: 'room-full', message: 'A sala está cheia (até 4 jogadores).' } }, steps: [
    ['wait', 500],
    ['check', 'tela de erro com SALA CHEIA', `__lobbyHandle.view === 'error' && __text('.bz-alert-title') === 'SALA CHEIA'`],
    ['shot'],
    ['click', '[data-nav=back]'], ['wait', 150],
    ['check', 'VOLTAR sai da sala', called('leave')],
  ] },
  { name: '10-sem-servidor', state: { ...blank, phase: 'error', mode: 'webrtc', role: 'host',
    error: { code: 'no-signal', message: 'Servidor de convite não configurado.' } }, steps: [
    ['wait', 500],
    ['check', 'explica o modo por IP', `__text('.bz-alert').includes('POR IP') && !!__q('[data-nav=fix]')`],
    ['shot'],
  ] },
  { name: '11-entrar-codigo', state: blank, steps: [
    ['click', '#bo1z-coop-item'], ['wait', 200], ['click', '[data-nav=join]'], ['wait', 150],
    ['focus', '[data-nav=code]'], ['type', 'k7q0x'], ['key', 'Enter'], ['wait', 150],
    ['check', 'código com 0 é recusado aqui mesmo', `__text('.bz-error')?.includes('0, O, 1, I nem L') && !${called('join')}`],
    ['check', 'o foco volta para o campo', `document.activeElement?.dataset.nav === 'code'`],
    ['shot'],
    ['focus', '[data-nav=code]'], ['select'], ['type', 'https://bo1z-signal.exemplo.workers.dev/j/k7qx2'],
    ['key', 'Enter'], ['wait', 150],
    ['check', 'link colado vira código', called('join', `c[1].code === 'K7QX2'`)],
    ['key', 'Escape'], ['wait', 80],
    ['check', 'Esc volta ao início', `__lobbyHandle.view === 'home'`],
  ] },
  { name: '12-por-ip', state: blank, steps: [
    ['click', '#bo1z-coop-item'], ['wait', 200], ['click', '[data-nav=ip]'], ['wait', 150],
    ['focus', '[data-nav=address]'], ['type', '100.101.7.9:27960 · código ZUMBI'], ['wait', 50], ['shot'],
    ['click', '[data-nav=ip-go]'], ['wait', 150],
    ['check', 'convite do modo por IP colado: endereço e código', called('connectByAddress',
      `c[1].address === '100.101.7.9:27960' && c[1].code === 'ZUMBI' && c[1].role === 'guest'`)],
  ] },
  { name: '13-ip-host-lan', state: { ...hostLobby, mode: 'udp', invite: '192.168.0.10:27960 · código ZUMBI', room: 'ZUMBI',
    signal: 'n/a', you: { id: 'host', name: 'Davi' },
    peers: [{ id: 1, name: 'Irmão', role: 'guest', ready: true, ping: 0.6, link: 'lan', loss: null }] }, steps: [
    ['wait', 600],
    ['check', 'selo LAN e ping menor que 1 ms', `__text('.bz-badge') === 'LAN' && __text('.bz-ping') === '<1 ms'`],
    ['shot'],
  ] },
  { name: '14-mapa-indicador', page: MAP_PAGE, state: { ...hostLobby, phase: 'playing' }, steps: [
    ['wait', 1500],
    ['check', 'indicador com 2 amigos', `!__q('#bo1z-coop-hud').hidden && __all('#bo1z-coop-hud .bz-hud-row').length === 2`],
    ['check', 'sem aviso para o host com todos ligados', `__q('#bo1z-coop-notice').hidden`],
    ['check', 'sem item de menu na página do mapa', `!__q('#bo1z-coop-item')`],
    ['shot'],
    ['set', { peers: [GUEST1] }], ['wait', 300],
    ['check', 'quem sai vira aviso', `__text('#bo1z-coop-notice .bz-notice-title')?.includes('PRIMO DO RIO SAIU')`],
    ['shot', '15-mapa-amigo-saiu'],
  ] },
  { name: '16-mapa-conectando', page: MAP_PAGE, state: { ...guestLobby, phase: 'starting' }, steps: [
    ['wait', 1500],
    ['check', 'convidado vê Conectando ao host…', `__text('#bo1z-coop-notice .bz-notice-title') === 'CONECTANDO AO HOST…'`],
    ['shot'],
    ['set', { phase: 'playing' }], ['wait', 200],
    ['check', 'aviso some em playing', `__q('#bo1z-coop-notice').hidden`],
    ['set', { peers: [{ ...HOST, link: 'lost', ping: null }] }], ['wait', 200],
    ['check', 'host caiu: aviso claro', `__text('#bo1z-coop-notice .bz-notice-title') === 'A CONEXÃO COM O HOST CAIU'`],
    ['shot', '17-mapa-host-caiu'],
  ] },
  { name: '18-janela-pequena', size: [640, 400], state: hostLobby, steps: [
    ['wait', 700],
    ['check', 'painel ocupa a janela',
      `(() => { const r = __q('.bz-panel').getBoundingClientRect(); return r.width >= 630 && r.height >= 390; })()`],
    ['shot'],
  ] },
  { name: '19-sem-api', api: false, state: blank, steps: [
    ['wait', 400],
    ['check', 'sem __bo1zLobby nada é montado',
      `__lobbyHandle === null && !__q('#bo1z-lobby') && !__q('#bo1z-lobby-css')`],
  ] },
];

// Script injetado antes de qualquer script da página: o __bo1zLobby falso (registra as chamadas, devolve o State) e a
// montagem igual à do preload.
function bootScript(state, withApi) {
  return `(() => {
    if (location.hostname !== 'vel.gg') return;
    let state = ${JSON.stringify(state)};
    const listeners = new Set(), calls = [];
    const copy = () => JSON.parse(JSON.stringify(state));
    const emit = () => { const s = copy(); for (const cb of listeners) cb(s); };
    Object.assign(globalThis, {
      __q: s => document.querySelector(s), __all: s => [...document.querySelectorAll(s)],
      __text: s => document.querySelector(s)?.textContent ?? null,
      __lobbyCalls: () => calls, __lobbySet: patch => { state = { ...state, ...patch }; emit(); },
    });
    const call = name => async (...args) => {
      calls.push([name, ...JSON.parse(JSON.stringify(args))]);
      return name === 'copyInvite' ? state.invite : copy();
    };
    if (${withApi}) globalThis.__bo1zLobby = Object.freeze({
      getState: async () => copy(),
      onState: cb => { listeners.add(cb); return () => listeners.delete(cb); },
      create: call('create'), join: call('join'), connectByAddress: call('connectByAddress'), leave: call('leave'),
      setMap: call('setMap'), setReady: call('setReady'), start: call('start'), copyInvite: call('copyInvite'),
    });
    const mount = () => import(location.origin + '/__bo1z/lobby/lobby.mjs')
      .then(m => {
        globalThis.__lobbyHandle = m.mountLobby({ api: globalThis.__bo1zLobby, document, location });
        globalThis.__lobbyMounted = true;
      })
      .catch(error => console.log('BO1Z_COOP lobby indisponível: ' + error.message));
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  })();`;
}

// ---- Chromium e DevTools
async function launch() {
  if (!CHROME) throw new Error('Chromium não encontrado (use --chrome <binário>)');
  const profile = mkdtempSync(path.join(tmpdir(), 'bo1z-lobby-shot-'));
  // WebGL2 por software (SwiftShader): a página do mapa mostra a tela normal em vez de "Unsupported graphics"
  const args = ['--headless=new', '--no-sandbox', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--no-first-run', '--disable-background-networking', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--window-size=1280,720',
    ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`] : []), 'about:blank'];
  // grupo de processos próprio: no fim mata o grupo inteiro (o Chromium e os filhos dele)
  const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const kill = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* já saiu */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ok */ }
  };
  process.on('exit', kill);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { kill(); process.exit(130); });
  let err = '';
  const ws = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chromium não abriu o DevTools: ${err.slice(-400)}`)), 20000);
    child.stderr.on('data', d => {
      err += d;
      const m = /DevTools listening on (ws:\S+)/.exec(err);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', code => reject(new Error(`Chromium saiu (${code}): ${err.slice(-400)}`)));
  });
  // fim: mata o grupo e espera o Chromium sair de fato (nada órfão)
  const stop = async () => {
    kill();
    await Promise.race([exited, sleep(5000)]);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ok */ }
  };
  return { port: new URL(ws).port, stop };
}

async function openPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools: falha no WebSocket')); });
  let id = 0;
  const pending = new Map(), handlers = new Map();
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    handlers.get(m.method)?.(m.params);
  };
  const send = (method, params = {}) => new Promise(resolve => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, on: (method, fn) => handlers.set(method, fn), close: () => ws.close() };
}

const TYPES = { '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const BLOCK = /\/artifacts\/|\/pack\/|cdn\.vel\.gg|\.(?:mp4|webm|br)(?:\?|$)|download-worker/;
const KEYS = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Tab: 9 };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const cdp = await openPage(browser.port);
  const log = [], shots = [];
  let failures = 0;
  cdp.on('Runtime.consoleAPICalled', p => log.push(p.args.map(a => a.value ?? a.description).join(' ')));
  cdp.on('Runtime.exceptionThrown', p => log.push(`exceção: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
  // Serve app/lobby/* como o main (mesmos cabeçalhos de COEP/CORP) e bloqueia o que só o motor usaria.
  cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const url = new URL(request.url);
    if (url.hostname === 'vel.gg' && url.pathname.startsWith('/__bo1z/lobby/')) {
      const name = url.pathname.slice('/__bo1z/lobby/'.length), file = path.join(lobbyDir, name);
      if (!/^[a-z0-9_-]+\.[a-z0-9]+$/i.test(name) || !existsSync(file))
        return cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: Buffer.from('not found').toString('base64') });
      const headers = { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
      return cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, body: readFileSync(file).toString('base64'),
        responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) });
    }
    if (BLOCK.test(request.url)) return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    return cdp.send('Fetch.continueRequest', { requestId });
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Fetch.enable', { patterns: ['*://vel.gg/__bo1z/lobby/*', '*/artifacts/*', '*/pack/*', '*://cdn.vel.gg/*',
    '*.mp4*', '*.webm*'].map(urlPattern => ({ urlPattern })) });

  const evaluate = async expression => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? ex.text);
    return r.result?.result?.value;
  };
  const until = async (expression, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await evaluate(expression)) return true; } catch { /* página ainda carregando */ }
      await sleep(100);
    }
    return false;
  };
  const center = selector => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})
    ?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const key = async name => {
    const base = { key: name, code: name, windowsVirtualKeyCode: KEYS[name], nativeVirtualKeyCode: KEYS[name] };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(name === 'Enter' ? { text: '\r' } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const mouse = async (selector, click) => {
    const at = await center(selector);
    if (!at) throw new Error(`sem elemento ${selector}`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    if (!click) return;
    for (const type of ['mousePressed', 'mouseReleased'])
      await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  };
  let scriptId = null;

  for (const scene of SCENES) {
    if (ONLY && !scene.name.includes(ONLY)) continue;
    const [width, height] = scene.size ?? [1280, 720];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (scriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript(scene.state, scene.api !== false) });
    scriptId = added.result.identifier;
    log.length = 0;
    await cdp.send('Page.navigate', { url: scene.page ?? LANDING });
    const mounted = await until(`globalThis.__lobbyMounted === true && document.readyState === 'complete'
      && !document.querySelector('#bo1z-lobby[data-loading]')`);
    if (!mounted) { failures++; console.log(`✗ ${scene.name}: lobby não montou. Console: ${log.slice(-5).join(' | ')}`); continue; }
    await evaluate('document.fonts.ready.then(() => true)');
    for (const [kind, a, b] of scene.steps) {
      try {
        if (kind === 'wait') await sleep(a);
        else if (kind === 'set') await evaluate(`__lobbySet(${JSON.stringify(a)}), true`);
        else if (kind === 'eval') await evaluate(`(${a}), true`);
        else if (kind === 'key') await key(a);
        else if (kind === 'type') await cdp.send('Input.insertText', { text: a });
        else if (kind === 'select') await evaluate('document.activeElement?.select?.(), true');
        else if (kind === 'focus') await evaluate(`document.querySelector(${JSON.stringify(a)}).focus(), true`);
        else if (kind === 'hover' || kind === 'click') await mouse(a, kind === 'click');
        else if (kind === 'check') {
          const pass = await evaluate(b);
          console.log(`${pass ? '✓' : '✗'} ${scene.name}: ${a}`);
          if (!pass) failures++;
        } else if (kind === 'shot') {
          await until(`[...document.querySelectorAll('#bo1z-lobby img')].every(img => img.complete)`, 5000);
          const file = path.join(OUT, `${a ?? scene.name}.png`);
          const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(file, Buffer.from(r.result.data, 'base64'));
          shots.push(file);
        }
      } catch (error) { failures++; console.log(`✗ ${scene.name}: passo ${kind} ${a ?? ''}: ${error.message}`); }
    }
    const errors = log.filter(line => /exceção|erro|indisponível/i.test(line));
    if (errors.length) { failures++; console.log(`✗ ${scene.name}: console: ${errors.join(' | ')}`); }
  }
  cdp.close();
  await browser.stop();
  console.log(`\n${shots.length} fotos em ${OUT}:\n${shots.map(f => '  ' + f).join('\n')}`);
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo certo');
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
