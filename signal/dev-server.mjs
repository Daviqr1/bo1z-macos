#!/usr/bin/env node
// Sinalização local em Node (http + ws): a mesma sala (src/room.js), a mesma página de convite e o mesmo protocolo do
// Worker, com as mesmas rotas. Serve para os testes e para rodar em casa/Tailscale sem conta na Cloudflare:
//
//   node signal/dev-server.mjs [porta]      (padrão 8787; HOST=0.0.0.0 para a rede local)
//
// Ambiente: PORT, HOST, PUBLIC_ORIGIN, TURN_KEY_ID/TURN_KEY_API_TOKEN, DOWNLOAD_WIN_URL/DOWNLOAD_MAC_URL e, só para
// testes, HOST_GRACE_MS/GUEST_GRACE_MS/EMPTY_TTL_MS/HELLO_TIMEOUT_MS.
// Diferença de propósito: aqui o servidor manda ping de WebSocket a cada 30 s e derruba quem não responde (no Worker
// isso fica com o keepalive do cliente).
import http from 'node:http';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { CLOSE, ERRORS, Room, VERSION, limitsFromEnv, makeRoomCode, normalizeRoomCode } from './src/room.js';
import { createIceProvider } from './src/ice.js';
import { invitePage, invitePath, publicOrigin } from './src/invite.js';

const HEARTBEAT_MS = 30e3;

export async function startDevServer({ port = 0, host = '127.0.0.1', env = {}, limits = {}, log = () => {},
  now = Date.now, heartbeatMs = HEARTBEAT_MS } = {}) {
  const rooms = new Map(); // código -> Room (inclusive a reservada pela criação, antes do hello do host)
  const timers = new Map(); // Room -> despertador
  const ice = createIceProvider({ keyId: env.TURN_KEY_ID, token: env.TURN_KEY_API_TOKEN, log });
  const roomLimits = { ...limitsFromEnv(env), ...limits };

  function makeRoom(code) {
    const room = new Room({
      code, now, ice, log, limits: roomLimits,
      setAlarm: at => {
        clearTimeout(timers.get(room));
        timers.delete(room);
        if (at === null) return;
        const timer = setTimeout(() => { room.alarm(); forget(room); }, Math.max(0, at - now()));
        timer.unref?.();
        timers.set(room, timer);
      },
      store: { save() {}, clear() { forget(room); } }, // memória só: reiniciar o servidor encerra as salas
    });
    return room;
  }

  function forget(room) {
    if (!room.idle) return;
    clearTimeout(timers.get(room));
    timers.delete(room);
    if (rooms.get(room.code) === room) rooms.delete(room.code);
  }

  const originOf = req => {
    let fallback = `http://localhost:${server.address().port}`;
    try { fallback = new URL(`http://${req.headers.host}`).origin; } catch { /* Host estranho: fica o localhost */ }
    return publicOrigin(env, fallback);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const reply = (status, body, headers) => {
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const plain = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply(405, 'método não permitido', { ...plain, Allow: 'GET, HEAD' });
    }
    if (url.pathname === '/health') {
      return reply(200, JSON.stringify({ ok: true, v: VERSION }), { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    }
    if (url.pathname === '/ws') {
      return reply(426, 'conecte por WebSocket: ws://<servidor>/ws?v=1', { ...plain, Upgrade: 'websocket' });
    }
    const code = invitePath(url.pathname);
    if (code !== null) {
      const page = invitePage({ code, origin: originOf(req), env });
      return reply(page.status, page.body, page.headers);
    }
    if (url.pathname === '/') return reply(200, 'bo1z-signal (dev): /health, /j/<código>, /ws?v=1\n', plain);
    reply(404, 'não encontrado\n', plain);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });

  // Mesma lógica de entrada do Worker (src/index.js): sem room = criação com código novo; com room = entrada/reentrada.
  function route(ws, req) {
    const url = new URL(req.url, 'http://local');
    // Recusa sem sala, como no Worker: responde à primeira mensagem (o hello) ou, se o cliente ficar mudo, em 2 s.
    const refuse = (code, message) => {
      const finish = () => {
        clearTimeout(timer);
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ t: 'error', code, message }));
        ws.close(CLOSE.error, code);
      };
      const timer = setTimeout(finish, 2000);
      ws.once('message', finish);
      ws.once('close', () => clearTimeout(timer));
    };
    const v = url.searchParams.get('v');
    if (v !== null && v !== String(VERSION)) return refuse('version', `${ERRORS.version} (servidor: v${VERSION})`);
    const asked = url.searchParams.get('room');
    let room, create = false;
    if (asked !== null) {
      const code = normalizeRoomCode(asked);
      if (!code) return refuse('room-not-found', 'código de sala inválido');
      room = rooms.get(code) ?? makeRoom(code); // sala que não existe responde room-not-found ao hello
    } else {
      let code;
      do code = makeRoomCode(); while (rooms.has(code));
      room = makeRoom(code);
      create = true;
    }
    if (room.idle && !room.closed) rooms.set(room.code, room);
    const socket = { send: text => ws.send(text), close: (code, reason) => ws.close(code, reason) };
    ws.on('message', (data, binary) => {
      Promise.resolve(room.message(socket, binary ? new Uint8Array(data) : data.toString('utf8')))
        .catch(error => log(`sala ${room.code}: ${error.stack ?? error}`))
        .finally(() => forget(room));
    });
    ws.on('close', () => { room.disconnect(socket); forget(room); });
    ws.on('error', error => log(`websocket: ${error.message}`));
    ws.on('pong', () => { ws.alive = true; });
    ws.alive = true;
    room.attach(socket, { create, code: room.code, origin: originOf(req) });
    forget(room);
  }

  server.on('upgrade', (req, sock, head) => {
    if (new URL(req.url, 'http://local').pathname !== '/ws') {
      sock.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, sock, head, ws => route(ws, req));
  });

  const heartbeat = heartbeatMs ? setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch { /* fechando */ }
    }
  }, heartbeatMs) : null;
  heartbeat?.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${shown}:${address.port}`;
  return {
    url, wsUrl: `${url.replace(/^http/, 'ws')}/ws?v=1`, port: address.port, rooms,
    close: () => new Promise(resolve => {
      clearInterval(heartbeat);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

// Endereços IPv4 desta máquina (para mandar o link na rede de casa/Tailscale).
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '0.0.0.0';
  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = message => console.log(`${stamp()} ${message}`);
  const dev = await startDevServer({ port, host, env: process.env, log });
  console.log(`${stamp()} sinalização em ${dev.url} (WebSocket: ${dev.wsUrl})`);
  if (host === '0.0.0.0') for (const a of lanAddresses()) console.log(`${stamp()}   na rede: http://${a}:${dev.port}`);
  if (!process.env.TURN_KEY_ID) console.log(`${stamp()} sem TURN_KEY_ID/TURN_KEY_API_TOKEN: o welcome leva só STUN`);
  const stop = () => dev.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
