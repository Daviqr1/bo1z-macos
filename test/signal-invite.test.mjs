// Página de convite da sinalização (signal/src/invite.js): conteúdo, escape de tudo que vem de fora, CSP e, se houver
// um Chromium na máquina (BO1Z_CHROME ou o do Playwright), a página de verdade rodando sob a CSP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  deepLink, escapeHtml, invitePage, invitePath, publicOrigin, safeHttpUrl, serverHost,
} from '../signal/src/invite.js';
import { startDevServer } from '../signal/dev-server.mjs';

const ORIGIN = 'https://bo1z-signal.exemplo.workers.dev';

test('convite válido: pt-BR, código, link do app com o servidor, CSP com nonce, sem recursos externos', () => {
  const page = invitePage({ code: 'k7qx2', origin: ORIGIN, nonce: 'abc123' });
  assert.equal(page.status, 200);
  const { body, headers } = page;
  assert.match(headers['Content-Type'], /text\/html; charset=utf-8/);
  assert.match(headers['Content-Security-Policy'],
    /default-src 'none'; style-src 'nonce-abc123'; script-src 'nonce-abc123'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(body.includes('<html lang="pt-BR">'));
  assert.ok(body.includes('<b>K7QX2</b>'));
  assert.ok(body.includes('href="bo1z://join/K7QX2?s=bo1z-signal.exemplo.workers.dev"'));
  assert.ok(body.includes('<script nonce="abc123">'));
  assert.ok(body.includes('<style nonce="abc123">'));
  assert.ok(body.includes('Entrar com código'));
  assert.ok(body.includes('peça o instalador')); // sem links de download configurados
  assert.ok(!/\son[a-z]+=/i.test(body), 'sem handlers inline (a CSP bloquearia)');
  assert.ok(!/\sstyle=/i.test(body), 'sem style inline (a CSP bloquearia)');
  assert.ok(!/(src|href)="https?:/i.test(body), 'nada carregado de fora');
  assert.match(body, /og:title" content="Convite: sala K7QX2 no BO1 Zombies"/);
  // nonce novo a cada página
  assert.notEqual(/nonce-([^']+)/.exec(invitePage({ code: 'K7QX2', origin: ORIGIN }).headers['Content-Security-Policy'])[1],
    /nonce-([^']+)/.exec(invitePage({ code: 'K7QX2', origin: ORIGIN }).headers['Content-Security-Policy'])[1]);
});

test('convite: links de download só se forem http(s) válidos, escapados', () => {
  const env = { DOWNLOAD_WIN_URL: 'https://exemplo.com/BO1 Zombies.zip?a=1&b="2"', DOWNLOAD_MAC_URL: 'javascript:alert(1)' };
  const { body } = invitePage({ code: 'K7QX2', origin: ORIGIN, env });
  assert.ok(body.includes('href="https://exemplo.com/BO1%20Zombies.zip?a=1&amp;b=%222%22" data-os="win"'));
  assert.ok(!body.includes('javascript:'));
  assert.ok(!body.includes('data-os="mac"'));
  const urls = { DOWNLOAD_WIN_URL: 'https://a.example/w', DOWNLOAD_MAC_URL: 'https://a.example/m' };
  const both = invitePage({ code: 'K7QX2', origin: ORIGIN, env: urls }).body;
  assert.ok(both.includes('Baixar para Windows') && both.includes('Baixar para Mac'));
});

test('convite inválido e tentativas de XSS: 404, nada da URL na página, sem script', () => {
  for (const code of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', 'K7QX0', '', 'K7QX2K7QX2', null]) {
    const page = invitePage({ code, origin: ORIGIN });
    assert.equal(page.status, 404, String(code));
    assert.ok(!page.body.includes('<script'), String(code));
    assert.ok(!page.body.includes('alert(1)'), String(code));
    assert.ok(!page.body.includes('<img'), String(code));
    assert.ok(!page.body.includes('bo1z://'), String(code));
    assert.ok(page.body.includes('Convite <em>inválido</em>'));
  }
  // origem esquisita (Host forjado no servidor local) não vira HTML
  const evil = invitePage({ code: 'K7QX2', origin: 'http://x"><script>alert(1)</script>' }).body;
  assert.ok(!evil.includes('<script>alert'));
  assert.ok(evil.includes('href="bo1z://join/K7QX2?s="'));
});

test('utilitários: escape, URLs, host, rota /j/, origem pública', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&\`</a>`),
    '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;');
  assert.equal(safeHttpUrl(' https://a.example/x '), 'https://a.example/x');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://a', 'nada', '', null, 5]) {
    assert.equal(safeHttpUrl(bad), null);
  }
  assert.equal(serverHost('http://127.0.0.1:8787'), '127.0.0.1:8787');
  assert.equal(serverHost('javascript:alert(1)'), '');
  assert.equal(serverHost('lixo'), '');
  assert.equal(deepLink('K7QX2', 'http://[::1]:8787'), 'bo1z://join/K7QX2?s=%5B%3A%3A1%5D%3A8787');
  assert.equal(invitePath('/j/K7QX2'), 'K7QX2');
  assert.equal(invitePath('/j/K7QX2/'), 'K7QX2');
  assert.equal(invitePath('/j/%3Cb%3E'), '<b>');
  assert.equal(invitePath('/j/%E0%A4%A'), ''); // % malformado
  assert.equal(invitePath('/j/'), '');
  assert.equal(invitePath('/j/a/b'), null);
  assert.equal(invitePath('/health'), null);
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: 'https://salas.exemplo.com/x' }, 'http://x'), 'https://salas.exemplo.com');
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: 'javascript:1' }, 'http://x'), 'http://x');
  assert.equal(publicOrigin({}, 'http://x'), 'http://x');
});

// ---- no navegador de verdade ----

const CHROME = [process.env.BO1Z_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(p => p && existsSync(p));

test('Chromium: a página roda sob a CSP, tenta abrir o app e mostra a ajuda quando ele não abre',
  { skip: !CHROME && 'sem Chromium' }, async () => {
  const dev = await startDevServer({ env: { DOWNLOAD_WIN_URL: 'https://exemplo.com/win.zip' } });
  const profile = mkdtempSync(join(tmpdir(), 'bo1z-invite-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const browserWs = await new Promise((resolve, reject) => {
      let err = '';
      chrome.stderr.on('data', d => {
        err += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) resolve(m[1]);
      });
      chrome.once('exit', code => reject(new Error(`Chromium saiu (${code}): ${err.slice(-500)}`)));
      setTimeout(() => reject(new Error('Chromium não abriu o DevTools')), 15000);
    });
    const port = new URL(browserWs).port;
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let id = 0;
    const pending = new Map(), problems = [];
    ws.on('message', data => {
      const m = JSON.parse(data);
      if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(JSON.stringify(m.params.args));
      const entry = m.method === 'Log.entryAdded' ? m.params.entry : null;
      if (entry && /Content Security Policy|Refused/.test(entry.text)) problems.push(entry.text);
    });
    const send = (method, params = {}) => new Promise(resolve => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async expression =>
      (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: `${dev.url}/j/K7QX2` });
    // 0,4 s até a tentativa + 2,5 s de espera; com folga para máquina lenta
    for (let t0 = Date.now(); Date.now() - t0 < 15000; await new Promise(r => setTimeout(r, 250))) {
      if (await evaluate(`document.getElementById('help')?.classList.contains('show') ?? false`)) break;
    }
    const state = await evaluate(`({
      help: document.getElementById('help').className,
      status: document.getElementById('status').textContent,
      href: document.getElementById('open').href,
      url: location.href,
      mine: document.querySelector('.downloads a.mine')?.dataset.os ?? null,
      font: getComputedStyle(document.querySelector('h1')).textTransform,
    })`);
    ws.close();
    assert.deepEqual(problems, [], 'sem erros nem bloqueios da CSP');
    assert.equal(state.url, `${dev.url}/j/K7QX2`); // continua na página (o esquema não está registrado aqui)
    assert.equal(state.href, `bo1z://join/K7QX2?s=${encodeURIComponent(new URL(dev.url).host)}`);
    assert.match(state.help, /\bshow\b/);
    assert.match(state.status, /não abriu/);
    assert.equal(state.font, 'uppercase'); // o CSS (com nonce) foi aplicado
  } finally {
    const exited = chrome.exitCode !== null ? null : new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGKILL');
    await exited; // o perfil só pode ser apagado depois que o Chromium parou de escrever nele
    await dev.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
