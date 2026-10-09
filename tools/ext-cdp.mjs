// Chromium com a extensão carregada, guiado pelo DevTools (para tools/ext-smoke.mjs e tools/ext-e2e.mjs).
// Processo em grupo próprio: close() mata o grupo inteiro (Chromium e todos os filhos), nunca sobra órfão.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export const CHROME = process.env.BO1Z_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// headless 'new' (padrão) ou com tela (xvfb: true -> xvfb-run -a). Áudio mudo, GPU por SwiftShader, janela pequena.
export async function launchChrome({ extension, profile, port, xvfb = false, extraArgs = [], log = () => {} }) {
  mkdirSync(profile, { recursive: true });
  const args = ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--no-first-run',
    '--no-default-browser-check', '--mute-audio', '--window-size=640,400', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', ...(xvfb ? [] : ['--headless=new']), ...extraArgs, 'about:blank'];
  const [cmd, argv] = xvfb ? ['xvfb-run', ['-a', '-s', '-screen 0 1024x700x24', CHROME, ...args]] : [CHROME, args];
  const proc = spawn(cmd, argv, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
  const close = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* já saiu */ } };
  process.once('exit', close);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { close(); process.exit(130); });
  for (let i = 0; i < 100; ++i) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); log(`chromium no ar (pid ${proc.pid})`); return { proc, port, close, stderr: () => stderr }; }
    catch { await sleep(200); }
  }
  close();
  throw new Error(`Chromium não abriu o DevTools na porta ${port}: ${stderr.slice(-1500)}`);
}

export const targets = port => fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());

export async function waitTarget(port, match, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const t = (await targets(port).catch(() => [])).find(match);
    if (t) return t;
    if (Date.now() - t0 > ms) throw new Error('alvo do DevTools não apareceu');
    await sleep(250);
  }
}

// Conexão a um alvo (página, offscreen, service worker). onConsole(line) recebe o console do alvo.
export async function attach(target, { onConsole = null } = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0, closed = false;
  const pending = new Map(), events = new Map();
  ws.onclose = () => { closed = true; for (const r of pending.values()) r({ error: { message: 'fechado' } }); pending.clear(); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const fn of events.get(m.method) ?? []) fn(m.params);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('falha no WebSocket do DevTools')); });
  const send = (method, params = {}) => new Promise(resolve => {
    if (closed) return resolve({ error: { message: 'fechado' } });
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const on = (method, fn) => { if (!events.has(method)) events.set(method, []); events.get(method).push(fn); };
  const evaluate = async (expression, timeoutMs = 120000) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => ({ error: { message: `avaliação passou de ${timeoutMs} ms` } }))]);
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  if (onConsole) {
    on('Runtime.consoleAPICalled', p => onConsole(p.args.map(a => a.value ?? a.description ?? '').join(' ')));
    await send('Runtime.enable');
  }
  return { send, on, evaluate, close: () => ws.close(), get closed() { return closed; } };
}

// Página do vel.gg (a aba inicial): navega e espera o documento.
export async function navigate(page, url) {
  await page.send('Page.enable');
  await page.send('Page.navigate', { url });
}

// ---- página do vel.gg

export async function waitEval(page, expression, ms = 30000) {
  const t = Date.now();
  while (!(await page.evaluate(expression, 5000).catch(() => false))) {
    if (Date.now() - t > ms) throw new Error(`esperando ${expression}`);
    await sleep(100);
  }
}

export async function waitUrl(page, cond, ms = 30000) {
  const t = Date.now();
  for (;;) {
    const url = await page.evaluate('location.href').catch(() => '');
    if (cond(url)) return url;
    if (Date.now() - t > ms) throw new Error(`a aba não navegou (${url})`);
    await sleep(100);
  }
}

// Estado do jogo e do co-op na aba (sem lançar: erro vira { error }).
export async function probe(page) {
  return page.evaluate(`(() => { const f = globalThis.five, c = globalThis.__bo1zCoop;
    return { screen: document.body?.dataset.screen ?? null, load: f?.load ?? null, kb: !!globalThis.__bo1zKB,
      coop: c ? { mode: c.mode ?? 'página', stats: c.stats?.() ?? null } : null, ext: globalThis.__bo1zExt?.timings ?? null,
      connecting: (c?.handshake ?? []).some(l => /out (getchallenge|connect)/.test(l)),
      mapLoaded: f?.timings?.mapLoaded ?? null, errors: (f?.errors ?? []).slice(-3) }; })()`, 20000).catch(error => ({ error: error.message }));
}

// Clica no botão do site ("Click to start" / jogar) como um jogador.
export async function clickPlay(page) {
  const box = await page.evaluate(`(() => { const b = document.getElementById('play')?.getBoundingClientRect();
    return b && b.width ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null; })()`);
  if (!box) return false;
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}
