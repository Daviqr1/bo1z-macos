// Extensão do navegador: estado da sala no documento offscreen (browser/src/lib/session.mjs) sobre uma NetSession de
// mentira (a peça app/net segue a interface do COOP-ARCH §4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtSession } from '../browser/src/lib/session.mjs';
import { StubNet } from './ext-fakes.mjs';

function session({ net = new StubNet(), signal = 'bo1z-signal.davi.workers.dev', name = 'Davi' } = {}) {
  const s = new ExtSession({ net });
  s.setPrefs({ name, signal });
  s.states = [];
  s.navs = [];
  s.on('state', st => s.states.push(st));
  s.on('navigate', n => s.navs.push(n));
  return s;
}

test('erros com mensagem: sem rede no build, sem servidor, código inválido, "por IP" só no app', async () => {
  let s = session({ net: null });
  assert.equal((await s.create({ name: 'x' })).error.code, 'no-net');
  s = session({ signal: '' });
  let st = await s.create({ name: 'x' });
  assert.equal(st.phase, 'error');
  assert.match(st.error.message, /opções da extensão/);
  assert.equal((await s.join({ code: 'K7QX2' })).error.code, 'no-signal');
  assert.equal((await s.join({ code: 'abc', signalUrl: 'https://x.example.com' })).error.code, 'bad-code');
  st = await s.connectByAddress({ address: '1.2.3.4:27960' });
  assert.equal(st.error.code, 'no-udp');
  assert.match(st.error.message, /só funciona no app/);
  await assert.rejects(s.call('eval', []), /desconhecida/);
});

test('host: cria a sala na rede, recebe o estado, escolhe mapa e inicia; a aba dona vai para o mapa', async () => {
  const net = new StubNet(), s = session({ net });
  let st = await s.call('create', [{ name: '  Davi\u0007', map: 'zombie_cod5_prototype' }], { tabId: 7 });
  assert.equal(st.phase, 'connecting');
  assert.equal(st.map.slug, 'nacht');
  assert.deepEqual(net.commands, [
    { cmd: 'config', args: { signalUrl: 'https://bo1z-signal.davi.workers.dev', name: 'Davi' } },
    { cmd: 'create', args: { name: 'Davi', map: 'zombie_cod5_prototype' } }]);
  // estado da rede (campos de §3 que ela conhece + lobbyMap)
  s.onNetState({ phase: 'lobby', role: 'host', room: 'K7QX2', invite: 'https://sig/j/K7QX2', you: { id: 'h1', name: 'Davi' },
    peers: [{ id: 'g1', name: 'Irmão', role: 'guest', ready: true, ping: 23, link: 'direct', loss: 0 }], signal: 'online',
    error: null, lobbyMap: 'zombie_cod5_prototype', startMap: null });
  st = s.getState();
  assert.equal(st.phase, 'lobby');
  assert.equal(st.mode, 'webrtc');
  assert.equal(st.peers[0].link, 'direct');
  assert.equal(st.browserInvite, 'https://vel.gg/bo1z/#bo1z-join=K7QX2&s=bo1z-signal.davi.workers.dev');
  assert.equal(await s.call('copyInvite', [], { tabId: 7 }), 'https://sig/j/K7QX2');
  assert.equal(s.gameFor(7), null); // no lobby a página do mapa ainda é solo
  await s.call('setMap', ['zombie_coast']);
  assert.deepEqual(net.commands.at(-1), { cmd: 'setMap', args: { map: 'zombie_coast' } });
  assert.equal(s.getState().map.slug, 'cotd');
  await s.call('setReady', [true]); // host não fica "pronto"
  assert.notEqual(net.commands.at(-1).cmd, 'setReady');
  await s.call('start', []);
  assert.deepEqual(net.commands.at(-1), { cmd: 'start', args: { map: 'zombie_coast' } });
  // eco do start do servidor: navegação da aba dona, papel de jogo só nela
  s.onNetState({ phase: 'starting', lobbyMap: 'zombie_coast', startMap: { zone: 'zombie_coast', at: 1000 } });
  assert.equal(s.getState().phase, 'starting');
  assert.deepEqual(s.navs, [{ url: 'https://vel.gg/bo1z/cotd#bo1z-start', map: s.mapByZone('zombie_coast'), tabId: 7 }]);
  assert.deepEqual(s.gameFor(7), { role: 'host', map: { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' }, name: 'Davi' });
  assert.equal(s.gameFor(8), null);
  // ping mudando não repete a navegação nem volta a fase
  s.onNetState({ phase: 'starting', startMap: { zone: 'zombie_coast', at: 1000 }, peers: [] });
  assert.equal(s.navs.length, 1);
  s.pageActive('host', 8); // outra aba não conta
  assert.equal(s.getState().phase, 'starting');
  s.pageActive('host', 7);
  assert.equal(s.getState().phase, 'playing');
  s.onNetState({ phase: 'starting', startMap: { zone: 'zombie_coast', at: 1000 } });
  assert.equal(s.getState().phase, 'playing'); // a rede fica em 'starting' para sempre; aqui não volta
  // novo start (mesmo mapa, outro "at"): navega de novo
  s.onNetState({ phase: 'starting', startMap: { zone: 'zombie_coast', at: 2000 } });
  assert.equal(s.navs.length, 2);
  // sair: rede sai, estado limpo
  await s.call('leave', []);
  assert.deepEqual(net.commands.at(-1), { cmd: 'leave', args: undefined });
  assert.equal(s.getState().phase, 'idle');
  assert.equal(s.gameFor(7), null);
});

test('convidado: entra pelo servidor do convite; pronto; start em texto (forma antiga) também navega', async () => {
  const net = new StubNet(), s = session({ net, signal: '' });
  let st = await s.call('join', [{ code: 'k7qx2', name: 'Irmão', signalUrl: 'http://127.0.0.1:8787' }], { tabId: 3 });
  assert.equal(st.phase, 'connecting');
  assert.equal(st.room, 'K7QX2');
  assert.deepEqual(net.commands.map(c => c.cmd), ['config', 'join']);
  assert.deepEqual(net.commands[1].args, { code: 'K7QX2', name: 'Irmão', signalUrl: 'http://127.0.0.1:8787' });
  s.onNetState({ phase: 'lobby', role: 'guest', room: 'K7QX2', you: { id: 'g1', name: 'Irmão', ready: false }, peers: [], lobbyMap: 'zombie_moon' });
  assert.equal(s.getState().map.slug, 'moon');
  await s.call('setReady', [true]);
  assert.deepEqual(net.commands.at(-1), { cmd: 'setReady', args: { ready: true } });
  await s.call('start', []); // convidado não inicia
  assert.equal(net.commands.at(-1).cmd, 'setReady');
  s.onNetState({ phase: 'starting', startMap: 'zombie_moon' });
  assert.equal(s.navs.at(-1).url, 'https://vel.gg/bo1z/moon#bo1z-start');
  assert.equal(s.gameFor(3).role, 'guest');
  // erro do motor no convidado aparece no estado, sem derrubar a sala
  s.pageError('engine', 'wasm do vel.gg mudou');
  assert.deepEqual(s.getState().error, { code: 'engine', message: 'wasm do vel.gg mudou' });
  assert.equal(s.getState().phase, 'starting');
  // a rede encerrou (host saiu): volta ao início
  s.onNetState({ phase: 'idle' });
  assert.equal(s.getState().phase, 'idle');
});

test('mapas do site substituem a lista padrão só se válidos; estado inicial da rede não mexe em nada', () => {
  const s = session();
  s.onNetState({ phase: 'idle', role: null });
  assert.equal(s.states.length, 0);
  s.setMaps([{ zone: 'zombie_x', slug: 'x', name: 'X' }, { zone: 'BAD ZONE', slug: 'y', name: 'Y' }]);
  assert.deepEqual(s.getState().maps, [{ zone: 'zombie_x', slug: 'x', name: 'X' }]);
  s.setMaps([]);
  s.setMaps('lixo');
  assert.equal(s.getState().maps.length, 1);
  assert.equal(s.getState().name, 'Davi');
});
