// Extensão do navegador: mensagens entre os contextos, ponta a ponta no Node — mundo da página (MessagePorts reais)
// ⇄ mundo isolado (lib/isolated.mjs) ⇄ chrome.runtime.Port (JSON, dublê) ⇄ offscreen (lib/hub.mjs + lib/session.mjs)
// ⇄ NetSession (dublê). Lobby, estado, convite, navegação para o mapa, pacotes do motor nos dois sentidos, queda e volta
// do offscreen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IsolatedLink } from '../browser/src/lib/isolated.mjs';
import { Hub } from '../browser/src/lib/hub.mjs';
import { ExtSession } from '../browser/src/lib/session.mjs';
import { StubNet, fakeWindow, portPair, until } from './ext-fakes.mjs';

const MAP_JS = `export const MAP_LIST = [\n  { zone: 'zombie_cod5_prototype', slug: 'nacht', name: 'Nacht der Untoten', horde: true },\n` +
  `  { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' },\n];`;

// Uma aba do vel.gg (tabId) ligada ao offscreen: devolve o "mundo da página" (ctl) e os dublês.
async function tab({ tabId = 5, href = 'https://vel.gg/bo1z', inviteHash = '', hub, prefs = { name: 'Davi', signal: 'sig.example.com' } }) {
  const win = fakeWindow(), navs = [], conns = [], stored = { ...prefs };
  const runtime = {
    sendMessage: async m => { assert.deepEqual(m, { to: 'sw', t: 'ensure' }); return { ok: true }; },
    connect: name => { const pair = portPair(name, tabId); conns.push(pair); hub.connect(pair.offscreen); return pair.page; },
  };
  const storage = { get: async () => ({ ...stored }), set: async patch => Object.assign(stored, patch) };
  win.history = { state: null, replaceState: (state, title, url) => navs.push(`replace ${url}`) };
  const nav = { href, assign: url => navs.push(url), reload: () => navs.push('reload') };
  const link = new IsolatedLink({ runtime, storage, win, nav, base: 'chrome-extension://abc/', inviteHash,
    fetchText: async () => MAP_JS });
  // lado do content-main.js: pede o port e fica com ele
  const main = { states: [], games: [], results: new Map(), echoes: [] };
  const ctl = new Promise(resolve => win.addEventListener('message', e => { if (e.data?.bo1zExt === 'iso' && e.ports[0]) resolve(e.ports[0]); }));
  win.postMessage({ bo1zExt: 'main' }, '*');
  await link.start();
  main.ctl = await ctl;
  main.ctl.onmessage = ({ data }) => {
    if (data.t === 'state') main.states.push(data.state);
    else if (data.t === 'game') main.games.push(data.game);
    else if (data.t === 'result') main.results.set(data.id, data);
    else if (data.t === 'echo') main.echoes.push(data);
  };
  let seq = 0;
  main.call = async (fn, ...args) => {
    const id = `t${++seq}`;
    main.ctl.postMessage({ t: 'call', id, fn, args });
    assert.ok(await until(() => main.results.has(id)), `${fn} sem resposta`);
    const r = main.results.get(id);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { link, main, navs, conns, stored, win };
}

function offscreen() {
  const net = new StubNet(), session = new ExtSession({ net }), opened = [];
  const hub = new Hub({ session, net, openTab: async url => { opened.push(url); return 99; } });
  return { net, session, hub, opened };
}

test('lobby pela página: criar sala, estado empurrado, mapas do site, nome salvo, início leva a aba ao mapa', async t => {
  const o = offscreen(), a = await tab({ hub: o.hub });
  t.after(() => { a.link.close(); a.main.ctl.close(); });
  assert.ok(await until(() => a.main.states.length && a.main.games.length));
  assert.equal(a.main.games[0], null);
  assert.ok(await until(() => o.session.getState().maps.length === 2)); // maps.js do site chegou ao offscreen
  assert.equal(o.session.prefs.signal, 'sig.example.com');
  let st = await a.main.call('create', { name: 'Davi Novo', map: 'zombie_cod5_prototype' });
  assert.equal(st.phase, 'connecting');
  assert.equal(a.stored.name, 'Davi Novo'); // o mundo isolado grava o nome (o offscreen não tem chrome.storage)
  assert.deepEqual(o.net.commands.map(c => c.cmd), ['config', 'create']);
  assert.equal(o.session.owner, 5);
  o.session.onNetState({ phase: 'lobby', role: 'host', room: 'K7QX2', invite: 'https://sig.example.com/j/K7QX2',
    you: { id: 'h', name: 'Davi Novo' }, peers: [], signal: 'online', lobbyMap: 'zombie_cod5_prototype' });
  assert.ok(await until(() => a.main.states.at(-1)?.room === 'K7QX2'));
  assert.equal(a.main.states.at(-1).browserInvite, 'https://vel.gg/bo1z/#bo1z-join=K7QX2&s=sig.example.com');
  assert.equal(await a.main.call('copyInvite'), 'https://sig.example.com/j/K7QX2');
  await a.main.call('start');
  assert.deepEqual(o.net.commands.at(-1), { cmd: 'start', args: { map: 'zombie_cod5_prototype' } });
  o.session.onNetState({ phase: 'starting', startMap: { zone: 'zombie_cod5_prototype', at: 1 } });
  assert.ok(await until(() => a.navs.length === 1));
  assert.equal(a.navs[0], 'https://vel.gg/bo1z/nacht#bo1z-start');
  assert.ok(await until(() => a.main.games.at(-1)?.role === 'host'));
  assert.deepEqual(a.main.games.at(-1).map, { zone: 'zombie_cod5_prototype', slug: 'nacht', name: 'Nacht der Untoten' });
  // chamada inválida volta como erro, sem derrubar nada
  await assert.rejects(a.main.call('eval', '1'), /desconhecida/);
});

test('pacotes do motor: página ⇄ offscreen ⇄ rede, binários, com id no host; ready re-apresenta; aba nova assume', async t => {
  const o = offscreen(), a = await tab({ hub: o.hub, href: 'https://vel.gg/bo1z/nacht' });
  t.after(() => { a.link.close(); a.main.ctl.close(); });
  assert.ok(await until(() => a.main.games.length));
  const { port1: bridge, port2 } = new MessageChannel(); // port1 = o lado do Worker da ponte
  t.after(() => bridge.close());
  a.main.ctl.postMessage({ t: 'pkt-port' }, [port2]);
  assert.ok(await until(() => o.net.port), 'a NetSession recebeu o port de pacotes');
  const got = [];
  bridge.onmessage = ({ data }) => got.push(data);
  // página -> rede: §1 (ready com rings, pkt com id do destino)
  const out = Uint8Array.from({ length: 1264 }, (_, i) => i & 255);
  bridge.postMessage({ t: 'ready', role: 'host', rings: [2404, 2406] });
  bridge.postMessage({ t: 'pkt', id: 'g1', b: out });
  assert.ok(await until(() => o.net.fromPage.length === 2));
  assert.deepEqual(o.net.fromPage[0], { t: 'ready', role: 'host', rings: [2404, 2406] });
  assert.ok(o.net.fromPage[1].b instanceof Uint8Array);
  assert.deepEqual([...o.net.fromPage[1].b], [...out]);
  assert.equal(o.net.fromPage[1].id, 'g1');
  // rede -> página: join, pkt (com id), net
  o.net.toPage({ t: 'join', id: 'g1', slot: 1, name: 'Irmão' });
  o.net.toPage({ t: 'pkt', id: 'g1', b: Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x63) });
  o.net.toPage({ t: 'net', stats: { peers: [{ id: 'g1', rtt: 23 }] } });
  assert.ok(await until(() => got.length === 3));
  assert.deepEqual(got[0], { t: 'join', id: 'g1', slot: 1, name: 'Irmão' });
  assert.ok(got[1].b instanceof Uint8Array);
  assert.deepEqual([...got[1].b], [0xff, 0xff, 0xff, 0xff, 0x63]);
  assert.equal(got[1].id, 'g1');
  assert.equal(got[2].stats.peers[0].rtt, 23);
  assert.deepEqual(o.hub.stats().find(c => c.tabId === 5), { kind: 'page', tabId: 5, attached: true, fromPage: 1, toPage: 1, dropped: 0 });
  assert.equal(o.net.closedPorts, 0); // ligou uma vez só (o hello que chega depois do port não religa)
  // outra aba liga a ponte: ela vira o port da rede e a primeira para de receber
  const b = await tab({ tabId: 6, hub: o.hub, href: 'https://vel.gg/bo1z/nacht' }), second = new MessageChannel();
  t.after(() => { b.link.close(); b.main.ctl.close(); second.port1.close(); });
  b.main.ctl.postMessage({ t: 'pkt-port' }, [second.port2]);
  assert.ok(await until(() => o.net.closedPorts === 1));
  const got2 = [];
  second.port1.onmessage = ({ data }) => got2.push(data);
  o.net.toPage({ t: 'pkt', b: Uint8Array.of(1, 2, 3) });
  assert.ok(await until(() => got2.length === 1));
  assert.equal('id' in got2[0], false); // convidado: sem id
  assert.equal(got.length, 3);
});

test('convite no hash: entra na sala com o nome salvo e o servidor do link', async t => {
  const o = offscreen(), a = await tab({ hub: o.hub, inviteHash: '#bo1z-join=k7qx2&s=http%3A%2F%2F127.0.0.1%3A8787', prefs: { name: 'Irmão' } });
  t.after(() => { a.link.close(); a.main.ctl.close(); });
  assert.ok(await until(() => o.net.commands.some(c => c.cmd === 'join')));
  assert.deepEqual(o.net.commands.find(c => c.cmd === 'join').args, { code: 'K7QX2', name: 'Irmão', signalUrl: 'http://127.0.0.1:8787' });
  assert.equal(o.session.owner, 5);
  assert.ok(await until(() => a.main.states.at(-1)?.phase === 'connecting' && a.main.states.at(-1)?.room === 'K7QX2'));
});

test('offscreen cai e volta: a aba reconecta sozinha, refaz o hello e religa a ponte à rede', async t => {
  const o = offscreen(), a = await tab({ hub: o.hub, href: 'https://vel.gg/bo1z/nacht' });
  t.after(() => { a.link.close(); a.main.ctl.close(); });
  assert.ok(await until(() => a.main.games.length));
  const { port1, port2 } = new MessageChannel();
  t.after(() => port1.close());
  a.main.ctl.postMessage({ t: 'pkt-port' }, [port2]);
  assert.ok(await until(() => o.net.port));
  const first = o.net.port;
  // chamada em andamento quando cai: a página recebe erro em vez de ficar esperando
  a.main.ctl.postMessage({ t: 'call', id: 'pendente', fn: 'getState', args: [] });
  a.conns[0].kill();
  assert.ok(await until(() => a.main.results.has('pendente')));
  assert.ok(await until(() => a.conns.length === 2 && o.net.port !== first, 4000), 'reconectou e religou a ponte');
  assert.equal(o.hub.stats().filter(c => c.attached).length, 1);
  // eco (medida de latência) pelo caminho novo
  a.main.ctl.postMessage({ t: 'echo', seq: 1, e: 'b64', b: Uint8Array.of(9, 8, 7) });
  assert.ok(await until(() => a.main.echoes.length === 1));
  assert.deepEqual([...a.main.echoes[0].b], [9, 8, 7]);
});

test('aba da sala fechada: o início abre uma aba nova, que vira a dona', async () => {
  const o = offscreen();
  o.session.setPrefs({ signal: 'sig.example.com' });
  await o.session.call('create', [{ name: 'Davi', map: 'zombie_coast' }], { tabId: 42 });
  o.session.onNetState({ phase: 'lobby', role: 'host', room: 'K7QX2', you: { id: 'h', name: 'Davi' }, peers: [] });
  o.session.onNetState({ phase: 'starting', startMap: { zone: 'zombie_coast', at: 5 } });
  assert.ok(await until(() => o.opened.length === 1));
  assert.equal(o.opened[0], 'https://vel.gg/bo1z/cotd#bo1z-start');
  assert.ok(await until(() => o.session.owner === 99));
  assert.equal(o.session.gameFor(99).role, 'host');
});

test('navegação para o mapa: mantém a query da página (menos horde); na mesma URL, marca e recarrega', () => {
  const run = href => {
    const log = [], win = { history: { state: null, replaceState: (s, t, url) => log.push(`replace ${url}`) } };
    const nav = { href, assign: u => log.push(u), reload: () => log.push('reload') };
    new IsolatedLink({ runtime: null, storage: null, win, nav, base: '' }).go('https://vel.gg/bo1z/nacht#bo1z-start');
    return log;
  };
  assert.deepEqual(run('https://vel.gg/bo1z'), ['https://vel.gg/bo1z/nacht#bo1z-start']);
  assert.deepEqual(run('https://vel.gg/bo1z?renderer=webgl2&horde=1'), ['https://vel.gg/bo1z/nacht?renderer=webgl2#bo1z-start']);
  assert.deepEqual(run('https://vel.gg/bo1z/nacht?renderer=webgl2'),
    ['replace https://vel.gg/bo1z/nacht?renderer=webgl2#bo1z-start', 'reload']);
  assert.deepEqual(run('https://vel.gg/bo1z/nacht'), ['replace https://vel.gg/bo1z/nacht#bo1z-start', 'reload']);
});
