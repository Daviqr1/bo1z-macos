// Sala da sinalização (signal/src/room.js) sem rede: sockets, relógio, despertador e storage de mentira. Cobre o
// protocolo da docs/COOP-ARCH.md §2 inteiro, os prazos (host/convidado caídos, hello, sala vazia), a volta da
// hibernação (snapshot + attachments) e os abusos (taxa, tamanho, JSON inválido, papéis trocados).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE, CODE_ALPHABET, LIMITS, Room, VERSION, cleanName, isMapZone, limitsFromEnv, makePeerId, makeRoomCode, makeToken,
  normalizeRoomCode, randomString,
} from '../signal/src/room.js';
import { STUN_ONLY } from '../signal/src/ice.js';

const ICE = [{ urls: ['stun:stun.example:3478'] }, { urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' }];
const ORIGIN = 'https://sinal.example';
const CODE = 'K7QX2';

class FakeSocket {
  constructor() { this.out = []; this.closed = null; this.attachment = null; }
  send(text) { if (this.closed) throw new Error('fechado'); this.out.push(JSON.parse(text)); }
  close(code, reason) { this.closed ??= { code, reason }; }
  save(attachment) { this.attachment = structuredClone(attachment); }
  take() { const out = this.out; this.out = []; return out; }
}

function setup({ limits, ice = async () => ICE, random, snapshot = null, code = CODE } = {}) {
  const env = { t: 1_700_000_000_000, alarm: null, saved: null, saves: 0, clears: 0, logs: [] };
  env.room = new Room({ code, snapshot, random, limits, ice, now: () => env.t, log: m => env.logs.push(m),
    setAlarm: at => { env.alarm = at; },
    store: { save: s => { env.saved = structuredClone(s); ++env.saves; }, clear: () => { ++env.clears; } } });
  // Anda o relógio disparando o despertador em cada prazo no caminho, como o runtime faria.
  env.advance = ms => {
    const target = env.t + ms;
    for (let guard = 0; env.alarm !== null && env.alarm <= target; ++guard) {
      assert.ok(guard < 1000, 'despertador em laço');
      env.t = Math.max(env.t, env.alarm);
      env.alarm = null; // o despertador que tocou foi consumido (no Durable Object, o alarm some depois de rodar)
      env.room.alarm();
    }
    env.t = target;
  };
  return env;
}

const msg = (env, sock, m) => env.room.message(sock, typeof m === 'string' ? m : JSON.stringify(m));

async function hello(env, { create = false, ...fields }) {
  const sock = new FakeSocket();
  env.room.attach(sock, { create, origin: ORIGIN, code: env.room.code });
  await msg(env, sock, { t: 'hello', v: VERSION, ...fields });
  const out = sock.take();
  const welcome = out.find(m => m.t === 'welcome'), error = out.find(m => m.t === 'error');
  return { sock, out, welcome, error, id: welcome?.you, token: welcome?.resume };
}
const createHost = (env, name = 'Davi') => hello(env, { create: true, role: 'host', name });
const joinGuest = (env, name = 'Irmão', extra = {}) => hello(env, { role: 'guest', name, room: env.room.code, ...extra });

// Sala com host + n convidados, caixas de saída limpas.
async function roomWith(n, options) {
  const env = setup(options);
  const host = await createHost(env);
  const guests = [];
  for (let i = 0; i < n; ++i) guests.push(await joinGuest(env, `Convidado ${i + 1}`));
  for (const p of [host, ...guests]) p.sock.take();
  return { env, host, guests };
}

const types = sock => sock.take().map(m => m.t);

// ---------------------------------------------------------------- utilitários

test('códigos de sala: 5 caracteres do alfabeto sem 0 O 1 I L; normalização aceita minúsculas e espaços', () => {
  for (let i = 0; i < 2000; ++i) {
    const code = makeRoomCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    assert.equal(normalizeRoomCode(code), code);
  }
  assert.equal(CODE_ALPHABET.length, 31);
  for (const c of '0O1IL') assert.ok(!CODE_ALPHABET.includes(c));
  assert.equal(normalizeRoomCode('k7qx2'), 'K7QX2');
  assert.equal(normalizeRoomCode('  K7QX2 '), 'K7QX2');
  const bads = ['K7QX0', 'K7QXO', 'K7Q', 'K7QX22', '', 'ÁBCDE', 'K7-X2', 12345, null, undefined, {}, 'K7QX2'.repeat(10)];
  for (const bad of bads) {
    assert.equal(normalizeRoomCode(bad), null, String(bad));
  }
});

test('ids de 8 caracteres e tokens de 32, sorteio sem viés (descarta bytes acima do múltiplo)', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => makePeerId()));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[a-km-np-z2-9]{8}$/);
  assert.match(makeToken(), /^[A-Za-z0-9_-]{32}$/);
  // alfabeto de 31: bytes >= 248 são descartados
  const bytes = [255, 250, 248, 0, 247, 30, 31];
  const random = n => Uint8Array.from({ length: n }, () => bytes.shift() ?? 1);
  assert.equal(randomString(CODE_ALPHABET, 4, random), 'A' + CODE_ALPHABET[247 % 31] + CODE_ALPHABET[30] + 'A');
});

test('nomes: 1–24 caracteres visíveis, sem controles nem marcas de direção', () => {
  assert.equal(cleanName('Davi'), 'Davi');
  assert.equal(cleanName('  Irmão  '), 'Irmão');
  assert.equal(cleanName('é'), 'é'); // NFC
  assert.equal(cleanName('🧟 Zumbi'), '🧟 Zumbi');
  assert.equal(cleanName('🧟'.repeat(24)), '🧟'.repeat(24)); // conta code points, não unidades UTF-16
  assert.equal(cleanName('x'.repeat(24)), 'x'.repeat(24));
  for (const bad of ['', '   ', 'x'.repeat(25), 'a\u0000b', 'a\nb', 'a\tb', '‮evil', 'a​b', '⁦x', 'a b',
    '\uD800x', '‍', 42, null, undefined, ['Davi']]) {
    assert.equal(cleanName(bad), null, JSON.stringify(bad));
  }
});

test('mapas e limites do ambiente', () => {
  assert.ok(isMapZone('zombie_coast'));
  for (const bad of ['Zombie_coast', '../x', '', 'a'.repeat(49), 'zombie coast', null, 3]) {
    assert.ok(!isMapZone(bad), String(bad));
  }
  assert.deepEqual(limitsFromEnv({ HOST_GRACE_MS: '1500', GUEST_GRACE_MS: 'abc', EMPTY_TTL_MS: '-5', HELLO_TIMEOUT_MS: '' }),
    { hostGraceMs: 1500 });
  assert.deepEqual(limitsFromEnv(undefined), {});
});

// ---------------------------------------------------------------- criação e entrada

test('host cria a sala: welcome completo, estado salvo, attachment com o id', async () => {
  const env = setup();
  assert.ok(env.room.canCreate());
  const host = await createHost(env);
  assert.deepEqual(host.out.map(m => m.t), ['welcome']);
  const w = host.welcome;
  assert.equal(w.room, CODE);
  assert.match(w.you, /^[a-z2-9]{8}$/);
  assert.equal(w.role, 'host');
  assert.equal(w.hostId, w.you);
  assert.deepEqual(w.peers, []);
  assert.deepEqual(w.lobby, { map: null });
  assert.deepEqual(w.ice, ICE);
  assert.match(w.resume, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(w.invite, `${ORIGIN}/j/${CODE}`);
  assert.equal(w.started, null);
  assert.equal(env.saved.created, true);
  assert.equal(env.saved.hostId, w.you);
  assert.equal(host.sock.attachment.id, w.you);
  assert.equal(host.sock.closed, null);
  assert.equal(env.room.canCreate(), false);
  assert.equal(env.alarm, env.t + LIMITS.emptyTtlMs); // só a ronda
});

test('criação reservada: outra criação no mesmo código é recusada até o socket pendente sumir', () => {
  const env = setup();
  const pending = new FakeSocket();
  env.room.attach(pending, { create: true, origin: ORIGIN, code: CODE });
  assert.equal(env.room.canCreate(), false);
  assert.equal(env.alarm, env.t + LIMITS.helloTimeoutMs); // prazo do hello
  env.room.disconnect(pending);
  assert.equal(env.room.canCreate(), true);
  assert.equal(env.alarm, null);
  assert.ok(env.room.idle);
});

test('convidados entram: welcome lista os outros; quem já estava recebe peer-joined', async () => {
  const env = setup();
  const host = await createHost(env, 'Davi');
  const g1 = await joinGuest(env, 'Irmão');
  assert.equal(g1.welcome.role, 'guest');
  assert.equal(g1.welcome.hostId, host.id);
  assert.deepEqual(g1.welcome.peers, [{ id: host.id, name: 'Davi', role: 'host', ready: true }]);
  assert.equal(g1.welcome.invite, `${ORIGIN}/j/${CODE}`);
  assert.notEqual(g1.welcome.resume, host.token);
  assert.deepEqual(host.sock.take(),
    [{ t: 'peer-joined', peer: { id: g1.id, name: 'Irmão', role: 'guest', ready: false } }]);
  const g2 = await joinGuest(env, 'Primo');
  assert.deepEqual(g2.welcome.peers.map(p => p.id), [host.id, g1.id]);
  const joined = { t: 'peer-joined', peer: { id: g2.id, name: 'Primo', role: 'guest', ready: false } };
  for (const s of [host.sock, g1.sock]) assert.deepEqual(s.take(), [joined]);
  assert.deepEqual(env.saved.peers.map(p => p.id), [host.id, g1.id, g2.id]);
});

test('hello inválido: erro certo e conexão fechada', async () => {
  const cases = [
    [{ role: 'guest', name: 'x', room: CODE, v: 2 }, 'version'],
    [{ role: 'guest', name: 'x', room: CODE, v: undefined }, 'version'],
    [{ role: 'admin', name: 'x', room: CODE }, 'bad-message'],
    [{ role: 'guest', name: '', room: CODE }, 'name'],
    [{ role: 'guest', name: 'a\u0007b', room: CODE }, 'name'],
    [{ role: 'guest', name: 'x'.repeat(25), room: CODE }, 'name'],
    [{ role: 'guest', name: 'x', room: 'K7QX0' }, 'room-not-found'],
    [{ role: 'guest', name: 'x', room: 'ZZZZZ' }, 'room-not-found'],
    [{ role: 'guest', name: 'x' }, 'room-not-found'],
    [{ role: 'host', name: 'x' }, 'bad-message'], // criar só pela rota de criação
    [{ role: 'host', name: 'x', room: CODE }, 'forbidden'], // host com código precisa de resume
    [{ role: 'guest', name: 'x', room: CODE, resume: 'curto' }, 'bad-message'],
    [{ role: 'guest', name: 'x', room: CODE, resume: 'A'.repeat(32) }, 'forbidden'],
  ];
  for (const [fields, code] of cases) {
    const env = setup();
    await createHost(env);
    const r = await hello(env, fields);
    assert.equal(r.welcome, undefined, JSON.stringify(fields));
    assert.equal(r.error?.code, code, JSON.stringify(fields));
    assert.equal(typeof r.error.message, 'string');
    assert.equal(r.sock.closed?.code, CLOSE.error, JSON.stringify(fields));
  }
  // sala ainda não criada: convidado não acha; convidado pela rota de criação é orientado a usar ?room=
  const env = setup();
  assert.equal((await joinGuest(env)).error.code, 'room-not-found');
  assert.equal((await hello(env, { create: true, role: 'guest', name: 'x', room: CODE })).error.code, 'bad-message');
  assert.equal(env.room.canCreate(), true);
});

test('antes do hello: qualquer outra coisa (ou lixo) fecha a conexão', async () => {
  const raws = [JSON.stringify({ t: 'ping', ts: 1 }), 'não é json', '[1,2]', '{"x":1}', 'null', new Uint8Array([1, 2])];
  for (const raw of raws) {
    const env = setup();
    const sock = new FakeSocket();
    env.room.attach(sock, { origin: ORIGIN, code: CODE });
    env.room.message(sock, raw);
    assert.equal(sock.take()[0].code, 'bad-message');
    assert.equal(sock.closed.code, CLOSE.error);
  }
});

test('sala cheia: host + 3; o quinto recebe room-full; quem sai libera a vaga', async () => {
  const { env, guests } = await roomWith(3);
  const extra = await joinGuest(env, 'Quinto');
  assert.equal(extra.error.code, 'room-full');
  assert.equal(extra.sock.closed.code, CLOSE.error);
  msg(env, guests[0].sock, { t: 'leave' });
  assert.ok((await joinGuest(env, 'Quinto')).welcome);
});

test('limite de sockets por sala e de ids por sala', async () => {
  const env = setup({ limits: { maxSockets: 2 } });
  const a = new FakeSocket(), b = new FakeSocket(), c = new FakeSocket();
  assert.ok(env.room.attach(a, { create: true, code: CODE }));
  assert.ok(env.room.attach(b, { code: CODE }));
  assert.equal(env.room.attach(c, { code: CODE }), false);
  assert.equal(c.take()[0].code, 'room-full');
  assert.equal(c.closed.code, CLOSE.error);

  const env2 = setup({ limits: { maxIds: 3 } });
  await createHost(env2);
  const g1 = await joinGuest(env2);
  msg(env2, g1.sock, { t: 'leave' });
  assert.ok((await joinGuest(env2)).welcome); // 3º id
  assert.equal((await joinGuest(env2)).error.code, 'room-full'); // ids esgotados (mesmo com vaga)
});

test('ids nunca se repetem na sala, nem com o sorteio colidindo', async () => {
  const script = [];
  const random = n => script.length ? script.shift() : crypto.getRandomValues(new Uint8Array(n));
  const zeros = new Uint8Array(16);
  const env = setup({ random });
  script.push(zeros); // id do host = 'aaaaaaaa'
  const host = await createHost(env);
  assert.equal(host.id, 'aaaaaaaa');
  script.push(zeros); // convidado sorteia o mesmo id: tem de sortear de novo
  const g1 = await joinGuest(env);
  assert.notEqual(g1.id, host.id);
  msg(env, g1.sock, { t: 'leave' });
  script.push(Uint8Array.from(g1.id, c => 'abcdefghijkmnpqrstuvwxyz23456789'.indexOf(c))); // o id de quem saiu
  const g2 = await joinGuest(env);
  assert.ok(![host.id, g1.id].includes(g2.id));
});

// ---------------------------------------------------------------- mensagens na sala

test('signal: estrela host ⇄ convidado; convidado ⇄ convidado proibido; destino ausente descartado', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  msg(env, g1.sock, { t: 'signal', to: host.id, data: { sdp: { type: 'offer', sdp: 'v=0...' } } });
  assert.deepEqual(host.sock.take(), [{ t: 'signal', from: g1.id, data: { sdp: { type: 'offer', sdp: 'v=0...' } } }]);
  msg(env, host.sock, { t: 'signal', to: g2.id, data: { candidate: { candidate: 'candidate:1', sdpMid: '0' } } });
  assert.deepEqual(g2.sock.take(),
    [{ t: 'signal', from: host.id, data: { candidate: { candidate: 'candidate:1', sdpMid: '0' } } }]);
  assert.deepEqual(g1.sock.take(), []);

  msg(env, g1.sock, { t: 'signal', to: g2.id, data: {} });
  assert.equal(g1.sock.take()[0].code, 'forbidden');
  assert.deepEqual(g2.sock.take(), []);
  msg(env, host.sock, { t: 'signal', to: host.id, data: {} });
  assert.equal(host.sock.take()[0].code, 'forbidden');

  const before = env.room.counters.dropped;
  msg(env, g1.sock, { t: 'signal', to: 'zzzzzzzz', data: {} });
  msg(env, g1.sock, { t: 'signal', to: '__proto__', data: {} });
  assert.deepEqual(g1.sock.take(), []);
  assert.equal(env.room.counters.dropped, before + 2);

  const bads = [{ to: host.id }, { to: host.id, data: [1] }, { to: host.id, data: null }, { to: 5, data: {} }, { data: {} }];
  for (const bad of bads) {
    msg(env, g1.sock, { t: 'signal', ...bad });
    assert.equal(g1.sock.take()[0].code, 'bad-message', JSON.stringify(bad));
  }
  assert.equal(g1.sock.closed, null); // erro depois do welcome não derruba
  assert.deepEqual(host.sock.take(), []);
});

test('lobby: só o host; mapa validado; todos recebem; mapa novo desfaz o pronto', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  msg(env, host.sock, { t: 'lobby', data: { map: 'zombie_coast' } });
  for (const s of [host.sock, g1.sock, g2.sock]) assert.deepEqual(s.take(), [{ t: 'lobby', data: { map: 'zombie_coast' } }]);
  assert.equal(env.saved.lobby.map, 'zombie_coast');

  msg(env, g1.sock, { t: 'lobby', data: { map: 'zombie_moon' } });
  assert.equal(g1.sock.take()[0].code, 'forbidden');
  for (const bad of [{}, { data: {} }, { data: { map: 'Zombie' } }, { data: 'zombie_moon' }]) {
    msg(env, host.sock, { t: 'lobby', ...bad });
    assert.equal(host.sock.take()[0].code, 'bad-message');
  }

  msg(env, g1.sock, { t: 'ready', ready: true });
  for (const s of [host.sock, g1.sock, g2.sock]) s.take();
  msg(env, host.sock, { t: 'lobby', data: { map: 'zombie_coast' } }); // mesmo mapa: pronto continua
  assert.deepEqual(g2.sock.take(), [{ t: 'lobby', data: { map: 'zombie_coast' } }]);
  msg(env, host.sock, { t: 'lobby', data: { map: 'zombie_moon' } });
  assert.deepEqual(g2.sock.take(),
    [{ t: 'lobby', data: { map: 'zombie_moon' } }, { t: 'peer-ready', id: g1.id, ready: false }]);
});

test('ready: só convidado, booleano; todos recebem peer-ready', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  msg(env, g1.sock, { t: 'ready', ready: true });
  for (const s of [host.sock, g1.sock, g2.sock]) assert.deepEqual(s.take(), [{ t: 'peer-ready', id: g1.id, ready: true }]);
  assert.equal(env.saved.peers.find(p => p.id === g1.id).ready, true);
  msg(env, host.sock, { t: 'ready', ready: true });
  assert.equal(host.sock.take()[0].code, 'forbidden');
  msg(env, g1.sock, { t: 'ready', ready: 'sim' });
  assert.equal(g1.sock.take()[0].code, 'bad-message');
  // quem entra depois vê o pronto
  assert.equal((await joinGuest(env)).welcome.peers.find(p => p.id === g1.id).ready, true);
});

test('start: só o host; usa o mapa do lobby se não vier; todos recebem com a hora do servidor', async () => {
  const { env, host, guests: [g1] } = await roomWith(1);
  msg(env, host.sock, { t: 'start' });
  assert.equal(host.sock.take()[0].code, 'bad-message'); // sem mapa nenhum
  msg(env, g1.sock, { t: 'start', map: 'zombie_coast' });
  assert.equal(g1.sock.take()[0].code, 'forbidden');
  msg(env, host.sock, { t: 'start', map: 'zombie_coast' });
  for (const s of [host.sock, g1.sock]) assert.deepEqual(s.take(), [{ t: 'start', map: 'zombie_coast', at: env.t }]);
  env.advance(5000);
  msg(env, host.sock, { t: 'lobby', data: { map: 'zombie_moon' } });
  msg(env, host.sock, { t: 'start' });
  assert.deepEqual(g1.sock.take().at(-1), { t: 'start', map: 'zombie_moon', at: env.t });
  const late = await joinGuest(env, 'Atrasado');
  assert.deepEqual(late.welcome.started, { map: 'zombie_moon', at: env.t });
  assert.deepEqual(late.welcome.lobby, { map: 'zombie_moon' });
});

test('kick: o expulso recebe closed e cai; os outros recebem peer-left; não volta com o token', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  msg(env, g1.sock, { t: 'kick', id: g2.id });
  assert.equal(g1.sock.take()[0].code, 'forbidden');
  for (const id of [host.id, 'zzzzzzzz', undefined]) {
    msg(env, host.sock, { t: 'kick', id });
    assert.equal(host.sock.take()[0].code, 'bad-message');
  }
  msg(env, host.sock, { t: 'kick', id: g2.id });
  assert.deepEqual(g2.sock.take(), [{ t: 'closed', reason: 'kicked' }]);
  assert.equal(g2.sock.closed.code, CLOSE.normal);
  for (const s of [host.sock, g1.sock]) assert.deepEqual(s.take(), [{ t: 'peer-left', id: g2.id, reason: 'kicked' }]);
  env.room.disconnect(g2.sock); // o close chega depois: nada muda
  assert.equal((await joinGuest(env, 'Volta', { resume: g2.token })).error.code, 'forbidden');
  assert.ok(!env.saved.peers.some(p => p.id === g2.id));
});

test('ping/pong: com ts devolve ts e a hora do servidor; ping puro, pong puro', async () => {
  const { env, guests: [g1] } = await roomWith(1);
  msg(env, g1.sock, { t: 'ping', ts: 123.5 });
  msg(env, g1.sock, '{"t":"ping"}');
  msg(env, g1.sock, { t: 'ping', ts: 'x' });
  const out = g1.sock.take();
  assert.deepEqual(out.slice(0, 2), [{ t: 'pong', ts: 123.5, now: env.t }, { t: 'pong' }]);
  assert.equal(out[2].code, 'bad-message');
});

test('leave do convidado: peer-left para os outros, socket fechado, token invalidado', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  msg(env, g1.sock, { t: 'leave' });
  assert.equal(g1.sock.closed.code, CLOSE.normal);
  assert.deepEqual(g1.sock.take(), []);
  for (const s of [host.sock, g2.sock]) assert.deepEqual(s.take(), [{ t: 'peer-left', id: g1.id, reason: 'left' }]);
  assert.equal((await joinGuest(env, 'x', { resume: g1.token })).error.code, 'forbidden');
  env.advance(LIMITS.guestGraceMs * 2); // sem peer-left 'lost' depois
  assert.deepEqual(host.sock.take(), []);
});

test('leave do host: a sala acaba na hora para todos e o estado é apagado', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  msg(env, host.sock, { t: 'leave' });
  for (const p of [host, g1, g2]) {
    assert.deepEqual(p.sock.take(), [{ t: 'closed', reason: 'host-left' }]);
    assert.equal(p.sock.closed.code, CLOSE.normal);
  }
  assert.equal(env.room.closed, 'host-left');
  assert.equal(env.clears, 1);
  assert.equal(env.alarm, null);
  assert.ok(env.room.idle);
  const late = await joinGuest(env);
  assert.equal(late.error.code, 'room-not-found');
  assert.equal(env.room.attach(new FakeSocket(), { code: CODE }), false);
  assert.equal(env.room.canCreate(), false);
  env.room.message(g1.sock, '{"t":"ping"}'); // socket velho: ignorado
  assert.deepEqual(g1.sock.take(), []);
});

// ---------------------------------------------------------------- quedas e prazos

test('host cai e volta com resume em menos de 30 s: mesmo id, ninguém é avisado, sala segue', async () => {
  const { env, host, guests: [g1] } = await roomWith(1);
  env.room.disconnect(host.sock);
  assert.equal(env.alarm, env.t + LIMITS.hostGraceMs);
  assert.ok(env.saved.peers.find(p => p.id === host.id).offlineAt !== null);
  msg(env, g1.sock, { t: 'signal', to: host.id, data: { sdp: 'perdido' } }); // host sem conexão: descartado
  env.advance(29_000);
  assert.deepEqual(g1.sock.take(), []);
  const back = await hello(env, { role: 'host', name: 'Davi', room: CODE, resume: host.token });
  assert.equal(back.welcome.you, host.id);
  assert.equal(back.welcome.role, 'host');
  assert.equal(back.welcome.resume, host.token);
  assert.deepEqual(back.welcome.peers.map(p => p.id), [g1.id]);
  env.advance(120_000); // o despertador do prazo antigo toca e não faz nada (vira ronda)
  assert.deepEqual(g1.sock.take(), []);
  msg(env, g1.sock, { t: 'signal', to: host.id, data: { sdp: 'oi' } });
  assert.deepEqual(back.sock.take(), [{ t: 'signal', from: g1.id, data: { sdp: 'oi' } }]);
  assert.equal(env.room.closed, null);
});

test('host cai e não volta: closed host-left para todos depois de 30 s', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  env.room.disconnect(host.sock);
  env.advance(LIMITS.hostGraceMs - 1);
  assert.deepEqual(g1.sock.take(), []);
  env.advance(1);
  for (const g of [g1, g2]) {
    assert.deepEqual(g.sock.take(), [{ t: 'closed', reason: 'host-left' }]);
    assert.equal(g.sock.closed.code, CLOSE.normal);
  }
  assert.equal(env.room.closed, 'host-left');
  assert.equal(env.clears, 1);
  const late = await hello(env, { role: 'host', name: 'Davi', room: CODE, resume: host.token });
  assert.equal(late.error.code, 'room-not-found');
});

test('convidado cai: volta em silêncio em 30 s; depois vira peer-left lost e pode voltar com peer-joined', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  env.room.disconnect(g1.sock);
  env.advance(10_000);
  const back = await joinGuest(env, 'Convidado 1', { resume: g1.token });
  assert.equal(back.welcome.you, g1.id);
  assert.deepEqual(back.welcome.peers.map(p => p.id), [host.id, g2.id]);
  assert.deepEqual(host.sock.take(), []);
  assert.deepEqual(g2.sock.take(), []);

  env.room.disconnect(back.sock);
  env.advance(LIMITS.guestGraceMs);
  for (const s of [host.sock, g2.sock]) assert.deepEqual(s.take(), [{ t: 'peer-left', id: g1.id, reason: 'lost' }]);
  assert.ok(!(await joinGuest(env, 'Novo')).welcome.peers.some(p => p.id === g1.id)); // perdido não aparece nem ocupa vaga
  host.sock.take(); g2.sock.take();

  const again = await joinGuest(env, 'Convidado 1', { resume: g1.token }); // sala: host, g2, Novo + ele = 4
  assert.equal(again.welcome.you, g1.id);
  const joined = { t: 'peer-joined', peer: { id: g1.id, name: 'Convidado 1', role: 'guest', ready: false } };
  for (const s of [host.sock, g2.sock]) assert.deepEqual(s.take(), [joined]);
});

test('convidado perdido não volta se a sala lotou nesse meio-tempo', async () => {
  const { env, guests: [g1] } = await roomWith(3);
  env.room.disconnect(g1.sock);
  env.advance(LIMITS.guestGraceMs);
  assert.ok((await joinGuest(env, 'Substituto')).welcome);
  assert.equal((await joinGuest(env, 'Convidado 1', { resume: g1.token })).error.code, 'room-full');
});

test('pronto de quem caiu e não voltou é desfeito', async () => {
  const { env, guests: [g1] } = await roomWith(1);
  msg(env, g1.sock, { t: 'ready', ready: true });
  env.room.disconnect(g1.sock);
  env.advance(LIMITS.guestGraceMs);
  const back = await joinGuest(env, 'x', { resume: g1.token });
  assert.equal(env.saved.peers.find(p => p.id === g1.id).ready, false);
  assert.equal(back.welcome.role, 'guest');
});

test('reentrada com a conexão antiga ainda aberta (meia-aberta): a nova assume, a antiga é fechada', async () => {
  const { env, host, guests: [g1] } = await roomWith(1);
  const fresh = await joinGuest(env, 'Convidado 1', { resume: g1.token });
  assert.equal(fresh.welcome.you, g1.id);
  assert.equal(g1.sock.closed.code, CLOSE.replaced);
  env.room.disconnect(g1.sock); // o close da antiga chega depois: não pode marcar o jogador como caído
  env.advance(LIMITS.guestGraceMs * 2);
  assert.deepEqual(host.sock.take(), []);
  msg(env, host.sock, { t: 'signal', to: g1.id, data: { x: 1 } });
  assert.deepEqual(fresh.sock.take(), [{ t: 'signal', from: host.id, data: { x: 1 } }]);
  assert.deepEqual(g1.sock.take(), []);
});

test('hello que não chega em 10 s: conexão fechada', () => {
  const env = setup();
  const sock = new FakeSocket();
  env.room.attach(sock, { code: CODE });
  env.advance(LIMITS.helloTimeoutMs - 1);
  assert.equal(sock.closed, null);
  env.advance(1);
  assert.equal(sock.closed.code, CLOSE.timeout);
  assert.equal(sock.take()[0].code, 'bad-message');
  assert.equal(env.alarm, null);
});

test('sala sem nenhuma conexão por 10 min some (expired)', async () => {
  // Com a tolerância padrão do host (30 s) a sala acaba antes; aqui a tolerância é maior para exercitar a expiração.
  const env = setup({ limits: { hostGraceMs: 60 * 60e3 } });
  const host = await createHost(env);
  env.room.disconnect(host.sock);
  assert.equal(env.alarm, env.t + LIMITS.emptyTtlMs);
  env.advance(LIMITS.emptyTtlMs - 1);
  assert.equal(env.room.closed, null);
  env.advance(1);
  assert.equal(env.room.closed, 'expired');
  assert.equal(env.clears, 1);
});

test('ronda: sala viva sempre tem despertador; reinício sem webSocketClose encerra a sala abandonada', async () => {
  const { env, host, guests: [g1] } = await roomWith(1);
  const armed = () => env.alarm !== null && env.alarm > env.t && env.alarm <= env.t + LIMITS.emptyTtlMs;
  assert.ok(armed()); // o prazo do hello que já passou fica valendo como ronda
  const before = env.alarm;
  msg(env, g1.sock, { t: 'ping', ts: 1 }); // mensagens comuns não regravam o alarm
  assert.equal(env.alarm, before);
  env.advance(LIMITS.emptyTtlMs * 3); // a ronda toca, todo mundo conectado: nada muda, rearma
  assert.equal(env.room.closed, null);
  assert.ok(armed());
  assert.deepEqual(host.sock.take(), []);
  assert.deepEqual(g1.sock.take().map(m => m.t), ['pong']);

  // O runtime reiniciou (deploy): as conexões sumiram sem aviso. O alarm durável acorda um objeto novo, sem sockets.
  const snapshot = structuredClone(env.saved);
  const env2 = setup({ snapshot, code: null });
  env2.t = env.alarm;
  env2.room.restore([]);
  env2.room.alarm();
  assert.equal(env2.alarm, env2.t + LIMITS.hostGraceMs);
  env2.advance(LIMITS.hostGraceMs);
  assert.equal(env2.room.closed, 'host-left');
  assert.equal(env2.clears, 1);
});

// ---------------------------------------------------------------- hello assíncrono (ICE)

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('mensagens que chegam enquanto o hello espera o ICE são processadas depois do welcome, em ordem', async () => {
  const env = setup();
  await createHost(env);
  const d = deferred();
  env.room.ice = () => d.promise;
  const sock = new FakeSocket();
  env.room.attach(sock, { code: CODE });
  const pending = msg(env, sock, { t: 'hello', v: 1, role: 'guest', name: 'x', room: CODE });
  msg(env, sock, { t: 'ping', ts: 1 });
  msg(env, sock, { t: 'ping', ts: 2 });
  assert.deepEqual(sock.out, []);
  d.resolve(ICE);
  await pending;
  assert.deepEqual(sock.take().map(m => m.t + (m.ts ?? '')), ['welcome', 'pong1', 'pong2']);
});

test('fila do hello tem limite; socket que fecha durante a espera não entra', async () => {
  const env = setup();
  const host = await createHost(env);
  const d = deferred();
  env.room.ice = () => d.promise;
  const flood = new FakeSocket(), quitter = new FakeSocket();
  env.room.attach(flood, { code: CODE });
  env.room.attach(quitter, { code: CODE });
  const p1 = msg(env, flood, { t: 'hello', v: 1, role: 'guest', name: 'x', room: CODE });
  const p2 = msg(env, quitter, { t: 'hello', v: 1, role: 'guest', name: 'y', room: CODE });
  for (let i = 0; i <= LIMITS.maxQueued; ++i) msg(env, flood, { t: 'ping' });
  assert.equal(flood.closed.code, CLOSE.error);
  env.room.disconnect(quitter);
  d.resolve(ICE);
  await Promise.all([p1, p2]);
  assert.ok(!flood.out.some(m => m.t === 'welcome'));
  assert.deepEqual(quitter.out, []);
  assert.deepEqual(host.sock.take(), []); // ninguém entrou
  assert.equal(env.room.present().length, 1);
});

test('dois convidados disputam a última vaga durante a espera do ICE: um entra, o outro recebe room-full', async () => {
  const { env } = await roomWith(2);
  const d = deferred();
  env.room.ice = () => d.promise;
  const a = new FakeSocket(), b = new FakeSocket();
  env.room.attach(a, { code: CODE });
  env.room.attach(b, { code: CODE });
  const pa = msg(env, a, { t: 'hello', v: 1, role: 'guest', name: 'A', room: CODE });
  const pb = msg(env, b, { t: 'hello', v: 1, role: 'guest', name: 'B', room: CODE });
  d.resolve(ICE);
  await Promise.all([pa, pb]);
  assert.equal(a.out[0].t, 'welcome');
  assert.equal(b.out[0].code, 'room-full');
  assert.equal(b.closed.code, CLOSE.error);
});

test('ICE que falha vira só STUN (a entrada não depende do TURN)', async () => {
  const env = setup({ ice: async () => { throw new Error('API fora'); } });
  const host = await createHost(env);
  assert.deepEqual(host.welcome.ice, STUN_ONLY);
});

// ---------------------------------------------------------------- abusos

test('taxa: rajada de 100, depois 50/s; acima disso error rate e fechamento', async () => {
  const { env, guests: [g1] } = await roomWith(1);
  for (let i = 0; i < LIMITS.rateBurst - 1; ++i) msg(env, g1.sock, '{"t":"ping"}'); // o hello gastou uma ficha
  assert.equal(g1.sock.closed, null);
  env.advance(1000); // +50 fichas
  for (let i = 0; i < LIMITS.ratePerSecond; ++i) msg(env, g1.sock, '{"t":"ping"}');
  assert.equal(g1.sock.closed, null);
  msg(env, g1.sock, '{"t":"ping"}');
  assert.equal(g1.sock.out.at(-1).code, 'rate');
  assert.equal(g1.sock.closed.code, CLOSE.rate);
  // a queda por taxa é uma queda comum: pode voltar com resume
  assert.equal((await joinGuest(env, 'x', { resume: g1.token })).welcome.you, g1.id);
});

test('tamanho: até 16 KiB em UTF-8 passa; acima fecha com 1009 (conta bytes, não caracteres)', async () => {
  const { env, host, guests: [g1] } = await roomWith(1);
  const fits = JSON.stringify({ t: 'signal', to: host.id, data: { sdp: '€'.repeat(5000) } }); // ~15 KB
  assert.ok(fits.length < 16384 && Buffer.byteLength(fits) <= 16384);
  msg(env, g1.sock, fits);
  assert.equal(host.sock.take()[0].data.sdp.length, 5000);
  const big = JSON.stringify({ t: 'signal', to: host.id, data: { sdp: '€'.repeat(5500) } }); // < 16384 chars, > 16 KiB
  assert.ok(big.length < 16384 && Buffer.byteLength(big) > 16384);
  msg(env, g1.sock, big);
  assert.equal(g1.sock.take()[0].code, 'bad-message');
  assert.equal(g1.sock.closed.code, CLOSE.tooBig);
  assert.deepEqual(host.sock.take(), []);
});

test('lixo depois do welcome gera erro sem derrubar; insistir derruba', async () => {
  const { env, guests: [g1] } = await roomWith(1);
  for (const raw of ['{', '[]', '{"t":5}', '{"t":"teleporte"}', '{"t":"hello","v":1}', new Uint8Array([0xff])]) {
    env.room.message(g1.sock, raw);
    assert.equal(g1.sock.take()[0].code, 'bad-message');
  }
  for (let i = 0; i < LIMITS.maxBadMessages; ++i) msg(env, g1.sock, { t: 'nada' });
  assert.equal(g1.sock.closed.code, CLOSE.error);
});

test('JSON com __proto__ não contamina nada e é repassado como dado opaco', async () => {
  const { env, host, guests: [g1] } = await roomWith(1);
  env.room.message(g1.sock, `{"t":"signal","to":"${host.id}","data":{"__proto__":{"polluted":true}}}`);
  const got = host.sock.take()[0];
  assert.equal(got.t, 'signal');
  assert.equal(({}).polluted, undefined);
});

// ---------------------------------------------------------------- hibernação

test('volta da hibernação: snapshot + attachments reconstroem a sala inteira', async () => {
  const { env, host, guests: [g1, g2] } = await roomWith(2);
  msg(env, host.sock, { t: 'lobby', data: { map: 'zombie_coast' } });
  msg(env, g1.sock, { t: 'ready', ready: true });
  for (const p of [host, g1, g2]) p.sock.take();
  const snapshot = structuredClone(env.saved);

  // objeto novo (constructor de novo): mesmos sockets abertos, só que g2 caiu enquanto o objeto dormia
  const env2 = setup({ snapshot, code: null });
  env2.t = env.t + 20_000;
  env2.room.restore([host, g1].map(p => ({ socket: p.sock, attachment: p.sock.attachment })));
  assert.equal(env2.room.code, CODE);
  assert.equal(env2.alarm, null); // o restore não mexe no alarm; o evento que acordou o objeto acerta
  assert.ok(env2.saved.peers.find(p => p.id === g2.id).offlineAt === env2.t);
  msg(env2, g1.sock, { t: 'signal', to: host.id, data: { sdp: 'depois' } }); // o evento que acordou o objeto
  assert.deepEqual(host.sock.take(), [{ t: 'signal', from: g1.id, data: { sdp: 'depois' } }]);
  assert.equal(env2.alarm, env2.t + LIMITS.guestGraceMs); // g2 começa a contar do despertar

  const fresh = await joinGuest(env2, 'Novo');
  assert.deepEqual(fresh.welcome.lobby, { map: 'zombie_coast' });
  assert.deepEqual(fresh.welcome.peers.map(p => [p.id, p.ready]), [[host.id, true], [g1.id, true], [g2.id, false]]);
  assert.ok(![host.id, g1.id, g2.id].includes(fresh.id));
  assert.equal(fresh.welcome.invite, `${ORIGIN}/j/${CODE}`);

  env2.advance(LIMITS.guestGraceMs);
  assert.deepEqual(host.sock.take().at(-1), { t: 'peer-left', id: g2.id, reason: 'lost' });
  assert.equal((await joinGuest(env2, 'x', { resume: g2.token })).welcome.you, g2.id); // token sobreviveu
});

test('hibernação: host caído no sono tem 30 s a partir do despertar; socket de desconhecido é fechado', async () => {
  const { env, guests: [g1] } = await roomWith(1);
  const snapshot = structuredClone(env.saved);
  const env2 = setup({ snapshot, code: null });
  const stranger = new FakeSocket();
  env2.room.restore([
    { socket: g1.sock, attachment: g1.sock.attachment },
    { socket: stranger, attachment: { code: CODE, id: 'zzzzzzzz' } },
  ]);
  assert.equal(stranger.take()[0].code, 'room-not-found');
  assert.ok(stranger.closed);
  env2.room.disconnect(stranger); // o evento que acordou o objeto: o close do socket estranho
  assert.equal(env2.alarm, env2.t + LIMITS.hostGraceMs);
  env2.advance(LIMITS.hostGraceMs);
  assert.deepEqual(g1.sock.take(), [{ t: 'closed', reason: 'host-left' }]);
  assert.equal(env2.room.closed, 'host-left');
});

test('hibernação: socket que ainda não tinha mandado hello volta como pendente', () => {
  const env = setup({ code: null });
  const sock = new FakeSocket();
  env.room.restore([{ socket: sock, attachment: { code: CODE, create: true, origin: ORIGIN, at: env.t - 4000, id: null } }]);
  assert.equal(env.room.code, CODE);
  assert.equal(env.room.canCreate(), false);
  env.room.alarm(); // acordou pelo alarm do prazo do hello, que ainda não venceu: remarca
  assert.equal(sock.closed, null);
  assert.equal(env.alarm, env.t - 4000 + LIMITS.helloTimeoutMs);
});

test('info() resume a sala para logs', async () => {
  const { env, host } = await roomWith(1);
  const info = env.room.info();
  assert.equal(info.code, CODE);
  assert.equal(info.players.length, 2);
  assert.equal(info.players[0].id, host.id);
  assert.equal(info.players[0].online, true);
});
