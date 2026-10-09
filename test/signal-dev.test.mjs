// Sinalização de ponta a ponta com WebSocket de verdade: sobe signal/dev-server.mjs numa porta livre (prazos curtos)
// e faz o roteiro inteiro: host cria, convidados entram, signal roteado, lobby/ready/start, sala cheia, código errado,
// host cai e volta com resume, host não volta => closed.
//
// O mesmo arquivo roda contra outro servidor (ex.: o Worker de verdade no wrangler dev):
//   (cd signal && npx wrangler dev --port 8787 --var HOST_GRACE_MS:1500 --var GUEST_GRACE_MS:1500)
//   BO1Z_SIGNAL_URL=http://127.0.0.1:8787 node --test test/signal-dev.test.mjs
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startDevServer } from '../signal/dev-server.mjs';
import { CLOSE, normalizeRoomCode } from '../signal/src/room.js';

const EXTERNAL = process.env.BO1Z_SIGNAL_URL;
const GRACE = Number(process.env.BO1Z_SIGNAL_GRACE_MS ?? 1500);
let base = '', dev = null;

before(async () => {
  if (EXTERNAL) { base = EXTERNAL.replace(/\/$/, ''); return; }
  dev = await startDevServer({ limits: { hostGraceMs: GRACE, guestGraceMs: GRACE } });
  base = dev.url;
});
after(() => dev?.close());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const wsUrl = (query = '') => `${base.replace(/^http/, 'ws')}/ws?v=1${query}`;

// Cliente de teste: guarda tudo o que chega; next() espera a próxima mensagem que casar.
class Client {
  static async open(query = '') {
    const client = new Client(new WebSocket(wsUrl(query)));
    await client.opened;
    return client;
  }

  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.waiters = new Set();
    this.closed = null;
    this.opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', data => { this.inbox.push(JSON.parse(data.toString())); this.wake(); });
    this.whenClosed = new Promise(resolve => ws.once('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      resolve(this.closed);
      this.wake();
    }));
  }

  wake() { for (const w of this.waiters) w(); }

  send(m) { this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }

  next(match = {}, timeoutMs = 4000) {
    const ok = m => Object.entries(match).every(([k, v]) => m[k] === v);
    return new Promise((resolve, reject) => {
      const check = () => {
        const i = this.inbox.findIndex(ok);
        if (i >= 0) { done(); resolve(this.inbox.splice(i, 1)[0]); }
        else if (this.closed) {
          done();
          reject(new Error(`fechou (${this.closed.code}) esperando ${JSON.stringify(match)}`));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timeout esperando ${JSON.stringify(match)}; caixa: ${JSON.stringify(this.inbox)}`));
      }, timeoutMs);
      const done = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }

  async hello(fields) {
    this.send({ t: 'hello', v: 1, ...fields });
    return this.next({ t: 'welcome' });
  }

  async quiet(ms = 300) { await sleep(ms); assert.deepEqual(this.inbox, [], 'não devia ter chegado nada'); }

  drop() { this.ws.terminate(); } // queda de rede: sem close nem leave
  close() { this.ws.close(); }
}

async function createRoom(name = 'Davi') {
  const host = await Client.open();
  const welcome = await host.hello({ role: 'host', name });
  return { host, welcome, code: welcome.room };
}

async function join(code, name, extra = {}) {
  const client = await Client.open(`&room=${code}`);
  const welcome = await client.hello({ role: 'guest', name, room: code, ...extra });
  return { client, welcome };
}

async function refused(query, hello) {
  const client = await Client.open(query);
  if (hello) client.send({ t: 'hello', v: 1, ...hello });
  const error = await client.next({ t: 'error' });
  const closed = await client.whenClosed;
  return { error, closed };
}

test('HTTP: /health, convite, convite com XSS, 404, 405, /ws sem upgrade', async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, v: 1 });

  const page = await fetch(`${base}/j/k7qx2`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  const html = await page.text();
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(html.includes(`href="bo1z://join/K7QX2?s=${encodeURIComponent(new URL(base).host)}"`));
  assert.ok(html.includes('lang="pt-BR"'));

  const evil = await fetch(`${base}/j/${encodeURIComponent('"><script>alert(1)</script>')}`);
  assert.equal(evil.status, 404);
  const evilHtml = await evil.text();
  assert.ok(!evilHtml.includes('<script>alert'));
  assert.ok(!evilHtml.includes('alert(1)'));

  assert.equal((await fetch(`${base}/nada`)).status, 404);
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/ws`)).status, 426);
});

test('sala completa: criar, 2 convidados, signal, lobby/ready/start, sala cheia, código errado', async () => {
  const { host, welcome, code } = await createRoom('Davi');
  assert.equal(normalizeRoomCode(code), code);
  assert.equal(welcome.role, 'host');
  assert.equal(welcome.hostId, welcome.you);
  assert.equal(welcome.invite, `${base}/j/${code}`);
  assert.ok(Array.isArray(welcome.ice) && welcome.ice.length > 0);

  const g1 = await join(code.toLowerCase(), 'Irmão'); // código digitado em minúsculas também vale
  assert.deepEqual(g1.welcome.peers, [{ id: welcome.you, name: 'Davi', role: 'host', ready: true }]);
  assert.deepEqual((await host.next({ t: 'peer-joined' })).peer,
    { id: g1.welcome.you, name: 'Irmão', role: 'guest', ready: false });
  const g2 = await join(code, 'Primo');
  assert.deepEqual(g2.welcome.peers.map(p => p.name), ['Davi', 'Irmão']);
  assert.equal((await host.next({ t: 'peer-joined' })).peer.name, 'Primo');
  assert.equal((await g1.client.next({ t: 'peer-joined' })).peer.name, 'Primo');

  // estrela: convidado -> host -> outro convidado; convidado -> convidado é proibido
  const offer = { sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' } };
  g1.client.send({ t: 'signal', to: welcome.you, data: offer });
  assert.deepEqual(await host.next({ t: 'signal' }), { t: 'signal', from: g1.welcome.you, data: offer });
  const candidate = { candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } };
  host.send({ t: 'signal', to: g2.welcome.you, data: candidate });
  assert.equal((await g2.client.next({ t: 'signal' })).from, welcome.you);
  g1.client.send({ t: 'signal', to: g2.welcome.you, data: offer });
  assert.equal((await g1.client.next({ t: 'error' })).code, 'forbidden');

  host.send({ t: 'lobby', data: { map: 'zombie_coast' } });
  for (const c of [host, g1.client, g2.client]) {
    assert.deepEqual(await c.next({ t: 'lobby' }), { t: 'lobby', data: { map: 'zombie_coast' } });
  }
  g1.client.send({ t: 'ready', ready: true });
  for (const c of [host, g1.client, g2.client]) {
    assert.deepEqual(await c.next({ t: 'peer-ready' }), { t: 'peer-ready', id: g1.welcome.you, ready: true });
  }
  g2.client.send({ t: 'start', map: 'zombie_coast' });
  assert.equal((await g2.client.next({ t: 'error' })).code, 'forbidden');
  const before = Date.now();
  host.send({ t: 'start' });
  for (const c of [host, g1.client, g2.client]) {
    const start = await c.next({ t: 'start' });
    assert.equal(start.map, 'zombie_coast');
    assert.ok(Math.abs(start.at - before) < 5000);
  }

  host.send({ t: 'ping', ts: 42 });
  const pong = await host.next({ t: 'pong' });
  assert.equal(pong.ts, 42);
  assert.equal(typeof pong.now, 'number');
  host.send('{"t":"ping"}'); // keepalive puro (no Worker, respondido pelo runtime sem acordar o objeto)
  assert.deepEqual(await host.next({ t: 'pong' }), { t: 'pong' });

  const g3 = await join(code, 'Tio');
  assert.equal(g3.welcome.peers.length, 3);
  const full = await refused(`&room=${code}`, { role: 'guest', name: 'Quinto', room: code });
  assert.equal(full.error.code, 'room-full');
  assert.equal(full.closed.code, CLOSE.error);

  const wrong = await refused(`&room=${code === 'ZZZZZ' ? 'YYYYY' : 'ZZZZZ'}`, { role: 'guest', name: 'x', room: 'ZZZZZ' });
  assert.equal(wrong.error.code, 'room-not-found');
  // fora do alfabeto: recusado pelo próprio servidor HTTP (sem sala), em resposta ao hello
  const invalid = await refused('&room=K7QX0', { role: 'guest', name: 'x', room: 'K7QX0' });
  assert.equal(invalid.error.code, 'room-not-found');
  assert.equal(invalid.closed.code, CLOSE.error);

  // convidado sai: os outros sabem; host sai: a sala acaba para todo mundo
  g3.client.send({ t: 'leave' });
  assert.deepEqual(await host.next({ t: 'peer-left' }), { t: 'peer-left', id: g3.welcome.you, reason: 'left' });
  host.send({ t: 'leave' });
  for (const c of [g1.client, g2.client]) {
    assert.deepEqual(await c.next({ t: 'closed' }), { t: 'closed', reason: 'host-left' });
    assert.equal((await c.whenClosed).code, CLOSE.normal);
  }
  const gone = await refused(`&room=${code}`, { role: 'guest', name: 'x', room: code });
  assert.equal(gone.error.code, 'room-not-found');
});

test('host cai e volta com resume dentro da tolerância: mesmo id, convidados nem percebem', async () => {
  const { host, welcome, code } = await createRoom();
  const g1 = await join(code, 'Irmão');
  await host.next({ t: 'peer-joined' });
  host.drop();
  await sleep(GRACE / 3);
  const back = await Client.open(`&room=${code}`);
  const again = await back.hello({ role: 'host', name: 'Davi', room: code, resume: welcome.resume });
  assert.equal(again.you, welcome.you);
  assert.equal(again.role, 'host');
  assert.deepEqual(again.peers.map(p => p.id), [g1.welcome.you]);
  await sleep(GRACE); // passa do prazo original: a sala tem de continuar
  await g1.client.quiet(50);
  g1.client.send({ t: 'signal', to: welcome.you, data: { sdp: 'depois da volta' } });
  assert.deepEqual((await back.next({ t: 'signal' })).data, { sdp: 'depois da volta' });
  back.send({ t: 'leave' });
  await g1.client.next({ t: 'closed' });
});

test('convidado cai e volta com resume: mesmo id; host não é incomodado', async () => {
  const { host, code } = await createRoom();
  const g1 = await join(code, 'Irmão');
  await host.next({ t: 'peer-joined' });
  g1.client.drop();
  await sleep(GRACE / 3);
  const back = await join(code, 'Irmão', { resume: g1.welcome.resume });
  assert.equal(back.welcome.you, g1.welcome.you);
  await host.quiet(GRACE);
  host.send({ t: 'leave' });
  await back.client.next({ t: 'closed' });
});

test('host cai e não volta: convidados recebem closed host-left depois da tolerância', async () => {
  const { host, code, welcome } = await createRoom();
  const g1 = await join(code, 'Irmão');
  const g2 = await join(code, 'Primo');
  host.drop();
  const t0 = Date.now();
  for (const g of [g1, g2]) {
    assert.deepEqual(await g.client.next({ t: 'closed' }, GRACE + 5000), { t: 'closed', reason: 'host-left' });
    assert.equal((await g.client.whenClosed).code, CLOSE.normal);
  }
  assert.ok(Date.now() - t0 >= GRACE - 100, `fechou cedo demais (${Date.now() - t0} ms)`);
  const late = await refused(`&room=${code}`, { role: 'host', name: 'Davi', room: code, resume: welcome.resume });
  assert.equal(late.error.code, 'room-not-found');
});

test('abusos: versão errada, primeira mensagem sem hello, mensagem grande demais, taxa', async () => {
  // versão errada na URL: recusada sem passar pela sala (responde ao hello; cliente mudo, em até 2 s)
  for (const sendHello of [true, false]) {
    const urlV2 = new Client(new WebSocket(`${base.replace(/^http/, 'ws')}/ws?v=2`));
    await urlV2.opened;
    if (sendHello) urlV2.send({ t: 'hello', v: 2, role: 'host', name: 'x' });
    assert.equal((await urlV2.next({ t: 'error' })).code, 'version');
    assert.equal((await urlV2.whenClosed).code, CLOSE.error);
  }

  const helloV2 = await refused('', { v: 2, role: 'host', name: 'x' });
  assert.equal(helloV2.error.code, 'version');

  const noHello = await Client.open();
  noHello.send({ t: 'ping', ts: 1 });
  assert.equal((await noHello.next({ t: 'error' })).code, 'bad-message');
  assert.equal((await noHello.whenClosed).code, CLOSE.error);

  const { host, code } = await createRoom();
  const g1 = await join(code, 'Irmão');
  g1.client.send(JSON.stringify({ t: 'signal', to: 'x', data: { sdp: 'x'.repeat(20 * 1024) } }));
  assert.equal((await g1.client.next({ t: 'error' })).code, 'bad-message');
  assert.equal((await g1.client.whenClosed).code, CLOSE.tooBig);

  const g2 = await join(code, 'Primo');
  for (let i = 0; i < 150; ++i) g2.client.send({ t: 'ping', ts: i });
  assert.equal((await g2.client.next({ t: 'error' })).code, 'rate');
  assert.equal((await g2.client.whenClosed).code, CLOSE.rate);
  host.send({ t: 'leave' });
  await host.next({ t: 'closed' });
});
