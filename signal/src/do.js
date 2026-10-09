// Durable Object de uma sala (um por código, idFromName(código)). Só faz a ponte entre o runtime da Cloudflare e a
// lógica pura de room.js:
//   - WebSockets hibernáveis (ctx.acceptWebSocket): o objeto sai da memória entre mensagens e não paga duração;
//   - estado da sala no storage (SQLite) a cada mudança; o de cada socket no attachment (serializeAttachment);
//   - um alarm do storage como despertador da sala (setTimeout impediria a hibernação);
//   - {"t":"ping"} puro é respondido pelo runtime sem acordar o objeto (keepalive barato dos clientes).
import { DurableObject } from 'cloudflare:workers';
import { Room, limitsFromEnv, normalizeRoomCode } from './room.js';
import { createIceProvider } from './ice.js';

export const ROUTE = Object.freeze({ room: 'X-Bo1z-Room', create: 'X-Bo1z-Create', origin: 'X-Bo1z-Origin' });

const log = message => console.log(message);
let iceProvider = null; // um por isolate: a credencial TURN em cache serve para todas as salas daqui

export class RoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.byKey = new Map(); // chave do attachment -> embrulho do socket (a identidade do objeto WebSocket pode mudar)
    this.room = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    iceProvider ??= createIceProvider({ keyId: env.TURN_KEY_ID, token: env.TURN_KEY_API_TOKEN, log });
    ctx.blockConcurrencyWhile(async () => {
      const snapshot = await ctx.storage.get('room');
      this.room = new Room({
        snapshot, log, ice: iceProvider, limits: limitsFromEnv(env), now: () => Date.now(),
        setAlarm: at => (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at))
          .catch(e => log(`alarm: ${e}`)),
        store: {
          save: s => { ctx.storage.put('room', s).catch(e => log(`storage: ${e}`)); },
          clear: () => { ctx.storage.deleteAll().catch(e => log(`storage: ${e}`)); },
        },
      });
      // Acordou da hibernação: os sockets continuam abertos e cada um traz o seu attachment.
      this.room.restore(ctx.getWebSockets()
        .map(ws => ({ socket: this.wrap(ws), attachment: ws.deserializeAttachment() })));
    });
  }

  // Embrulho { send, close, save } que a sala usa como socket. A chave fica no attachment, junto do que a sala salva,
  // para achar o mesmo embrulho mesmo que o runtime entregue outro objeto WebSocket para a mesma conexão.
  wrap(ws) {
    const key = ws.deserializeAttachment()?.k;
    let socket = key && this.byKey.get(key);
    if (socket) { socket.ws = ws; return socket; }
    const k = key ?? crypto.randomUUID();
    socket = {
      ws, k,
      send: text => socket.ws.send(text),
      close: (code, reason) => socket.ws.close(code, reason),
      save: attachment => socket.ws.serializeAttachment({ ...attachment, k }),
    };
    this.byKey.set(k, socket);
    return socket;
  }

  // Upgrade encaminhado pelo Worker (index.js), com o código e o modo nos cabeçalhos X-Bo1z-*.
  async fetch(request) {
    const code = normalizeRoomCode(request.headers.get(ROUTE.room));
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || !code) {
      return new Response('pedido inválido', { status: 400 });
    }
    const create = request.headers.get(ROUTE.create) === '1';
    // Código já em uso (sala viva ou outra criação pendente): o Worker sorteia outro.
    if (create && !this.room.canCreate()) return new Response('código em uso', { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const socket = this.wrap(server);
    socket.save({}); // grava a chave já (a sala sobrescreve com o resto, mantendo a chave)
    this.room.attach(socket, { create, code, origin: request.headers.get(ROUTE.origin) });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    return this.room.message(this.wrap(ws), message);
  }

  webSocketClose(ws, code, reason) {
    this.gone(ws);
    // Antes da data de compatibilidade 2026-04-07 o runtime não respondia o Close sozinho; responder é inofensivo.
    // 1005/1006 (e os outros reservados) não podem ir num Close.
    const echo = code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 1000;
    try { ws.close(echo, reason); } catch { /* já fechado */ }
  }

  webSocketError(ws, error) {
    log(`websocket: ${error?.message ?? error}`);
    this.gone(ws);
  }

  gone(ws) {
    const socket = this.wrap(ws);
    this.room.disconnect(socket);
    this.byKey.delete(socket.k);
  }

  alarm() {
    this.room.alarm();
  }
}
