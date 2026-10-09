// Sessão de co-op do main (app/coop/session.js) sem Electron: links, mapas, erros e o lobby completo do modo por IP
// (UDP real em 127.0.0.1) até a navegação para o mapa nos dois lados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { CoopSession, parseLink, parseMapList, DEFAULT_MAPS } = createRequire(import.meta.url)('../app/coop/session.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(10); } return true; };

function session(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bo1z-session-'));
  const copied = [];
  const s = new CoopSession({
    deps: { clipboard: { writeText: t => copied.push(t) } },
    appDir: '/nao/usado', gameUrl: 'https://vel.gg/bo1z/', prefsFile: path.join(dir, 'coop.json'), env: {}, ...extra,
  });
  s.copied = copied;
  s.dir = dir;
  return s;
}

test('links bo1z://: join com servidor, ip com endereço; o resto é recusado', () => {
  assert.deepEqual(parseLink('bo1z://join/k7qx2?s=bo1z-signal.davi.workers.dev'), { kind: 'join', code: 'K7QX2', signal: 'https://bo1z-signal.davi.workers.dev' });
  assert.deepEqual(parseLink('bo1z://join/K7QX2'), { kind: 'join', code: 'K7QX2', signal: null });
  assert.deepEqual(parseLink('bo1z://ip/100.64.1.2%3A27960/ZUMBI'), { kind: 'ip', address: '100.64.1.2:27960', code: 'ZUMBI' });
  assert.equal(parseLink('bo1z://join/K7QO2'), null); // O fora do alfabeto
  assert.equal(parseLink('bo1z://join/K7QX2?s=evil.com/<script>').signal, null);
  assert.equal(parseLink('https://vel.gg/j/K7QX2'), null);
  assert.equal(parseLink('bo1z://algo'), null);
});

test('MAP_LIST do site é lido sem executar o arquivo', () => {
  const text = `export const MAP_LIST = [\n  { zone: 'zombie_pentagon', slug: 'five', name: 'Five', horde: true },\n  { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' },\n];`;
  assert.deepEqual(parseMapList(text), [{ zone: 'zombie_pentagon', slug: 'five', name: 'Five' }, { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' }]);
  assert.equal(DEFAULT_MAPS.length, 10);
});

test('sem servidor de convite: criar/entrar explicam o modo por IP; código inválido; papel de jogo só em partida', async () => {
  const s = session();
  let st = await s.create({ name: 'Davi' });
  assert.equal(st.phase, 'error');
  assert.equal(st.error.code, 'no-signal');
  st = await s.join({ code: 'abc' });
  assert.equal(st.error.code, 'bad-code');
  assert.equal(s.gameRole(), null);
  s.setState({ phase: 'lobby', role: 'host' });
  assert.equal(s.gameRole(), null); // no lobby a página do jogo ainda é solo
  s.setState({ phase: 'starting' });
  assert.equal(s.gameRole(), 'host');
  // o nome escolhido fica salvo para a próxima vez
  s.remember('  Davi\u0007 ');
  assert.equal(JSON.parse(readFileSync(path.join(s.dir, 'coop.json'), 'utf8')).name, 'Davi');
});

test('modo por IP: lobby completo (entrar, mapa, pronto, iniciar) e navegação nos dois lados', async t => {
  const host = session({ udpPort: 0 }), guest = session();
  t.after(() => { host.close(); guest.close(); });
  const navigated = { host: null, guest: null };
  host.on('navigate', n => { navigated.host = n; });
  guest.on('navigate', n => { navigated.guest = n; });

  let st = await host.connectByAddress({ role: 'host', code: 'zumbi', name: 'Davi', bind: '127.0.0.1', port: 0 });
  assert.equal(st.phase, 'lobby');
  assert.equal(st.room, 'ZUMBI');
  assert.match(st.invite, /código ZUMBI/);
  await host.setMap('zombie_cod5_prototype');
  const port = host.transport.port;

  await guest.connectByAddress({ role: 'guest', address: `127.0.0.1:${port}`, code: 'ZUMBI', name: 'Irmão' });
  assert.ok(await until(() => guest.state.phase === 'lobby' && host.state.peers.length === 1), 'convidado não entrou');
  assert.equal(host.state.peers[0].name, 'Irmão');
  assert.ok(await until(() => guest.state.map?.zone === 'zombie_cod5_prototype'), 'mapa não chegou ao convidado');
  assert.ok(await until(() => guest.state.peers[0]?.name === 'Davi'));

  await guest.setReady(true);
  assert.ok(await until(() => host.state.peers[0].ready === true), 'pronto não chegou ao host');
  assert.ok(await until(() => host.state.peers[0].ping !== null), 'sem ping');

  await host.start();
  assert.ok(await until(() => navigated.guest && navigated.host), 'início não navegou');
  assert.equal(navigated.host.url, 'https://vel.gg/bo1z/nacht');
  assert.equal(navigated.guest.url, 'https://vel.gg/bo1z/nacht');
  assert.equal(guest.state.phase, 'starting');
  assert.equal(guest.gameRole(), 'guest');
  guest.pageActive('guest');
  assert.equal(guest.state.phase, 'playing');

  assert.equal(await host.copyInvite(), host.state.invite);
  assert.deepEqual(host.copied, [host.state.invite]);
  await guest.leave();
  assert.equal(guest.state.phase, 'idle');
  assert.ok(await until(() => host.state.peers.length === 0), 'host não viu a saída');
});

test('modo por IP: código errado é recusado com mensagem', async t => {
  const host = session({ udpPort: 0 }), guest = session();
  t.after(() => { host.close(); guest.close(); });
  await host.connectByAddress({ role: 'host', code: 'CERTO', bind: '127.0.0.1', port: 0 });
  await guest.connectByAddress({ role: 'guest', address: `127.0.0.1:${host.transport.port}`, code: 'ERRADO' });
  assert.ok(await until(() => guest.state.phase === 'error'));
  assert.equal(guest.state.error.code, 'rejected');
  assert.match(guest.state.error.message, /código da sala errado/);
});
