// Página de convite (GET /j/<código>): o link que o host manda. Tenta abrir o app (bo1z://join/<código>?s=<servidor>)
// sozinha e por um botão; se o app não abrir, explica o que fazer (instalar pelos links de DOWNLOAD_WIN_URL /
// DOWNLOAD_MAC_URL, se configurados, ou digitar o código no app). Visual de menu do Black Ops, feito só com CSS (sem
// fontes nem imagens de terceiros). Tudo que vem da URL ou do ambiente é validado e escapado; a CSP só deixa rodar o
// script desta página (nonce).
import { normalizeRoomCode } from './room.js';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const escapeHtml = value => String(value).replace(/[&<>"'`]/g, c => ENTITIES[c]);

// Só http(s) absoluto; qualquer outra coisa (javascript:, data:, lixo) vira null.
export function safeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

// host[:porta] da origem pública do servidor (vai no ?s= do link do app, para ele achar a sinalização).
export function serverHost(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : '';
  } catch { return ''; }
}

// Origem pública usada nos convites: PUBLIC_ORIGIN (domínio próprio) se configurada e válida, senão a da requisição.
export function publicOrigin(env, fallback) {
  const configured = safeHttpUrl(env?.PUBLIC_ORIGIN);
  return configured ? new URL(configured).origin : fallback;
}

// '/j/<código>' (barra final opcional) -> o segmento decodificado; null se não for uma rota de convite. O código em si
// é validado em invitePage (segmento inválido vira a página de convite inválido, com 404).
export function invitePath(pathname) {
  const m = /^\/j\/([^/]*)\/?$/.exec(pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

export function deepLink(code, origin) {
  return `bo1z://join/${code}?s=${encodeURIComponent(serverHost(origin))}`;
}

const makeNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));

const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<rect width="64" height="64" fill="#0a0a0a"/>'
  + '<path d="M14 14h36v8L26 44h24v8H14v-8l24-22H14z" fill="#ff7a1a"/></svg>');

const STYLE = `
:root { color-scheme: dark; --bg: #050505; --fg: #f1f1f1; --dim: #8f8f8f; --text: #cfcfcf; --accent: #ff7a1a;
  --accent-hi: #ffa24d; --band: rgba(255, 255, 255, .15); --line: rgba(255, 255, 255, .12);
  /* condensada do próprio sistema: Bahnschrift (Windows 10+), Avenir Next Condensed (macOS), outras se houver */
  --condensed: "Bahnschrift", "Avenir Next Condensed", "Oswald", "Roboto Condensed", "Arial Narrow",
    "Liberation Sans Narrow", "DejaVu Sans Condensed", "Helvetica Neue", Arial, sans-serif; }
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 28px 16px;
  color: var(--fg); background: radial-gradient(110% 70% at 50% -10%, rgba(255, 122, 26, .13), transparent 60%),
  radial-gradient(ellipse at 50% 45%, #151515 0%, #070707 62%, #020202 100%);
  font-family: var(--condensed); font-stretch: condensed; text-transform: uppercase; letter-spacing: .04em; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(255, 255, 255, .022) 0 1px, transparent 1px 3px); }
main { position: relative; width: 100%; max-width: 580px; }
.brand { color: var(--dim); font-size: 13px; letter-spacing: .32em; }
h1 { margin: 6px 0 0; font-size: clamp(34px, 9vw, 56px); line-height: .95; font-weight: 700; letter-spacing: .015em; }
h1 em { font-style: normal; color: var(--accent); }
.rule { height: 2px; margin: 16px 0 18px;
  background: linear-gradient(90deg, var(--accent), rgba(255, 122, 26, .25) 45%, transparent); }
p, li { text-transform: none; letter-spacing: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text); font-size: 15px; line-height: 1.55; }
p { margin: 0 0 14px; }
.room { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  margin: 4px 0 18px; padding: 12px 16px; border: 1px solid var(--line); border-left: 3px solid var(--accent);
  background: rgba(0, 0, 0, .55); }
.room small { display: block; color: var(--dim); font-size: 12px; letter-spacing: .3em; }
.room b { display: block; font-size: clamp(36px, 10vw, 48px); line-height: 1.05; letter-spacing: .22em; color: #fff;
  font-family: var(--condensed); font-variant-numeric: tabular-nums; }
.menu { margin: 0 0 6px; }
.menu a, .menu button { display: block; width: 100%; margin: 0; padding: 9px 14px; border: 0;
  border-left: 3px solid transparent;
  background: none; color: var(--fg); font: inherit; font-size: 26px; line-height: 1.15; text-align: left;
  text-decoration: none; letter-spacing: .05em; cursor: pointer; }
.menu a:hover, .menu a:focus-visible, .menu button:hover, .menu button:focus-visible { outline: none;
  border-left-color: var(--accent);
  background: linear-gradient(90deg, var(--band), rgba(255, 255, 255, .04) 70%, transparent); }
.menu .primary { color: var(--accent-hi); font-size: 34px; border-left-color: rgba(255, 122, 26, .55);
  background: linear-gradient(90deg, rgba(255, 255, 255, .08), transparent 70%); }
.menu .small { font-size: 18px; color: #d8d8d8; }
.status { min-height: 1.5em; margin: 2px 0 18px 17px; color: var(--dim); font-size: 14px; letter-spacing: .08em; }
.status.ok { color: #9fe07a; }
.help { padding: 14px 16px 4px; border: 1px solid var(--line); background: rgba(0, 0, 0, .45);
  transition: border-color .3s; }
.help.show { border-color: var(--accent); }
.help h2 { margin: 0 0 8px; font-size: 20px; letter-spacing: .08em; color: #fff; }
.help ol { margin: 0 0 12px; padding-left: 20px; }
.help strong { color: #fff; }
.downloads { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0 4px; }
.downloads a { padding: 7px 14px; border: 1px solid var(--line); color: var(--fg); text-decoration: none;
  font-size: 16px;
  letter-spacing: .08em; font-family: var(--condensed); text-transform: uppercase; }
.downloads a:hover, .downloads a:focus-visible, .downloads a.mine { border-color: var(--accent);
  color: var(--accent-hi); outline: none; }
.mobile { display: none; margin: 0 0 16px; padding: 10px 14px; border-left: 3px solid var(--accent-hi);
  background: rgba(255, 122, 26, .08); }
body.is-mobile .mobile { display: block; }
footer { margin-top: 26px; color: #5f5f5f; font-size: 12px; letter-spacing: .12em; }
@media (max-width: 420px) { .menu a, .menu button { font-size: 22px; } .menu .primary { font-size: 28px; } }
@media (prefers-reduced-motion: reduce) { .help { transition: none; } }
`;

// Tenta abrir o app ao carregar (no celular não: o app é de computador). Se a página continuar visível e com foco
// depois de 2,5 s, o sistema provavelmente não conhece bo1z:// (app não instalado ou nunca aberto): mostra a ajuda.
// No Firefox um esquema desconhecido em location vira página de erro; lá a tentativa automática vai por um iframe.
const SCRIPT = `
(() => {
  const open = document.getElementById('open'), status = document.getElementById('status');
  const help = document.getElementById('help'), copy = document.getElementById('copy');
  const ua = navigator.userAgent, mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (mobile) document.body.classList.add('is-mobile');
  const os = /Windows/i.test(ua) ? 'win' : /Mac/i.test(ua) ? 'mac' : '';
  if (os) document.querySelector('.downloads a[data-os="' + os + '"]')?.classList.add('mine');
  if (copy) copy.addEventListener('click', async () => {
    const code = copy.dataset.code;
    try { await navigator.clipboard.writeText(code); copy.textContent = 'Código copiado'; }
    catch { copy.textContent = 'Código: ' + code; }
    setTimeout(() => { copy.textContent = 'Copiar código'; }, 2500);
  });
  if (!open) return;
  let away = false, timer = 0;
  addEventListener('blur', () => { away = true; });
  addEventListener('pagehide', () => { away = true; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) away = true; });
  function attempt(auto) {
    away = false;
    status.className = 'status';
    status.textContent = 'Abrindo o BO1 Zombies… se o navegador perguntar, permita abrir o app.';
    if (auto && /Firefox\\//.test(ua)) {
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = open.href;
      document.body.append(frame);
    } else location.href = open.href;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (away || document.hidden) {
        status.className = 'status ok';
        status.textContent = 'Convite entregue ao app. Pode fechar esta aba.';
      } else {
        status.textContent = 'O app não abriu? Veja abaixo.';
        help.classList.add('show');
      }
    }, 2500);
  }
  open.addEventListener('click', event => { event.preventDefault(); attempt(false); });
  if (!mobile) setTimeout(() => attempt(true), 400);
})();
`;

function downloadsHtml(env) {
  const links = [['win', 'Windows', env.DOWNLOAD_WIN_URL], ['mac', 'Mac', env.DOWNLOAD_MAC_URL]]
    .map(([os, label, url]) => [os, label, safeHttpUrl(url)])
    .filter(([, , url]) => url)
    .map(([os, label, url]) =>
      `<a href="${escapeHtml(url)}" data-os="${os}" rel="noopener noreferrer">Baixar para ${label}</a>`);
  return links.length
    ? `<li>Instale o <strong>BO1 Zombies</strong> (só na primeira vez):
      <div class="downloads">${links.join('')}</div></li>`
    : '<li>Instale o <strong>BO1 Zombies</strong> (só na primeira vez): peça o instalador para quem te convidou.</li>';
}

// { status, headers, body }. origin = origem pública do servidor (https://bo1z-signal.<conta>.workers.dev).
export function invitePage({ code: rawCode, origin, env = {}, nonce = makeNonce() }) {
  const code = normalizeRoomCode(rawCode);
  const host = serverHost(origin);
  const title = code ? `Convite: sala ${code} no BO1 Zombies` : 'Convite inválido: BO1 Zombies';
  const description = code ? 'Clique para entrar na partida co-op de zombies.' : 'Este link de convite não é válido.';
  const content = code ? `
    <div class="brand">BO1 Zombies · Co-op</div>
    <h1>Convite para <em>Zombies</em></h1>
    <div class="rule"></div>
    <p>Chamaram você para uma partida co-op. Com o BO1 Zombies instalado, é só entrar.</p>
    <div class="room">
      <div><small>Sala</small><b>${escapeHtml(code)}</b></div>
    </div>
    <p class="mobile">Abra este link no computador onde o BO1 Zombies está instalado.</p>
    <nav class="menu">
      <a id="open" class="primary" href="${escapeHtml(deepLink(code, origin))}">Entrar na partida</a>
      <button id="copy" class="small" type="button" data-code="${escapeHtml(code)}">Copiar código</button>
    </nav>
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <section id="help" class="help">
      <h2>O app não abriu?</h2>
      <ol>
        ${downloadsHtml(env)}
        <li>Abra o app uma vez (isso registra o link) e clique em <strong>Entrar na partida</strong> de novo.</li>
        <li>Ou, no app: <strong>Jogar com amigos</strong> → <strong>Entrar com código</strong> → digite
          <strong>${escapeHtml(code)}</strong>.</li>
      </ol>
    </section>` : `
    <div class="brand">BO1 Zombies · Co-op</div>
    <h1>Convite <em>inválido</em></h1>
    <div class="rule"></div>
    <p>Este link de convite não é válido. Peça um link novo para quem te chamou (no app:
      <strong>Jogar com amigos</strong> → <strong>Copiar convite</strong>).</p>
    <section class="help"><h2>Tem o código?</h2><ol>${downloadsHtml(env)}
      <li>No app: <strong>Jogar com amigos</strong> → <strong>Entrar com código</strong>.</li></ol></section>`;

  const body = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#050505">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="BO1 Zombies">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="${escapeHtml(ICON)}">
<style nonce="${escapeHtml(nonce)}">${STYLE}</style>
</head>
<body>
<main>${content}
    <footer>Servidor de salas: ${escapeHtml(host || '?')}</footer>
</main>
${code ? `<script nonce="${escapeHtml(nonce)}">${SCRIPT}</script>` : ''}
</body>
</html>
`;
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; `
      + "img-src data:; frame-src bo1z:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
    'Cache-Control': 'no-store',
  };
  return { status: code ? 200 : 404, headers, body };
}
