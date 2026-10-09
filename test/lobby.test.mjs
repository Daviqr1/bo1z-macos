// Lobby do co-op (app/lobby/): a parte pura (lobby-core.mjs) — ping e barras, selos, textos por fase/papel/erro,
// escolha do mapa, validação do que o jogador digita — e as garantias do módulo da página que dá para checar no Node
// (importa sem DOM, não monta sem __bo1zLobby, nunca usa HTML em texto). O DOM é conferido no Chromium por
// tools/lobby-shot.mjs (página de verdade do vel.gg) e no app por tools/lobby-electron.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as core from '../app/lobby/lobby-core.mjs';
import * as lobby from '../app/lobby/lobby.mjs';

const BASE = 'https://vel.gg/bo1z/';
const COTD = { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' };
const G1 = { id: 'g1', name: 'Irmão', role: 'guest', ready: true, ping: 24, link: 'direct', loss: 0 };
const G2 = { id: 'g2', name: 'Primo', role: 'guest', ready: false, ping: 87, link: 'relay', loss: 1 };
const H = { id: 'h0000000', name: 'Davi', role: 'host', ready: true, ping: 31, link: 'direct', loss: 0 };
const host = { phase: 'lobby', mode: 'webrtc', role: 'host', room: 'K7QX2', invite: 'https://s.example/j/K7QX2',
  you: { id: H.id, name: 'Davi' }, map: COTD, signal: 'online', error: null, peers: [G1, G2] };
const guest = { ...host, role: 'guest', you: { id: 'g1', name: 'Irmão', ready: false }, peers: [H, G2] };
const err = (code, message) => core.errorText({ code, message });
const LINKS = ['direct', 'relay', 'lan', 'connecting', 'lost'];

test('ping: barras por faixa, perda tira barra, caiu = 0, texto em ms', () => {
  assert.deepEqual([0, 30, 60, 61, 120, 121, 200, 201, 900].map(p => core.pingBars(p)), [4, 4, 4, 3, 3, 2, 2, 1, 1]);
  assert.equal(core.pingBars(null), 0);
  assert.equal(core.pingBars(NaN), 0);
  assert.equal(core.pingBars(-5), 0);
  assert.equal(core.pingBars(20, { loss: 3 }), 3);
  assert.equal(core.pingBars(20, { loss: 12 }), 2);
  assert.equal(core.pingBars(300, { loss: 50 }), 1, 'com conexão viva sobra ao menos 1 barra');
  assert.equal(core.pingBars(20, { link: 'lost' }), 0);
  assert.deepEqual([null, 0.4, 23.6, 87, 1500].map(core.pingText), ['—', '<1 ms', '24 ms', '87 ms', '999+ ms']);
  assert.deepEqual(core.quality(24), { bars: 4, tone: 'good', label: 'ÓTIMA' });
  assert.deepEqual(core.quality(150), { bars: 2, tone: 'ok', label: 'INSTÁVEL' });
  assert.deepEqual(core.quality(250), { bars: 1, tone: 'bad', label: 'RUIM' });
  assert.deepEqual(core.quality(24, { link: 'lost' }), { bars: 0, tone: 'bad', label: 'CAIU' });
});

test('selo do enlace: DIRETO/RELAY/LAN/CONECTANDO/CAIU', () => {
  assert.deepEqual(LINKS.map(l => core.linkBadge(l).text), ['DIRETO', 'RELAY', 'LAN', 'CONECTANDO', 'CAIU']);
  assert.deepEqual(LINKS.map(l => core.linkBadge(l).tone), ['good', 'warn', 'good', 'wait', 'bad']);
  assert.equal(core.linkBadge(null), null);
  assert.equal(core.linkBadge('qualquer'), null);
});

test('código da sala: puro, com espaço/hífen, link https ou bo1z://; alfabeto sem 0 O 1 I L', () => {
  assert.deepEqual(core.validateCode(' k7qx2 '), { ok: true, code: 'K7QX2' });
  assert.deepEqual(core.validateCode('K7Q-X2'), { ok: true, code: 'K7QX2' });
  assert.deepEqual(core.validateCode('https://bo1z-signal.davi.workers.dev/j/k7qx2'), { ok: true, code: 'K7QX2' });
  assert.deepEqual(core.validateCode('HTTPS://BO1Z-SIGNAL.DAVI.WORKERS.DEV/J/K7QX2'), { ok: true, code: 'K7QX2' });
  assert.deepEqual(core.validateCode('bo1z://join/K7QX2?s=x.workers.dev'), { ok: true, code: 'K7QX2' });
  assert.match(core.validateCode('').error, /Digite o código/);
  assert.match(core.validateCode('K7Q0X').error, /0, O, 1, I nem L/);
  assert.match(core.validateCode('KILL5').error, /0, O, 1, I nem L/);
  assert.match(core.validateCode('K7QX').error, /5 caracteres \(você digitou 4\)/);
  assert.match(core.validateCode('K7QX2Z').error, /5 caracteres/);
  assert.match(core.validateCode('K7Q!2').error, /só tem letras e números/);
  for (const ch of core.ROOM_ALPHABET) assert.ok(core.validateCode(ch.repeat(5)).ok, ch);
});

test('nome: limpa controle e espaços, até 24; vazio é recusado; prévia do nome no placar do motor', () => {
  assert.deepEqual(core.validateName('  Davi\u0007 '), { ok: true, name: 'Davi' });
  assert.equal(core.validateName('x'.repeat(40)).name.length, 24);
  assert.equal(core.validateName('   ').ok, false);
  assert.match(core.validateName('').error, /Digite seu nome/);
  assert.equal(core.gameName('João Zé'), 'Joo Z');
  assert.equal(core.gameName('Irmão do Davi da Silva'), 'Irmo do Davi da');
  assert.equal(core.gameName('ção'), 'o');
  assert.equal(core.gameName('ãã'), 'Player');
});

test('modo por IP: endereço com porta padrão, IPv6, convite colado; código opcional só no host', () => {
  const address = text => core.validateAddress(text).address;
  assert.equal(address('100.64.1.2'), '100.64.1.2:27960');
  assert.equal(address(' 192.168.0.10:28000 '), '192.168.0.10:28000');
  assert.equal(address('pc-davi.tail1234.ts.net'), 'pc-davi.tail1234.ts.net:27960');
  assert.equal(address('[fd7a:115c::1]:27960'), '[fd7a:115c::1]:27960');
  for (const bad of ['', '300.1.1.1', '1.2.3', '1.2.3.4:0', '1.2.3.4:70000', 'a b', '-host', 'a..b'])
    assert.equal(core.validateAddress(bad).ok, false, bad);
  const zumbi = { address: '100.64.1.2:27960', code: 'ZUMBI' };
  assert.deepEqual(core.parseIpInvite('100.64.1.2:27960 · código ZUMBI'), zumbi);
  assert.deepEqual(core.parseIpInvite('bo1z://ip/100.64.1.2%3A27960/ZUMBI'), zumbi);
  assert.deepEqual(core.parseIpInvite('192.168.0.10:27960 codigo: abc12'), { address: '192.168.0.10:27960', code: 'ABC12' });
  assert.equal(core.parseIpInvite('100.64.1.2:27960'), null);
  assert.deepEqual(core.validateIpCode('', 'host'), { ok: true, code: '' });
  assert.deepEqual(core.validateIpCode(' zumbi ', 'guest'), { ok: true, code: 'ZUMBI' });
  assert.equal(core.validateIpCode('', 'guest').ok, false);
  assert.equal(core.validateIpCode('AB', 'host').ok, false);
  assert.equal(core.validateIpCode('A'.repeat(13), 'guest').ok, false);
});

test('erros em pt-BR: sem servidor explica o modo por IP; sala cheia; código errado; host saiu; recusas do UDP', () => {
  const noSignal = err('no-signal', 'Servidor de convite não configurado (coop.signal…)');
  assert.equal(noSignal.title, 'SEM SERVIDOR DE CONVITE');
  assert.match(noSignal.hint, /POR IP/);
  assert.equal(noSignal.suggest, 'ip');
  assert.equal(err('config').suggest, 'ip');
  assert.equal(err('room-full').title, 'SALA CHEIA');
  assert.equal(err('rejected', 'Recusado pelo host: sala cheia').title, 'SALA CHEIA');
  assert.equal(err('room-not-found').title, 'CÓDIGO ERRADO');
  assert.equal(err('room-not-found').suggest, 'join');
  assert.equal(err('bad-code', 'Código de sala inválido (5 letras/números).').title, 'CÓDIGO INVÁLIDO');
  assert.equal(err('code', 'Código de sala inválido (são 5 letras/números).').title, 'CÓDIGO INVÁLIDO');
  assert.equal(err('rejected', 'Recusado pelo host: código da sala errado').title, 'CÓDIGO ERRADO');
  assert.equal(err('rejected', 'Recusado pelo host: versão 2 != 1').title, 'VERSÕES DIFERENTES');
  assert.equal(err('rejected', 'Recusado pelo host: outro motivo').text, 'Recusado pelo host: outro motivo');
  assert.equal(err('host-left').title, 'O HOST SAIU');
  assert.equal(err('closed', 'A sala foi encerrada.').title, 'O HOST SAIU');
  assert.equal(err('lost', 'Conexão perdida: host saiu').title, 'O HOST SAIU');
  assert.equal(err('lost', 'Conexão perdida: sem resposta do host').title, 'CONEXÃO PERDIDA');
  assert.match(err('udp-port', 'Não abriu a porta UDP 27960: EADDRINUSE').text, /27960/);
  assert.equal(err('offline').suggest, 'ip');
  assert.equal(err('xyz', 'algo\u0000 estranho').text, 'algo estranho');
  assert.equal(err('xyz').text, 'Erro: xyz');
  assert.equal(core.errorText(null), null);
});

test('texto de estado por fase e papel', () => {
  const allReady = host.peers.map(p => ({ ...p, ready: true })), noneReady = host.peers.map(p => ({ ...p, ready: false }));
  assert.match(core.statusText({ phase: 'idle' }), /Crie uma sala/);
  assert.match(core.statusText({ phase: 'connecting', role: 'host', mode: 'webrtc' }), /Criando a sala/);
  assert.match(core.statusText({ phase: 'connecting', role: 'host', mode: 'udp' }), /porta UDP/);
  assert.equal(core.statusText({ phase: 'connecting', role: 'guest', mode: 'webrtc', room: 'K7QX2' }), 'Entrando na sala K7QX2…');
  assert.equal(core.statusText({ phase: 'connecting', role: 'guest', mode: 'webrtc' }), 'Entrando na sala…');
  assert.match(core.statusText({ phase: 'connecting', role: 'guest', mode: 'udp' }), /Procurando o host/);
  assert.match(core.statusText({ ...host, peers: [] }), /Copie o convite/);
  assert.equal(core.statusText(host), 'Aguardando 1 convidado marcar PRONTO.');
  assert.equal(core.statusText({ ...host, peers: noneReady }), 'Aguardando 2 convidados marcar PRONTO.');
  assert.match(core.statusText({ ...host, peers: [G1] }), /Seu amigo está pronto/);
  assert.match(core.statusText({ ...host, peers: allReady }), /Todos prontos/);
  assert.match(core.statusText(guest), /Marque PRONTO/);
  assert.match(core.statusText({ ...guest, you: { ...guest.you, ready: true } }), /Aguardando o host iniciar/);
  // modo por IP: o pronto do convidado fica no topo do State (session.js)
  assert.match(core.statusText({ ...guest, you: { id: 'g1' }, ready: true }), /Aguardando o host iniciar/);
  assert.match(core.statusText({ ...guest, peers: [{ ...H, link: 'lost' }] }), /Sem resposta do host/);
  assert.equal(core.statusText({ ...host, phase: 'starting' }), 'Iniciando Call of the Dead…');
  assert.equal(core.statusText({ ...host, phase: 'playing' }), 'Partida em andamento em Call of the Dead.');
  assert.equal(core.statusText({ ...host, phase: 'error', error: { code: 'room-full' } }), 'A sala já tem 4 jogadores, o máximo.');
});

test('grupo: host primeiro, você marcado, vagas até 4; seu ping não aparece; nomes limpos', () => {
  const rows = core.partyRows(host), label = r => (r.empty ? '-' : `${r.name}${r.you ? '*' : ''}`);
  assert.deepEqual(rows.map(label), ['Davi*', 'Irmão', 'Primo', '-']);
  assert.deepEqual(rows.slice(0, 3).map(r => [r.host, r.ready]), [[true, true], [false, true], [false, false]]);
  assert.deepEqual([rows[0].bars, rows[0].pingLabel, rows[0].badge], [null, '', null]);
  assert.deepEqual(rows.slice(1, 3).map(r => [r.bars, r.pingLabel, r.badge.text]), [[4, '24 ms', 'DIRETO'], [3, '87 ms', 'RELAY']]);
  const g = core.partyRows(guest);
  assert.deepEqual(g.map(label), ['Davi', 'Irmão*', 'Primo', '-']);
  assert.equal(g[0].badge.text, 'DIRETO');
  // modo por IP no convidado: só o host na lista, pronto no topo do State
  const udp = core.partyRows({ phase: 'lobby', mode: 'udp', role: 'guest', you: { id: 'me', name: 'Irmão' }, ready: true,
    peers: [{ id: 'host', name: 'Davi', role: 'host', ready: true, ping: 0.4, link: 'lan', loss: null }] });
  assert.deepEqual(udp.map(r => (r.empty ? '-' : [r.name, r.ready, r.badge?.text ?? null])),
    [['Davi', true, 'LAN'], ['Irmão', true, null], '-', '-']);
  // nunca passa de 4, mesmo que a rede mande mais; nomes com controle saem limpos; sem nome vira o papel
  const extra = [{ id: 'g3', name: '\u0001X\u0002', role: 'guest' }, { id: 'g4', role: 'guest' }, { id: 'g5', name: 'E', role: 'guest' }];
  const crowd = core.partyRows({ ...host, peers: [...host.peers, ...extra] });
  assert.equal(crowd.length, 4);
  assert.equal(crowd[3].name, 'X');
  assert.equal(core.partyRows({ ...host, peers: [{ id: 'g4', role: 'guest' }] })[1].name, 'Convidado');
  const lost = core.partyRows({ ...host, peers: [{ ...G1, link: 'lost' }] })[1];
  assert.deepEqual([lost.bars, lost.pingLabel, lost.badge.text], [0, '—', 'CAIU'], 'ping velho não aparece em quem caiu');
  assert.deepEqual(core.partyRows({ phase: 'idle' }), []);
});

test('INICIAR PARTIDA: confirma sozinho ou com alguém não pronto; direto com todos prontos; fora do lobby, nada', () => {
  const alone = core.startAction({ ...host, peers: [] });
  assert.deepEqual([alone.mode, alone.ready, alone.confirm.title], ['confirm', false, 'INICIAR SOZINHO?']);
  assert.equal(core.startAction(host).mode, 'confirm');
  assert.equal(core.startAction(host).ready, true, 'com um convidado pronto o botão fica aceso');
  assert.match(core.startAction(host).confirm.text, /1 convidado ainda não marcou PRONTO/);
  assert.equal(core.startAction({ ...host, peers: host.peers.map(p => ({ ...p, ready: false })) }).ready, false);
  assert.equal(core.startAction({ ...host, peers: host.peers.map(p => ({ ...p, ready: true })) }).mode, 'go');
  assert.equal(core.startAction({ ...host, peers: [G1, { ...G2, link: 'lost' }] }).mode, 'go', 'quem caiu não segura a partida');
  assert.equal(core.startAction(guest).mode, 'off');
  assert.equal(core.startAction({ ...host, phase: 'starting' }).mode, 'off');
  assert.equal(core.startAction({ ...host, phase: 'connecting' }).mode, 'off');
  assert.equal(core.startAction({ ...host, map: null }).mode, 'off');
});

test('mapas: MAP_LIST do site > lista do State > embutida; troca com volta; arte por URL do site', () => {
  const five = { zone: 'zombie_pentagon', slug: 'five', name: 'Five' }, moon = { zone: 'zombie_moon', slug: 'moon', name: 'Moon' };
  const site = [{ ...five, horde: true }, COTD, { zone: 'BAD ZONE', slug: 'x', name: 'X' }, { ...moon, slug: '../moon' }, null];
  assert.deepEqual(core.pickMapList(site, null), [five, COTD]);
  assert.deepEqual(core.pickMapList(undefined, [moon]), [moon]);
  assert.equal(core.pickMapList(null, []).length, 10);
  const mainMaps = createRequire(import.meta.url)('../app/coop/session.js').DEFAULT_MAPS;
  assert.deepEqual(core.DEFAULT_MAPS.map(m => m.zone), mainMaps.map(m => m.zone), 'mesma lista do main');
  const maps = core.pickMapList(null, null);
  assert.equal(core.findMap(maps, 'cotd').zone, 'zombie_coast');
  assert.equal(core.findMap(maps, 'zombie_coast').slug, 'cotd');
  assert.equal(core.findMap(maps, 'nada'), null);
  assert.equal(core.cycleMap(maps, 'zombie_moon', 1).zone, 'zombie_pentagon', 'dá a volta');
  assert.equal(core.cycleMap(maps, 'zombie_pentagon', -1).zone, 'zombie_moon');
  assert.equal(core.cycleMap(maps, 'zombie_coast', 1).zone, 'zombie_temple');
  assert.equal(core.cycleMap(maps, 'nada', 1).zone, 'zombie_pentagon');
  assert.equal(core.cycleMap([], 'x', 1), null);
  assert.equal(core.initialMap(maps, { stateMap: { zone: 'zombie_moon' }, landingPick: 'kino' }).slug, 'moon');
  assert.equal(core.initialMap(maps, { landingPick: 'kino' }).slug, 'kino');
  assert.equal(core.initialMap(maps, {}).slug, 'five');
  assert.deepEqual(core.mapArt(COTD, BASE), { panel: `${BASE}art/mapselect-panel-cotd.webp`,
    loadscreen: `${BASE}art/loadscreen_zombie_coast.webp` });
  assert.equal(core.mapArt({ zone: 'x', slug: '../../evil' }, BASE), null);
  assert.equal(core.mapArt(null, BASE), null);
});

test('painel: qual tela, quando abre sozinho, selo do item na tela de mapas', () => {
  assert.equal(core.viewFor({ phase: 'idle' }), 'home');
  assert.equal(core.viewFor({ phase: 'idle' }, 'join'), 'join');
  assert.equal(core.viewFor({ phase: 'idle' }, 'ip'), 'ip');
  assert.equal(core.viewFor({ phase: 'idle' }, 'xyz'), 'home');
  for (const phase of ['connecting', 'lobby', 'starting', 'playing']) assert.equal(core.viewFor({ phase }, 'join'), 'room');
  assert.equal(core.viewFor({ phase: 'error' }, 'ip'), 'error');
  // convite pendente: o State já vem conectando/na sala
  assert.equal(core.autoOpen({ phase: 'idle' }, { phase: 'connecting', role: 'guest' }), true);
  assert.equal(core.autoOpen(null, { phase: 'lobby', role: 'host' }), true);
  assert.equal(core.autoOpen({ phase: 'lobby', role: 'host' }, { ...host }), false, 'só na transição');
  assert.equal(core.autoOpen({ phase: 'idle' }, { phase: 'error', role: 'guest' }), true);
  assert.equal(core.autoOpen({ phase: 'idle' }, { phase: 'error', role: null }), false);
  assert.equal(core.autoOpen({ phase: 'idle' }, { phase: 'idle' }), false);
  assert.equal(core.itemStatus({ phase: 'idle' }), null);
  assert.deepEqual(core.itemStatus(host), { text: 'SALA K7QX2 · 3/4', tone: 'good' });
  assert.deepEqual(core.itemStatus({ ...host, peers: [], room: null }), { text: 'NA SALA · 1/4', tone: 'good' });
  assert.equal(core.itemStatus({ phase: 'connecting' }).text, 'CONECTANDO…');
  assert.equal(core.itemStatus({ ...host, phase: 'playing' }).text, 'EM PARTIDA');
  assert.equal(core.itemStatus({ phase: 'error' }).tone, 'bad');
  assert.deepEqual(core.inviteInfo(host), { code: 'K7QX2', invite: 'https://s.example/j/K7QX2', kind: 'link' });
  assert.equal(core.inviteInfo({ ...host, mode: 'udp' }).kind, 'ip');
  assert.equal(core.inviteInfo({ phase: 'idle' }), null);
});

test('página do mapa: indicador, "Conectando ao host…" até playing, host caiu, quem saiu', () => {
  const title = state => core.indicator(state).notice?.title ?? null;
  assert.equal(core.indicator({ phase: 'idle' }).show, false);
  const h = core.indicator({ ...host, phase: 'playing' });
  assert.equal(h.show, true);
  assert.equal(h.title, 'CO-OP · K7QX2');
  assert.deepEqual(h.rows.map(r => [r.name, r.ping, r.badge.text]), [['Irmão', '24 ms', 'DIRETO'], ['Primo', '87 ms', 'RELAY']]);
  assert.equal(h.worst.name, 'Primo');
  assert.equal(h.notice, null);
  assert.equal(title({ ...guest, phase: 'starting' }), 'CONECTANDO AO HOST…');
  assert.equal(title({ ...guest, phase: 'playing' }), null);
  const lostHost = core.indicator({ ...guest, phase: 'playing', peers: [{ ...H, link: 'lost', ping: null }] });
  assert.deepEqual([lostHost.notice.title, lostHost.notice.tone], ['A CONEXÃO COM O HOST CAIU', 'bad']);
  assert.equal(title({ ...host, phase: 'playing', peers: [{ ...G1, link: 'lost' }, G2] }), 'IRMÃO CAIU');
  const hostLeft = { code: 'lost', message: 'Conexão perdida: host saiu' };
  assert.equal(title({ ...guest, phase: 'playing', error: hostLeft }), 'O HOST SAIU');
  assert.equal(title({ ...guest, phase: 'error', error: { code: 'host-left' } }), 'O HOST SAIU');
  // modo por IP: o host sai e o convidado recebe o erro e o enlace caído juntos; o porquê (erro) vem primeiro
  assert.equal(title({ ...guest, mode: 'udp', phase: 'playing', error: hostLeft, peers: [{ ...H, link: 'lost' }] }), 'O HOST SAIU');
  assert.deepEqual(core.departed(host, { ...host, peers: [G1] }), ['Primo']);
  assert.deepEqual(core.departed(host, { phase: 'idle', peers: [] }), [], 'sala acabou: não é "saiu"');
  assert.deepEqual(core.departed(null, host), []);
});

test('módulo da página: importa sem DOM, não monta sem __bo1zLobby, e não usa HTML em texto', () => {
  assert.equal(typeof lobby.mountLobby, 'function');
  assert.equal(lobby.mountLobby({}), null);
  assert.equal(lobby.mountLobby({ api: undefined, document: undefined }), null);
  assert.equal(lobby.mountLobby({ api: { getState() {} }, document: {} }), null, 'API incompleta: não monta');
  assert.equal(lobby.validateCode, core.validateCode, 'as funções puras saem também pelo lobby.mjs');
  const dir = new URL('../app/lobby/', import.meta.url);
  const html = /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs')))
    assert.doesNotMatch(readFileSync(new URL(file, dir), 'utf8'), html, file);
  // o main só serve nomes simples da pasta (main-coop.js): nada de subpastas
  for (const file of readdirSync(dir)) assert.match(file, /^[a-z0-9_-]+\.[a-z0-9]+$/i, file);
});
