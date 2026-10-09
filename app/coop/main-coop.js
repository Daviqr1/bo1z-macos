// Co-op no processo principal: sala (host/convidado) via UDP (udp.js), módulos da página servidos em
// https://vel.gg/__bo1z/coop/, análise do wasm (layout dos rings), patch N1 do glue em tempo de execução e, no
// convidado, troca de "+devmap <mapa>" por "+connect localhost" no engine.js do site. Tudo inerte com role 'off'.
//
// config.json: "coop": { "role": "off"|"host"|"guest", "port": 27960, "bind": "0.0.0.0", "host": "100.x.y.z:27960",
//                        "code": "", "name": "", "maxGuests": 3, "guestStart": "connect"|"manual" }
// Variáveis de ambiente têm prioridade: BO1Z_COOP (role), BO1Z_COOP_HOST, BO1Z_COOP_PORT, BO1Z_COOP_BIND,
// BO1Z_COOP_CODE, BO1Z_COOP_NAME, BO1Z_COOP_START (guestStart).
//
// guestStart (testado com o motor real em 2026-10-09):
//   shadow (padrão): o convidado sobe o mesmo mapa com servidor local ("+devmap <mapa>") e logo em seguida
//            "+connect localhost:3074". O servidor local fica de pé (o motor só o derruba para o texto exato
//            "localhost") e fornece o que o cliente deste motor lê direto do servidor: zombiemode, árvores de
//            animação, configstrings, entidades do BSP. O cliente ignora o servidor local (porta 0) e aceita o host
//            (porta 524, o tag que a ponte grava).
//   connect: "+connect localhost" no lugar do devmap (sem servidor local). Não funciona neste motor: sem servidor,
//            zombiemode fica 0 (tabelas de rede diferentes) e o CL_DownloadsComplete compila scripts de servidor MP.
//   manual:  sobe solo; "connect localhost:3074" depois, pelo console (tools/console.mjs 9335 …).
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoopHost, CoopGuest, bindPage, roomCode } = require('./udp.js');

const MODULES = new Set(['page.mjs', 'netbridge.mjs', 'ring.mjs', 'layout.mjs']); // servidos à página (wasmpatch/wasmscan/gluepatch ficam no main)
const GLUE = 'KisakBlack-web.mjs', WASM = 'KisakBlack-web.wasm';

function coopSettings(config, env = process.env) {
  const c = { role: 'off', port: 27960, bind: '0.0.0.0', host: '', code: '', name: '', maxGuests: 3, guestStart: 'shadow',
    ...(config.coop ?? {}) };
  if (env.BO1Z_COOP) c.role = env.BO1Z_COOP;
  if (env.BO1Z_COOP_HOST) c.host = env.BO1Z_COOP_HOST;
  if (env.BO1Z_COOP_PORT) c.port = Number(env.BO1Z_COOP_PORT);
  if (env.BO1Z_COOP_BIND) c.bind = env.BO1Z_COOP_BIND;
  if (env.BO1Z_COOP_CODE) c.code = env.BO1Z_COOP_CODE;
  if (env.BO1Z_COOP_NAME) c.name = env.BO1Z_COOP_NAME;
  if (env.BO1Z_COOP_START) c.guestStart = env.BO1Z_COOP_START;
  if (!['host', 'guest'].includes(c.role)) c.role = 'off';
  if (!c.name) c.name = os.hostname().split('.')[0].slice(0, 32);
  return c;
}

// Endereços para o convite: Tailscale (100.64.0.0/10) primeiro, depois IPv4 da rede local.
function inviteAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const [x, y] = a.address.split('.').map(Number);
    out.push({ address: a.address, tailscale: x === 100 && y >= 64 && y < 128 });
  }
  out.sort((a, b) => b.tailscale - a.tailscale);
  return out.map(a => `${a.address}:${port}${a.tailscale ? ' (Tailscale)' : ''}`);
}

// Patches do engine.js do site no convidado (texto original, em tempo de execução; âncora que não bate = não aplica):
//  connect: troca "+devmap <mapa>" por "+connect localhost" logo antes de state.arguments = args (depois de todos os
//           splices que usam indexOf('+devmap')). O pack do mapa continua montado pela página como num jogo solo.
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

function setupCoop({ config, log, logDir, gameUrl }) {
  const { ipcMain, MessageChannelMain, net, clipboard } = require('electron');
  const settings = coopSettings(config);
  const active = settings.role !== 'off';
  const coopLog = path.join(logDir, `coop${process.env.BO1Z_PROFILE ? '-' + process.env.BO1Z_PROFILE : ''}.log`);
  const clog = (what, msg) => fs.appendFile(coopLog, `${new Date().toISOString()} [${what}] ${msg}\n`, () => {});
  let esm = null, layout = null, transport = null, current = null, unbind = null;
  const watched = new WeakSet();
  const loadEsm = () => (esm ??= Promise.all([import('./gluepatch.mjs'), import('./wasmscan.mjs'), import('./wasmpatch.mjs')])
    .then(([g, w, p]) => ({ applyN1: g.applyN1, N1_MARK: g.N1_MARK, scanWasm: w.scanWasm, patchGuestWasm: p.patchGuestWasm })));

  async function scan(bytes, source) {
    const { scanWasm } = await loadEsm();
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    layout = { ...scanWasm(bytes), sha, source };
    clog('wasm', `${source} sha256 ${sha.slice(0, 16)}…: ${layout.ok ? `rings em ${layout.layout.base}, ${layout.producers} produtores` : `co-op desligado: ${layout.reason}`}`);
    return layout;
  }

  // Chamado pelo handler https do main.js antes de qualquer outra coisa. Devolve Response ou null (segue o fluxo normal).
  const gameHost = new URL(gameUrl).hostname;
  async function handle(request, url) {
    if (!active || url.hostname !== gameHost) return null;
    if (url.pathname.startsWith('/__bo1z/coop/')) {
      const name = url.pathname.slice('/__bo1z/coop/'.length);
      if (!MODULES.has(name)) return new Response('not found', { status: 404 });
      return new Response(fs.readFileSync(path.join(__dirname, name)), { status: 200, headers: {
        'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' } });
    }
    const file = url.pathname.split('/').pop();
    if (file === WASM && url.pathname.includes('/artifacts/')) {
      const original = await net.fetch(request, { bypassCustomProtocolHandlers: true });
      if (!original.ok || request.headers.get('range')) return original;
      let body = Buffer.from(await original.arrayBuffer());
      await scan(body, 'página');
      if (settings.role === 'guest' && settings.guestStart === 'shadow') {
        const { patchGuestWasm } = await loadEsm();
        const p = patchGuestWasm(body);
        clog('wasm', `patches do convidado: ${p.applied.map(a => a.label).join(', ') || 'nenhum'}${p.errors.length ? ` — falhas: ${p.errors.join('; ')}` : ''}`);
        if (!p.errors.length) body = p.buf;
        else if (layout) layout = { ...layout, ok: false, reason: `wasm do convidado sem patch: ${p.errors.join('; ')}` };
      }
      const headers = new Headers(original.headers);
      for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
      return new Response(body, { status: original.status, headers });
    }
    if (file === 'engine.js' && settings.role === 'guest') {
      const original = await net.fetch(request, { bypassCustomProtocolHandlers: true });
      if (!original.ok) return original;
      const text = await original.text();
      const headers = new Headers(original.headers);
      for (const h of ['content-length', 'content-encoding', 'etag']) headers.delete(h);
      try {
        const patched = patchEngineForGuest(text, settings.guestStart);
        clog('engine', `engine.js do convidado: ${patched.applied.join(', ') || 'sem patch'} (${settings.guestStart})`);
        return new Response(patched.text, { status: 200, headers });
      } catch (error) {
        clog('engine', `${error.message}; convidado sobe solo (+devmap). Use "connect localhost" no console.`);
        return new Response(text, { status: 200, headers });
      }
    }
    return null;
  }

  // Glue final (patcheado ou original): com sala ativa, garante o N1.
  async function finishGlue(text) {
    if (!active) return text;
    const { applyN1, N1_MARK } = await loadEsm();
    if (text.includes(N1_MARK)) return text;
    try { return applyN1(text); } catch (error) { clog('glue', `N1 não aplicado: ${error.message}`); return text; }
  }

  function startTransport() {
    if (!active || transport) return;
    if (settings.role === 'host') {
      if (!settings.code) settings.code = roomCode();
      transport = new CoopHost({ port: settings.port, bind: settings.bind, maxGuests: settings.maxGuests, code: settings.code, log: clog });
      transport.start().then(port => {
        clog('sala', `aberta: código ${settings.code}, porta ${port}; convite: ${inviteAddresses(port).join(' | ') || '(sem rede)'}`);
      }, error => clog('sala', `não abriu a porta ${settings.port}: ${error.message}`));
    } else {
      if (!settings.host) { clog('sala', 'convidado sem endereço do host (coop.host ou BO1Z_COOP_HOST)'); return; }
      transport = new CoopGuest({ host: settings.host, code: settings.code, name: settings.name, log: clog });
      transport.on('reject', reason => clog('sala', `recusado: ${reason}`));
      transport.on('lost', reason => clog('sala', `conexão perdida: ${reason}`));
      transport.start();
    }
    setInterval(() => clog('rede', JSON.stringify(transport.stats())), 30000);
  }

  // A página pede o port (preload, a cada navegação). Um canal por página; o anterior é fechado.
  ipcMain.on('bo1z:coop-hello', event => {
    if (!active) return;
    startTransport();
    if (!transport) return;
    unbind?.();
    current?.close();
    const { port1, port2 } = new MessageChannelMain();
    current = port1;
    unbind = bindPage(transport, settings.role, port1, handler => port1.on('message', e => handler(e.data)), clog);
    port1.start();
    if (!watched.has(event.sender)) {
      watched.add(event.sender);
      event.sender.once('destroyed', () => { unbind?.(); unbind = null; current?.close(); current = null; });
    }
    event.sender.postMessage('bo1z:coop-port', null, [port2]);
  });

  ipcMain.handle('bo1z:coop-layout', async () => {
    if (!active) return { ok: false, reason: 'co-op desligado' };
    if (layout) return layout;
    // A página pode ter tirado o wasm de um cache sem passar pelo protocolo: baixa e analisa aqui.
    const response = await net.fetch(new URL(`artifacts/${WASM}`, gameUrl).href, { bypassCustomProtocolHandlers: true });
    if (!response.ok) return { ok: false, reason: `wasm HTTP ${response.status}` };
    return scan(Buffer.from(await response.arrayBuffer()), 'main');
  });

  // Nome no placar do jogo: entra como "+set name …" antes do +devmap/+connect (só letras, números e _ . -).
  const engineName = settings.name.replace(/[^A-Za-z0-9_.\- ]/g, '').trim().slice(0, 15) || 'Player';
  // Host: sv_timeout 30 (padrão do motor: 240 s) para a vaga de quem caiu/recarregou sumir logo.
  const withCoopCommands = commands => !active ? commands
    : { ...commands, '*': [...(commands?.['*'] ?? []), '+set', 'name', engineName,
      ...(settings.role === 'host' ? ['+set', 'sv_timeout', '30'] : [])] };

  return {
    active, settings, handle, finishGlue, clog, glueName: GLUE, withCoopCommands,
    // Linha de console da página que começa com BO1Z_COOP: vai para o log do co-op.
    consoleLine: message => { if (active && message.startsWith('BO1Z_COOP')) clog('página', message.slice(10, 4000)); },
    preloadInfo: () => active ? { role: settings.role, guestStart: settings.guestStart } : null,
    invite: () => settings.role === 'host' && transport
      ? `BO1 Zombies co-op — código ${settings.code}, host ${inviteAddresses(transport.port)[0] ?? '?'}` : null,
    copyInvite() { const text = this.invite(); if (text) clipboard.writeText(text); return text; },
    logFile: coopLog,
    close: () => transport?.close(),
  };
}

module.exports = { setupCoop, coopSettings, patchEngineForGuest, inviteAddresses };
