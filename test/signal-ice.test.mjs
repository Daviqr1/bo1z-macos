// Servidores ICE da sinalização (signal/src/ice.js): TURN da Cloudflare com cache, fallback para STUN e formatos
// da resposta. A API é de mentira (fetch injetado).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ICE_API, STUN_ONLY, createIceProvider, normalizeIceServers } from '../signal/src/ice.js';

// Formato da resposta documentada de generate-ice-servers (credenciais trocadas).
const CLOUDFLARE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'usuario-curto', credential: 'senha-curta',
    },
  ],
};

function fakeApi(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === 'function') return next(init);
    if (next instanceof Error) throw next;
    return { ok: next.status === undefined || next.status < 300, status: next.status ?? 201, json: async () => next.body };
  };
  return { fetch, calls };
}

test('sem chaves: só STUN, sem chamar a API', async () => {
  const api = fakeApi([]);
  for (const options of [{}, { keyId: 'k' }, { token: 't' }]) {
    assert.deepEqual(await createIceProvider({ ...options, fetch: api.fetch })(), STUN_ONLY);
  }
  assert.equal(api.calls.length, 0);
  assert.ok(STUN_ONLY[0].urls.includes('stun:stun.cloudflare.com:3478'));
  assert.ok(STUN_ONLY[0].urls.includes('stun:stun.l.google.com:19302'));
});

test('com chaves: pedido certo à Cloudflare e resposta normalizada (sem porta 53)', async () => {
  const api = fakeApi([{ body: CLOUDFLARE }]);
  const servers = await createIceProvider({ keyId: 'chave/1', token: 'segredo', fetch: api.fetch })();
  assert.equal(api.calls.length, 1);
  const [{ url, init }] = api.calls;
  assert.equal(url, `${ICE_API}/chave%2F1/credentials/generate-ice-servers`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer segredo');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { ttl: 86400 });
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(servers, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'usuario-curto', credential: 'senha-curta',
    },
  ]);
});

test('normalização: formato antigo (objeto único), TURN sem credencial descartado, lixo recusado', () => {
  assert.deepEqual(normalizeIceServers({ iceServers: { urls: 'turn:t.example:3478', username: 'u', credential: 'c' } }),
    [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }]);
  assert.throws(() => normalizeIceServers({ iceServers: [{ urls: ['turn:t.example:3478'] }] }), /sem TURN/);
  assert.throws(() => normalizeIceServers({ iceServers: [{ urls: ['stun:s.example:3478'] }] }), /sem TURN/);
  assert.throws(() => normalizeIceServers({}), /sem iceServers/);
  assert.throws(() => normalizeIceServers(null), /sem iceServers/);
  assert.deepEqual(normalizeIceServers({ iceServers: [
    { urls: ['javascript:alert(1)', 'http://x', 42] },
    { urls: ['turns:t.example:443?transport=tcp'], username: 'u', credential: 'c', extra: 'fora' },
  ] }), [{ urls: ['turns:t.example:443?transport=tcp'], username: 'u', credential: 'c' }]);
});

test('cache: reaproveita por cacheMs; pedidos simultâneos dividem uma chamada', async () => {
  let t = 0;
  const api = fakeApi([{ body: CLOUDFLARE }, { body: CLOUDFLARE }]);
  const ice = createIceProvider({ keyId: 'k', token: 't', fetch: api.fetch, now: () => t, cacheMs: 1000 });
  const [a, b, c] = await Promise.all([ice(), ice(), ice()]);
  assert.equal(api.calls.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  t = 999;
  await ice();
  assert.equal(api.calls.length, 1);
  t = 1000;
  await ice();
  assert.equal(api.calls.length, 2);
});

test('erro da API vira só STUN, com cache curto antes de tentar de novo', async () => {
  let t = 0;
  const logs = [];
  const api = fakeApi([{ status: 500, body: {} }, new Error('rede fora'), { body: { iceServers: [] } },
    { body: CLOUDFLARE }]);
  const ice = createIceProvider({ keyId: 'k', token: 't', fetch: api.fetch, now: () => t, failMs: 100,
    log: m => logs.push(m) });
  assert.deepEqual(await ice(), STUN_ONLY);
  assert.match(logs[0], /HTTP 500/);
  t = 50;
  assert.deepEqual(await ice(), STUN_ONLY);
  assert.equal(api.calls.length, 1); // dentro do cache de falha
  t = 100;
  assert.deepEqual(await ice(), STUN_ONLY);
  assert.match(logs[1], /rede fora/);
  t = 200;
  assert.deepEqual(await ice(), STUN_ONLY);
  assert.match(logs[2], /sem TURN/);
  t = 300;
  assert.equal((await ice()).length, 2);
  assert.equal(api.calls.length, 4);
});

test('API que não responde: desiste no timeout e entrega STUN', async () => {
  const logs = [];
  const hang = init => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const api = fakeApi([hang]);
  const ice = createIceProvider({ keyId: 'k', token: 't', fetch: api.fetch, timeoutMs: 30, log: m => logs.push(m) });
  const keepAlive = setInterval(() => {}, 1000); // no Node o timer do AbortSignal.timeout não segura o processo
  const t0 = performance.now();
  assert.deepEqual(await ice(), STUN_ONLY);
  clearInterval(keepAlive);
  assert.ok(performance.now() - t0 < 1000);
  assert.match(logs[0], /timeout/);
});
