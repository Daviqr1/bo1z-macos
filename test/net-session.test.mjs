// Janela net no Node (COOP-ARCH §1, §2, §4, §5): NetSession + SignalClient + PeerLink com sinalização
// (StubSignal), WebSocket, RTCPeerConnection, relógio e MessagePorts falsos. O WebRTC de verdade está no
// net-e2e.test.mjs (Electron).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NetSession } from '../app/net/session.mjs';
import { SignalClient, validateServerMessage } from '../app/net/signal-client.mjs';
import { MAX_BUFFERED } from '../app/net/peer.mjs';
import { normalizeSignalUrl, parseRoomCode, sanitizeName } from '../app/net/util.mjs';
import { FakeClock, FakeNet, FakePort, fakeWebSocket } from './net-fakes.mjs';
import { StubSignal } from './net-stub-signal.mjs';

function world({ graceMs = 0, latency = 10, echoStart = true } = {}) {
  const clock = new FakeClock();
  const stub = new StubSignal({ now: clock.wall, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, graceMs,
    echoStart });
  const WS = fakeWebSocket(stub);
  const net = new FakeNet(clock, { latency });
  const logs = [];
  const make = name => {
    const session = new NetSession({ WebSocket: WS, RTCPeerConnection: net.RTCPeerConnection, clock, random: () => 1,
      log: line => logs.push(`${clock.t} ${name}: ${line}`), onState: state => { session.states.push(state); } });
    session.states = [];
    session.last = () => session.states.at(-1);
    session.command('config', { signalUrl: 'wss://sinal.teste', name });
    return session;
  };
  return { clock, stub, WS, net, logs, make };
}

// Host com página pronta + n convidados conectados (cada um com a sua página).
async function room(w, guests = 1) {
  const host = w.make('Davi');
  host.page = new FakePort();
  host.attachPort(host.page);
  host.page.page({ t: 'ready', role: 'host', rings: [524, 525, 526] });
  host.command('create', { name: 'Davi', map: 'zombie_coast' });
  await w.clock.advance(10);
  const list = [];
  for (let i = 0; i < guests; ++i) {
    const g = w.make(`Irmao${i}`);
    g.page = new FakePort();
    g.attachPort(g.page);
    g.page.page({ t: 'ready', role: 'guest', rings: [] });
    g.command('join', { code: host.last().room });
    await w.clock.advance(100);
    g.id = g.last().you.id;
    list.push(g);
  }
  await w.clock.advance(1000);
  return { host, guests: list };
}

const packet = (n, size = 1264) => { const b = new Uint8Array(size); b.fill(n & 0xff); b[0] = n >> 8; return b; };
const pkts = port => port.of('pkt');

test('util: código da sala, convite, URL de sinalização e nome', () => {
  assert.deepEqual(parseRoomCode(' abc-23 '), { code: 'ABC23', server: null });
  const fromInvite = { code: 'QWE45', server: 'wss://coop.exemplo.com' };
  assert.deepEqual(parseRoomCode('https://coop.exemplo.com/j/QWE45'), fromInvite);
  assert.deepEqual(parseRoomCode('bo1z://join/QWE45?s=coop.exemplo.com'), fromInvite);
  assert.equal(parseRoomCode('ABC1O'), null); // 1 e O não existem no alfabeto
  assert.equal(parseRoomCode('ABCD'), null);
  assert.equal(normalizeSignalUrl('coop.exemplo.com'), 'wss://coop.exemplo.com/ws?v=1');
  assert.equal(normalizeSignalUrl('https://coop.exemplo.com/'), 'wss://coop.exemplo.com/ws?v=1');
  assert.equal(normalizeSignalUrl('ws://127.0.0.1:8787'), 'ws://127.0.0.1:8787/ws?v=1');
  assert.equal(normalizeSignalUrl('wss://x.y/ws?v=1'), 'wss://x.y/ws?v=1');
  assert.throws(() => normalizeSignalUrl('ftp://x'));
  assert.equal(sanitizeName('  Davi\u0000\u200b '), 'Davi');
  assert.equal(sanitizeName(''), 'Jogador');
  assert.equal(sanitizeName('x'.repeat(50)).length, 32);
});

test('sinalização: mensagens do servidor são validadas e copiadas só com os campos conhecidos', () => {
  const welcome = validateServerMessage({ t: 'welcome', room: 'ABCDE', you: 'g1', role: 'guest', hostId: 'h1',
    peers: [{ id: 'h1', name: 'Davi\u0007', role: 'host', ready: true, extra: 1 }, { id: 5 }],
    lobby: { map: 'zombie_coast' }, resume: 'tok', invite: 'https://x/j/ABCDE', __proto__x: 1,
    ice: [{ urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:t:3478', 'http://mal'], username: 'u', credential: 'c' }, { urls: 'javascript:alert(1)' }, 'lixo'] });
  assert.deepEqual(welcome, { t: 'welcome', room: 'ABCDE', you: 'g1', role: 'guest', hostId: 'h1',
    peers: [{ id: 'h1', name: 'Davi', role: 'host', ready: true }], lobby: { map: 'zombie_coast' },
    ice: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:t:3478'], username: 'u', credential: 'c' }],
    resume: 'tok', invite: 'https://x/j/ABCDE', started: null });
  // partida em andamento (extensão do servidor): só { map, at } válidos passam
  const base = { t: 'welcome', room: 'ABCDE', you: 'g1', role: 'guest', hostId: 'h1', peers: [], lobby: {} };
  assert.deepEqual(validateServerMessage({ ...base, started: { map: 'zombie_coast', at: 7, x: 1 } }).started, { map: 'zombie_coast', at: 7 });
  assert.equal(validateServerMessage({ ...base, started: { map: 'zombie_coast', at: 'x' } }).started, null);
  for (const bad of [null, [], { t: 'welcome' }, { t: 'signal', from: 'a' }, { t: 'peer-ready', id: 'a', ready: 'sim' },
    { t: 'start' }, { t: 'pong', ts: 'x' }, { t: 'inventado' }, { t: 'peer-joined', peer: { id: 'a', role: 'admin' } }])
    assert.equal(validateServerMessage(bad), null, JSON.stringify(bad));
  const start = { t: 'start', map: 'zombie_coast', at: 5 };
  assert.deepEqual(validateServerMessage({ ...start, extra: 1 }), start);
  assert.deepEqual(validateServerMessage({ t: 'closed' }), { t: 'closed', reason: '' });
});

test('sinalização: hello primeiro, ping a cada 10 s, backoff com teto, resume e sinais guardados', async () => {
  const w = world({ graceMs: 10 * 60000 }); // a vaga espera a queda longa abaixo
  const hostClient = new SignalClient({ url: 'wss://sinal.teste/ws?v=1', role: 'host', name: 'Davi', WebSocket: w.WS,
    clock: w.clock, random: () => 1 });
  const welcomes = [], states = [];
  hostClient.on('welcome', m => welcomes.push(m));
  hostClient.on('state', s => states.push(s));
  hostClient.start();
  await w.clock.advance(5);
  assert.equal(w.stub.received[0][1].t, 'hello');
  assert.deepEqual(w.stub.received[0][1], { t: 'hello', v: 1, role: 'host', name: 'Davi' });
  assert.equal(hostClient.state, 'online');
  const { room, you } = welcomes[0];

  // ping a cada 10 s, pong mede o RTT
  w.stub.received.length = 0;
  await w.clock.advance(30000);
  assert.equal(w.stub.received.filter(([, m]) => m.t === 'ping').length, 3);
  assert.equal(hostClient.rtt, 0);

  // servidor fora do ar: o socket cai e as tentativas espaçam 500, 1000, 2000, 4000, 8000, 15000 (teto), 15000…
  w.WS.refuse = true;
  const before = w.WS.all.length;
  w.WS.all.at(-1).drop();
  await w.clock.advance(1);
  assert.equal(hostClient.state, 'connecting');
  hostClient.send({ t: 'signal', to: 'x', data: { candidate: { candidate: 'c1' } } }); // guardado, mas vai envelhecer
  const times = [];
  let seen = before;
  for (let t = 0; t < 60000; t += 50) {
    await w.clock.advance(50);
    if (w.WS.all.length > seen) { seen = w.WS.all.length; times.push(t + 50); }
  }
  const gaps = times.map((t, i) => t - (times[i - 1] ?? 0));
  assert.deepEqual(gaps.slice(0, 7), [500, 1000, 2000, 4000, 8000, 15000, 15000]);

  // volta: hello com resume, mesma sala e mesmo id; o sinal guardado recente sai depois do welcome, o velho não
  hostClient.send({ t: 'signal', to: 'x', data: { candidate: { candidate: 'c2' } } });
  w.WS.refuse = false;
  w.stub.received.length = 0;
  await w.clock.advance(15000);
  const hello = w.stub.received.find(([, m]) => m.t === 'hello')[1];
  assert.equal(hello.resume, welcomes[0].resume);
  assert.equal(hello.room, room);
  assert.equal(welcomes.at(-1).you, you);
  assert.equal(hostClient.state, 'online');
  assert.equal(hostClient.attempts, 0);
  // (o destino "x" não existe: o stub responde forbidden, que depois do welcome não é fatal)
  const signals = w.stub.received.filter(([, m]) => m.t === 'signal').map(([, m]) => m.data.candidate.candidate);
  assert.deepEqual(signals, ['c2']);

  // servidor mudo (socket meio-aberto): sem nada por 30 s, reconecta sozinho
  const socket = w.WS.all.at(-1);
  socket.handle.onMessage = () => {};
  const count = w.WS.all.length;
  await w.clock.advance(41000);
  assert.ok(w.WS.all.length > count, 'reconectou');
  assert.equal(hostClient.state, 'online');
  assert.equal(welcomes.at(-1).you, you);

  // erro fatal (sala não existe): para de tentar
  const guestClient = new SignalClient({ url: 'wss://sinal.teste/ws?v=1', role: 'guest', name: 'X', room: 'ZZZZZ',
    WebSocket: w.WS, clock: w.clock, random: () => 1 });
  const fatal = [];
  guestClient.on('fatal', e => fatal.push(e.code));
  guestClient.start();
  const n = w.WS.all.length;
  await w.clock.advance(60000);
  assert.deepEqual(fatal, ['room-not-found']);
  assert.equal(w.WS.all.length, n);
  assert.equal(guestClient.state, 'offline');
  hostClient.stop();
});

test('sessão: estados da sala, lobby, pronto e início', async () => {
  const w = world();
  const host = w.make('Davi');
  await w.clock.advance(0);
  assert.equal(host.last().phase, 'idle');
  host.command('create', { name: 'Davi', map: 'zombie_coast' });
  await w.clock.advance(0);
  assert.equal(host.states.some(s => s.phase === 'connecting'), true);
  await w.clock.advance(10);
  const hs = host.last();
  assert.equal(hs.phase, 'lobby');
  assert.equal(hs.role, 'host');
  assert.match(hs.room, /^[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(hs.invite, `https://sinal.teste/j/${hs.room}`);
  assert.equal(hs.signal, 'online');
  assert.equal(hs.lobbyMap, 'zombie_coast');
  assert.deepEqual(w.stub.rooms.get(hs.room).lobby, { map: 'zombie_coast' }); // o mapa do create foi para o servidor

  const guest = w.make('Irmao');
  guest.command('join', { code: hs.room.toLowerCase() });
  await w.clock.advance(1000);
  const gs = guest.last();
  assert.equal(gs.phase, 'lobby');
  assert.equal(gs.role, 'guest');
  assert.equal(gs.lobbyMap, 'zombie_coast');
  assert.deepEqual(gs.you, { id: gs.you.id, name: 'Irmao', ready: false });
  assert.deepEqual(gs.peers.map(p => [p.name, p.role, p.link]), [['Davi', 'host', 'direct']]);
  assert.equal(typeof gs.peers[0].ping, 'number');
  assert.deepEqual(host.last().peers.map(p => [p.id, p.name, p.role, p.ready, p.link]),
    [[gs.you.id, 'Irmao', 'guest', false, 'direct']]);

  host.command('setMap', 'zombie_theater');
  guest.command('setReady', true);
  await w.clock.advance(10);
  assert.equal(guest.last().lobbyMap, 'zombie_theater');
  assert.equal(host.last().peers[0].ready, true);
  assert.equal(guest.last().you.ready, true);

  guest.command('start'); // convidado não inicia
  host.command('start');
  await w.clock.advance(10);
  for (const s of [host.last(), guest.last()]) {
    assert.equal(s.phase, 'starting');
    assert.equal(s.startMap.zone, 'zombie_theater');
    assert.equal(typeof s.startMap.at, 'number');
  }
  assert.equal(w.stub.received.filter(([, m]) => m.t === 'start').length, 1);

  // quem entra com a partida em andamento vai direto para o mapa (mesmo { zone, at } dos outros)
  const late = w.make('Primo');
  late.command('join', { code: hs.room });
  await w.clock.advance(1000);
  assert.equal(late.last().phase, 'starting');
  assert.deepEqual(late.last().startMap, guest.last().startMap);
  late.command('leave');
  await w.clock.advance(10);

  // sem mapa: erro em português, sem mudar de fase
  const other = w.make('Solo');
  other.command('create', {});
  await w.clock.advance(10);
  other.command('start');
  await w.clock.advance(10);
  assert.equal(other.last().phase, 'lobby');
  assert.equal(other.last().error.code, 'no-map');

  guest.command('leave');
  await w.clock.advance(10);
  assert.equal(guest.last().phase, 'idle');
  assert.equal(guest.last().room, null);
  assert.deepEqual(host.last().peers, []);
});

test('sessão: host começa sozinho se o servidor não devolver o start', async () => {
  const w = world({ echoStart: false });
  const { host, guests: [guest] } = await room(w);
  host.command('start');
  await w.clock.advance(10);
  assert.equal(host.last().phase, 'lobby');
  assert.equal(guest.last().phase, 'starting');
  await w.clock.advance(2000);
  assert.equal(host.last().phase, 'starting');
  assert.equal(host.last().startMap.zone, 'zombie_coast');
});

test('sessão: erros de entrada viram estado de erro em português', async () => {
  const w = world();
  const a = w.make('A');
  a.command('join', { code: 'XYZ' });
  await w.clock.advance(1);
  assert.equal(a.last().phase, 'error');
  assert.equal(a.last().error.code, 'code');
  a.command('join', { code: 'QQQQQ' });
  await w.clock.advance(10);
  assert.equal(a.last().phase, 'error');
  assert.deepEqual(a.last().error,
    { code: 'room-not-found', message: 'Sala não encontrada. Confira o código ou peça um convite novo.' });
  const b = new NetSession({ WebSocket: w.WS, RTCPeerConnection: w.net.RTCPeerConnection, clock: w.clock,
    onState: s => { b.s = s; } });
  b.command('create', {});
  await w.clock.advance(1);
  assert.equal(b.s.error.code, 'config');
  // servidor de salas fora do ar na entrada: avisa e continua tentando; quando volta, entra
  w.WS.refuse = true;
  const c = w.make('C');
  c.command('create', {});
  await w.clock.advance(5000);
  assert.equal(c.last().phase, 'connecting');
  assert.equal(c.last().signal, 'connecting');
  assert.equal(c.last().error.code, 'offline');
  w.WS.refuse = false;
  await w.clock.advance(15000);
  assert.equal(c.last().phase, 'lobby');
  assert.equal(c.last().error, null);
  // sala cheia: host + 3
  const { host } = await room(w, 3);
  const extra = w.make('Quinto');
  extra.command('join', { code: host.last().room });
  await w.clock.advance(10);
  assert.equal(extra.last().error.code, 'room-full');
});

test('sessão: pacotes roteados por id (host recebe com id, convidado sem id), com validação', async () => {
  const w = world();
  const { host, guests: [g1, g2] } = await room(w, 2);
  const joins = host.page.of('join');
  assert.deepEqual(joins.map(m => [m.id, m.slot, m.name]).sort(), [[g1.id, 1, 'Irmao0'], [g2.id, 2, 'Irmao1']].sort());

  g1.page.page({ t: 'pkt', b: packet(1) });
  g2.page.page({ t: 'pkt', b: packet(2, 600) });
  await w.clock.advance(50);
  assert.deepEqual(pkts(host.page).map(m => [m.id, m.b.length, m.b[1]]), [[g1.id, 1264, 1], [g2.id, 600, 2]]);
  assert.ok(pkts(host.page).every(m => m.b instanceof Uint8Array));

  host.page.page({ t: 'pkt', id: g2.id, b: packet(3, 1000) });
  host.page.page({ t: 'pkt', id: 'ninguem', b: packet(4) });
  await w.clock.advance(50);
  assert.deepEqual(pkts(g1.page), []);
  assert.deepEqual(pkts(g2.page).map(m => [m.id, m.b.length, m.b[1]]), [[undefined, 1000, 3]]);
  assert.equal('id' in pkts(g2.page)[0], false);

  // inválidos: grande demais, vazio, sem Uint8Array
  g1.page.page({ t: 'pkt', b: new Uint8Array(1265) });
  g1.page.page({ t: 'pkt', b: new Uint8Array(0) });
  g1.page.page({ t: 'pkt', b: [1, 2, 3] });
  g1.page.page('lixo');
  await w.clock.advance(50);
  assert.equal(pkts(host.page).length, 2);
  assert.equal(g1.stats().page.badPkt, 3);
  assert.equal(host.stats().page.noPeer, 1);

  // estatísticas para a página a cada 2 s
  await w.clock.advance(2000);
  const net = host.page.of('net').at(-1).stats;
  assert.equal(net.mode, 'webrtc');
  assert.equal(net.peers.length, 2);
  assert.ok(net.peers.every(p => p.link === 'direct' && typeof p.rtt === 'number'));
});

test('sessão: página nova recebe os convidados (join) ao mandar ready; o port mais recente é o ativo', async () => {
  const w = world();
  const { host, guests: [g1, g2] } = await room(w, 2);
  const old = host.page;
  const fresh = new FakePort();
  host.attachPort(fresh);
  assert.equal(old.closed, true);
  assert.deepEqual(fresh.of('join'), []); // só depois do ready
  fresh.page({ t: 'ready', role: 'host', rings: [524, 525, 526] });
  assert.deepEqual(fresh.of('join').map(m => m.id).sort(), [g1.id, g2.id].sort());
  const before = pkts(old).length;
  g1.page.page({ t: 'pkt', b: packet(9) });
  await w.clock.advance(50);
  assert.equal(pkts(old).length, before);
  assert.deepEqual(pkts(fresh).map(m => m.id), [g1.id]);
  // convidado: port novo também vale na hora
  const gFresh = new FakePort();
  g2.attachPort(gFresh);
  host.page = fresh;
  fresh.page({ t: 'pkt', id: g2.id, b: packet(10) });
  await w.clock.advance(50);
  assert.equal(pkts(gFresh).length, 1);
});

test('enlace: queda > 3 s dispara ICE restart e o tráfego volta sem leave/join', async () => {
  const w = world();
  const { host, guests: [guest] } = await room(w);
  const pcs = () => w.net.created.filter(pc => !pc.closed);
  w.net.setDown(true);
  await w.clock.advance(2000);
  assert.ok(pcs().every(pc => pc.restarts === 0), 'ainda não (2 s)');
  await w.clock.advance(1500);
  assert.ok(pcs().some(pc => pc.restarts > 0), 'restart depois de 3 s em disconnected');
  assert.ok(w.logs.some(l => /ICE restart \((disconnected > 3 s|ICE ainda disconnected)\)/.test(l)));
  w.net.setDown(false);
  await w.clock.advance(2000);
  assert.ok(pcs().every(pc => pc.iceConnectionState === 'connected'));
  assert.equal(pcs().length, 2, 'mesmo RTCPeerConnection (só ICE restart)');
  guest.page.page({ t: 'pkt', b: packet(5) });
  await w.clock.advance(50);
  assert.equal(pkts(host.page).at(-1).b[1], 5);
  assert.equal(host.page.of('leave').length, 0);
  assert.equal(host.page.of('join').length, 1);
  assert.equal(host.last().peers[0].link, 'direct');

  // 'failed' dispara na hora (respeitando o intervalo mínimo entre restarts)
  await w.clock.advance(10000);
  const pc = pcs().find(p => p.restarts !== undefined);
  const r = pc.restarts;
  pc.setIce('failed');
  await w.clock.advance(1);
  assert.equal(pc.restarts, r + 1);
});

test('enlace: colisão de ofertas (ICE restart dos dois lados no mesmo instante) fica com a do convidado', async () => {
  const w = world();
  const { host, guests: [guest] } = await room(w);
  const hostLink = host.links.get(guest.id).link, guestLink = guest.links.get(host.last().you.id).link;
  const ufrags = [hostLink.pc.ufrag, guestLink.pc.ufrag];
  hostLink.restartIce('teste');
  guestLink.restartIce('teste');
  await w.clock.advance(200);
  assert.ok(w.logs.some(l => l.includes('oferta do host ignorada (colisão')), 'o convidado (impolite) ignora');
  for (const link of [hostLink, guestLink]) {
    assert.equal(link.pc.signalingState, 'stable');
    assert.equal(link.pc.iceConnectionState, 'connected');
  }
  assert.notDeepEqual([hostLink.pc.ufrag, guestLink.pc.ufrag], ufrags, 'credenciais ICE novas dos dois lados');
  guest.page.page({ t: 'pkt', b: packet(8) });
  host.page.page({ t: 'pkt', id: guest.id, b: packet(9) });
  await w.clock.advance(50);
  assert.equal(pkts(host.page).at(-1).b[1], 8);
  assert.equal(pkts(guest.page).at(-1).b[1], 9);
});

test('enlace: 15 s sem pong => lost (leave); o convidado refaz o RTCPeerConnection e o par volta (join)', async () => {
  const w = world();
  const { host, guests: [guest] } = await room(w);
  w.net.setDown(true);
  await w.clock.advance(6500);
  assert.equal(host.last().peers[0].link, 'connecting', 'pong velho: engasgando');
  assert.equal(host.last().peers[0].ping, null);
  await w.clock.advance(10000);
  assert.deepEqual(host.page.of('leave').map(m => [m.id, m.reason]), [[guest.id, 'lost']]);
  assert.equal(host.last().peers[0].link, 'lost');
  assert.equal(guest.last().peers[0].link, 'lost');
  // pacote para quem caiu não sai
  host.page.page({ t: 'pkt', id: guest.id, b: packet(1) });
  assert.equal(host.stats().page.noPeer, 1);
  await w.clock.advance(5000); // > 20 s sem pong: RTCPeerConnection novo (gen 2)
  assert.ok(w.logs.some(l => l.includes('RTCPeerConnection novo')));
  w.net.setDown(false);
  await w.clock.advance(2000);
  assert.ok(w.logs.some(l => l.includes('geração 2 do convidado')));
  assert.equal(host.page.of('join').length, 2);
  assert.equal(host.page.of('join')[1].id, guest.id);
  assert.equal(host.last().peers[0].link, 'direct');
  guest.page.page({ t: 'pkt', b: packet(6) });
  await w.clock.advance(50);
  assert.equal(pkts(host.page).at(-1).b[1], 6);
});

test('enlace: descarta quando game.bufferedAmount > 64 KiB (sem fila)', async () => {
  const w = world();
  const { host, guests: [guest] } = await room(w);
  const link = host.links.get(guest.id).link;
  link.game.bufferedAmount = MAX_BUFFERED + 1;
  for (let i = 0; i < 5; ++i) host.page.page({ t: 'pkt', id: guest.id, b: packet(i) });
  await w.clock.advance(50);
  assert.equal(pkts(guest.page).length, 0);
  assert.equal(link.stats().congested, 5);
  link.game.bufferedAmount = MAX_BUFFERED;
  host.page.page({ t: 'pkt', id: guest.id, b: packet(7) });
  await w.clock.advance(50);
  assert.equal(pkts(guest.page).length, 1);
});

test('enlace: tipo do caminho (relay/direct), perda medida e lista do host para os convidados', async () => {
  const w = world();
  w.net.relay = true;
  w.net.lossRate = 0.1;
  const { host, guests: [g1, g2] } = await room(w, 2);
  await w.clock.advance(12000);
  const hp = host.last().peers;
  assert.ok(hp.every(p => p.link === 'relay'), JSON.stringify(hp));
  // ~10% das sondas no game se perdem nos dois sentidos
  for (const p of hp) assert.ok(p.loss >= 5 && p.loss <= 15, `perda ${p.loss}`);
  // o convidado 1 vê o convidado 2 pelo que o host mediu
  const seen = g1.last().peers.find(p => p.id === g2.id);
  const hostView = hp.find(p => p.id === g2.id);
  assert.equal(seen.link, 'relay');
  assert.equal(typeof seen.ping, 'number');
  assert.ok(Math.abs(seen.ping - hostView.ping) <= 1);
  w.net.relay = false;
  w.net.lossRate = 0;
  await w.clock.advance(14000);
  assert.ok(host.last().peers.every(p => p.link === 'direct' && p.loss === 0), JSON.stringify(host.last().peers));
});

test('sala: convidado sai (leave na página na hora); queda só da sinalização não derruba o P2P', async () => {
  const w = world({ graceMs: 30000 });
  const { host, guests: [g1, g2] } = await room(w, 2);

  // sinalização do host cai e volta (resume): enlaces intocados, pacotes passando o tempo todo
  w.stub.drop(host.last().you.id);
  await w.clock.advance(1);
  assert.equal(host.last().signal, 'connecting');
  g1.page.page({ t: 'pkt', b: packet(1) });
  await w.clock.advance(50);
  assert.equal(pkts(host.page).at(-1).b[1], 1);
  await w.clock.advance(1000);
  assert.equal(host.last().signal, 'online');
  assert.equal(host.last().peers.length, 2);
  assert.equal(host.page.of('leave').length, 0);
  assert.equal(w.net.created.filter(pc => !pc.closed).length, 4);

  // convidado 1 sai de verdade: leave na página logo
  g1.command('leave');
  await w.clock.advance(10);
  assert.deepEqual(host.page.of('leave').map(m => [m.id, m.reason]), [[g1.id, 'left']]);
  assert.deepEqual(host.last().peers.map(p => p.id), [g2.id]);
  assert.deepEqual(g2.last().peers.map(p => p.role), ['host']);
});

test('sala: servidor diz que o par caiu, mas o enlace vive: fica até cair de verdade', async () => {
  const w = world({ graceMs: 0 });
  const { host, guests: [guest] } = await room(w);
  // a sinalização do convidado cai (o stub avisa peer-left 'disconnected' na hora) e não volta
  w.WS.refuse = true;
  w.stub.drop(guest.id);
  await w.clock.advance(10);
  assert.equal(host.page.of('leave').length, 0, 'P2P vivo: não sai');
  assert.equal(host.last().peers[0].link, 'direct');
  guest.page.page({ t: 'pkt', b: packet(2) });
  await w.clock.advance(50);
  assert.equal(pkts(host.page).at(-1).b[1], 2);
  // agora o convidado some de vez (fecha o RTCPeerConnection): o host dá o par como perdido em 15 s e o tira da sala
  for (const [, e] of guest.links) e.link.close();
  await w.clock.advance(16000);
  assert.deepEqual(host.page.of('leave').map(m => m.reason), ['lost']);
  assert.deepEqual(host.last().peers, []);
});

test('sala: host sai da sinalização com o jogo rodando: o convidado segue até o enlace cair', async () => {
  const w = world();
  const { host, guests: [guest] } = await room(w);
  host.command('start');
  await w.clock.advance(10);
  // sinalização do host morre (sem resume possível: o stub encerra a sala na hora)
  w.WS.refuse = true;
  w.stub.drop(host.last().you.id);
  await w.clock.advance(10);
  assert.equal(guest.last().phase, 'starting');
  assert.equal(guest.last().error.code, 'host-left');
  assert.equal(guest.last().signal, 'offline');
  host.page.page({ t: 'pkt', id: guest.id, b: packet(3) });
  await w.clock.advance(50);
  assert.equal(pkts(guest.page).at(-1).b[1], 3, 'o jogo continua P2P');
  // o host fecha o app: 15 s depois o convidado sai da sala com o erro
  host.close();
  await w.clock.advance(16000);
  assert.equal(guest.last().phase, 'error');
  assert.equal(guest.last().error.code, 'host-left');
});

test('sessão: comandos inválidos não derrubam nada', async () => {
  const w = world();
  const s = w.make('X');
  s.command('voar', {});
  s.command('setMap', 'zombie_coast'); // sem sala
  s.command('setReady', true);
  s.command('config', null);
  s.command('join', null);
  await w.clock.advance(10);
  assert.equal(s.last().phase, 'error');
  assert.equal(s.last().error.code, 'code');
});
