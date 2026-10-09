// Worker da sinalização do co-op (docs/COOP-ARCH.md §2): GET /health, GET /j/<código> (página de convite) e
// GET /ws (WebSocket, encaminhado ao Durable Object da sala).
//
// Como o socket chega à sala certa, se o hello só vem depois do upgrade (quando o Worker já escolheu o objeto):
//   - host criando sala: /ws?v=1, sem room. O Worker sorteia o código e manda o upgrade para idFromName(código) com
//     X-Bo1z-Create: 1. Se esse objeto já tem sala (ou outra criação pendente), ele responde 409 e o Worker sorteia
//     outro código. O hello do host vem sem room; o welcome traz o código.
//   - convidado entrando, ou qualquer reentrada (resume, host ou convidado): /ws?v=1&room=<código>. O hello traz o
//     mesmo código (o de um host que volta também).
// Código inválido ou versão errada na URL: o próprio Worker aceita o socket, manda o error do protocolo e fecha
// (o cliente recebe a mesma mensagem que receberia da sala, em vez de uma falha genérica de WebSocket).
import { CLOSE, ERRORS, VERSION, makeRoomCode, normalizeRoomCode } from './room.js';
import { invitePage, invitePath, publicOrigin } from './invite.js';
import { ROUTE } from './do.js';

export { RoomDO } from './do.js';

const CREATE_TRIES = 8; // 31^5 ≈ 28,6 milhões de códigos: colisão é rara; 8 seguidas, impossível na prática

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const text = (status, body, headers = {}) => new Response(body, { status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers } });

// Recusa no formato do protocolo: aceita o socket só para responder o error e fechar. Responde à primeira mensagem
// (o hello, que o cliente manda assim que abre), como a sala faria: fechar antes de o cliente mandar qualquer coisa
// deixa um "Uncaught Error: Network connection lost" no log do workerd. O waitUntil segura a requisição até o
// fechamento terminar; cliente mudo é recusado assim mesmo depois de 2 s.
function refuse(ctx, code, message) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  ctx.waitUntil(new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        server.send(JSON.stringify({ t: 'error', code, message }));
        server.close(CLOSE.error, code);
      } catch { resolve(); }
    };
    server.addEventListener('message', finish);
    server.addEventListener('close', resolve);
    server.addEventListener('error', resolve);
    setTimeout(finish, 2000);
    setTimeout(resolve, 7000); // cliente que nunca responde ao Close
  }));
  return new Response(null, { status: 101, webSocket: client });
}

function forward(env, request, code, create, origin) {
  const headers = new Headers(request.headers);
  headers.set(ROUTE.room, code);
  headers.set(ROUTE.create, create ? '1' : '0');
  headers.set(ROUTE.origin, origin);
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch('https://sala.bo1z/ws', { headers });
}

async function webSocket(request, env, ctx, url) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return text(426, 'conecte por WebSocket: wss://<servidor>/ws?v=1', { Upgrade: 'websocket' });
  }
  const v = url.searchParams.get('v');
  if (v !== null && v !== String(VERSION)) return refuse(ctx, 'version', `${ERRORS.version} (servidor: v${VERSION})`);
  const origin = publicOrigin(env, url.origin);
  const asked = url.searchParams.get('room');
  if (asked !== null) {
    const code = normalizeRoomCode(asked);
    return code ? forward(env, request, code, false, origin) : refuse(ctx, 'room-not-found', 'código de sala inválido');
  }
  for (let i = 0; i < CREATE_TRIES; ++i) {
    const response = await forward(env, request, makeRoomCode(), true, origin);
    if (response.status !== 409) return response;
  }
  return refuse(ctx, 'room-full', 'não deu para criar a sala agora: tente de novo');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'método não permitido', { Allow: 'GET, HEAD' });
    }
    if (url.pathname === '/ws') return webSocket(request, env, ctx, url);
    if (url.pathname === '/health') return json(200, { ok: true, v: VERSION }, { 'Access-Control-Allow-Origin': '*' });
    const code = invitePath(url.pathname);
    if (code !== null) {
      const page = invitePage({ code, origin: publicOrigin(env, url.origin), env });
      return new Response(page.body, { status: page.status, headers: page.headers });
    }
    if (url.pathname === '/') {
      return text(200, 'bo1z-signal: sinalização do co-op do BO1 Zombies (/health, /j/<código>, /ws?v=1)\n');
    }
    return text(404, 'não encontrado\n');
  },
};
