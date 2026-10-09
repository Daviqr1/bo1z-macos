// Ponta a ponta da janela net no Electron de verdade (rodado por test/net-e2e.test.mjs; no Linux com xvfb-run):
// servidor de sinalização de teste em processo (ws + StubSignal, o mínimo do COOP-ARCH §2), duas janelas net ocultas
// (app/net/net.html com o preload, criadas por app/net/net-window.js como o main fará), WebRTC real entre elas e as
// páginas do jogo simuladas aqui com MessageChannelMain falando o protocolo §1.
// Saída: uma linha JSON por etapa ({ step, ... }) e { done: true, ok, error? } no fim.
'use strict';
const { app, MessageChannelMain } = require('electron');
const path = require('node:path');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { WebSocketServer } = require('ws');
const { applyNetSwitches, createNetWindow } = require('../../app/net/net-window.js');

if (process.env.BO1Z_E2E_MDNS !== '1') applyNetSwitches(app); // BO1Z_E2E_MDNS=1: testa com os candidatos .local
app.on('window-all-closed', () => {}); // quem encerra é o teste
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(what, ms, fn) {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`tempo esgotado (${ms} ms): ${what}`);
    await sleep(20);
  }
}
const importTest = file => import(pathToFileURL(path.join(__dirname, '..', file)).href);

async function main() {
  const { StubSignal } = await importTest('net-stub-signal.mjs');
  const { makePacket, checkPacket } = await importTest('helpers.mjs');

  // Servidor de sinalização (o real é outra peça: signal/)
  const stub = new StubSignal({ graceMs: 0, host: '127.0.0.1' });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws', maxPayload: 16 * 1024 });
  wss.on('connection', ws => {
    const handle = stub.attach({ send: text => ws.send(text), close: () => ws.close() });
    ws.on('message', data => handle.onMessage(String(data)));
    ws.on('close', () => handle.onClose());
  });
  await once(wss, 'listening');
  const signalUrl = process.env.BO1Z_E2E_SIGNAL || `ws://127.0.0.1:${wss.address().port}`;

  const netWindow = name => {
    const w = { name, states: [], logs: [] };
    w.net = createNetWindow({ onState: s => w.states.push(s), onLog: line => w.logs.push(line) });
    w.state = () => w.states.at(-1) ?? {};
    w.net.command('config', { signalUrl, name });
    return w;
  };
  // "Página do jogo": um lado do MessageChannelMain fica aqui, o outro vai para a janela net.
  const gamePage = (w, role) => {
    const { port1, port2 } = new MessageChannelMain();
    const page = { got: [], port: port1, of: t => page.got.filter(m => m.t === t) };
    port1.on('message', event => page.got.push(event.data));
    port1.start();
    w.net.attachPort(port2);
    port1.postMessage({ t: 'ready', role, rings: role === 'host' ? [524, 525, 526] : [] });
    return page;
  };
  // n pacotes de `size` bytes (autovalidados: produtor, sequência, crc) de uma página para a outra
  const traffic = async (from, to, { id, producer, n = 300, size = 1264, gapMs = 4 }) => {
    const before = to.of('pkt').length, t0 = Date.now();
    for (let i = 0; i < n; ++i) {
      const b = makePacket(producer, i, size);
      from.port.postMessage(id ? { t: 'pkt', id, b } : { t: 'pkt', b });
      if (gapMs) await sleep(gapMs);
    }
    await sleep(700);
    const got = to.of('pkt').slice(before).filter(m => m.b?.[4] === producer);
    const checks = got.map(m => checkPacket(m.b instanceof Uint8Array ? m.b : new Uint8Array(m.b)));
    return { sent: n, got: got.length, valid: checks.every(c => c.ok), sizes: [...new Set(got.map(m => m.b.length))],
      ids: [...new Set(got.map(m => m.id ?? null))], ms: Date.now() - t0 };
  };
  const peerOf = (w, id) => w.state().peers?.find(p => p.id === id);

  // 1. host cria a sala
  const host = netWindow('Davi');
  host.net.command('create', { name: 'Davi', map: 'zombie_coast' });
  const hostPage = gamePage(host, 'host');
  await until('host no lobby', 15000, () => host.state().phase === 'lobby' && host.state().room);
  const room = host.state().room;
  out({ step: 'sala', room, invite: host.state().invite, signal: host.state().signal, lobbyMap: host.state().lobbyMap });

  // 2. convidado entra pelo código; DataChannels abrem com WebRTC real
  let guest = netWindow('Irmao');
  let guestPage = gamePage(guest, 'guest');
  const t0 = Date.now();
  guest.net.command('join', { code: room, name: 'Irmao' });
  await until('convidado na sala', 15000, () => guest.state().phase === 'lobby' && guest.state().you?.id);
  let guestId = guest.state().you.id;
  const join = await until('join na página do host', 20000, () => hostPage.of('join').find(m => m.id === guestId));
  const connectMs = Date.now() - t0;
  await until('link direct com ping nos dois lados', 15000, () => {
    const a = peerOf(host, guestId), b = guest.state().peers?.[0];
    return a?.link === 'direct' && typeof a.ping === 'number' && b?.link === 'direct' && typeof b.ping === 'number';
  });
  out({ step: 'conectado', join, connectMs, hostView: peerOf(host, guestId), guestView: guest.state().peers[0] });

  // 3. pacotes de 1264 B nos dois sentidos (convidado -> host chega com id; host -> convidado sem id)
  const up = await traffic(guestPage, hostPage, { producer: 1 });
  const down = await traffic(hostPage, guestPage, { id: guestId, producer: 2 });
  out({ step: 'trafego', up, down, guestId });

  // 4. RTT e tipo de caminho medidos (ping no ctl, getStats)
  await sleep(2500);
  const net = hostPage.of('net').at(-1)?.stats;
  out({ step: 'medidas', hostPing: peerOf(host, guestId).ping, guestPing: guest.state().peers[0].ping,
    link: peerOf(host, guestId).link, loss: peerOf(host, guestId).loss, path: net?.peers?.[0]?.path,
    rtt: net?.peers?.[0]?.rtt });

  // 5. rajada sem pausa: o que não cabe (bufferedAmount > 64 KiB) é descartado, sem fila e sem travar
  const burst = await traffic(hostPage, guestPage, { id: guestId, producer: 3, n: 3000, gapMs: 0 });
  await sleep(2500);
  const afterBurst = hostPage.of('net').at(-1)?.stats?.peers?.[0];
  const recover = await traffic(hostPage, guestPage, { id: guestId, producer: 4, n: 100 });
  out({ step: 'rajada', burst: { sent: burst.sent, got: burst.got, valid: burst.valid }, congested: afterBurst?.congested,
    dropped: afterBurst?.dropped, recover: { sent: recover.sent, got: recover.got } });

  // 5b. ICE restart dos dois lados no mesmo instante (colisão de ofertas no Chromium de verdade) e, depois, o
  //     convidado troca o RTCPeerConnection inteiro (gen 2): o host acompanha sem leave/join e o tráfego segue
  const inNet = (w, code) => w.net.win.webContents.executeJavaScript(`(() => { const s = globalThis.__bo1zNetSession;
    const links = [...s.links.values()].map(e => e.link); ${code} })()`);
  const pcInfo = w => inNet(w, `return links.map(l => ({ gen: l.gen, sig: l.pc?.signalingState,
    ice: l.pc?.iceConnectionState, restarts: l.counters.restarts, resets: l.counters.resets, link: l.link }));`);
  const joinsBefore = hostPage.of('join').length, leavesBefore = hostPage.of('leave').length;
  // os dois lados estáveis e conectados (e, com gen, na geração pedida)
  const settled = async gen => {
    const end = Date.now() + 10000;
    for (;;) {
      const info = { host: await pcInfo(host), guest: await pcInfo(guest) };
      const all = [...info.host, ...info.guest];
      if (all.every(i => i.sig === 'stable' && /connected|completed/.test(i.ice) && (!gen || i.gen === gen))) return info;
      if (Date.now() > end) throw new Error(`renegociação não assentou: ${JSON.stringify(info)}`);
      await sleep(50);
    }
  };
  const forceRestart = `for (const l of links) { l.lastRestart = -Infinity; l.restartIce('teste e2e'); } return true;`;
  await Promise.all([inNet(host, forceRestart), inNet(guest, forceRestart)]);
  await sleep(300);
  const afterRestart = await settled();
  const restartUp = await traffic(guestPage, hostPage, { producer: 8, n: 100 });
  const restartDown = await traffic(hostPage, guestPage, { id: guestId, producer: 9, n: 100 });
  await inNet(guest, `links[0].reset('teste e2e'); return true;`);
  await sleep(300);
  const afterReset = await settled(2);
  const resetUp = await traffic(guestPage, hostPage, { producer: 10, n: 100 });
  const resetDown = await traffic(hostPage, guestPage, { id: guestId, producer: 11, n: 100 });
  out({ step: 'renegociacao', afterRestart, afterReset,
    restart: { up: restartUp.got, down: restartDown.got, sent: 100 },
    reset: { up: resetUp.got, down: resetDown.got, sent: 100 },
    joins: hostPage.of('join').length - joinsBefore, leaves: hostPage.of('leave').length - leavesBefore,
    collision: guest.logs.some(l => l.includes('colisão')) || host.logs.some(l => l.includes('colisão')) });

  // 6. página nova do host (outro mapa): ao mandar ready recebe o convidado de novo (join), e o tráfego vai para ela
  const hostPage2 = gamePage(host, 'host');
  const rejoin = await until('join na página nova', 5000, () => hostPage2.of('join').find(m => m.id === guestId));
  const toNew = await traffic(guestPage, hostPage2, { producer: 5, n: 50 });
  out({ step: 'pagina-nova', rejoin, toNew: { sent: toNew.sent, got: toNew.got, ids: toNew.ids },
    oldGotMore: hostPage.of('pkt').filter(m => m.b?.[4] === 5).length });

  // 7. convidado fecha a janela (sai da sala): o host recebe leave
  let t = Date.now();
  guest.net.close();
  const leave = await until('leave depois de fechar', 20000, () => hostPage2.of('leave').find(m => m.id === guestId));
  const leaveMs = Date.now() - t;
  // o estado vem por outro canal (IPC) que o leave (port): espera ele também
  const gone = await until('host sem o par (estado)', 5000, () => host.state().peers?.length === 0);
  out({ step: 'fechou', leave, ms: leaveMs, peers: gone ? 0 : host.state().peers.length });

  // 8. reabre e entra de novo com o mesmo código: join (id novo) e tráfego nos dois sentidos
  guest = netWindow('Irmao');
  guestPage = gamePage(guest, 'guest');
  t = Date.now();
  guest.net.command('join', { code: room.toLowerCase(), name: 'Irmao' });
  await until('convidado de volta', 15000, () => guest.state().phase === 'lobby' && guest.state().you?.id);
  const oldId = guestId;
  guestId = guest.state().you.id;
  const back = await until('join de novo', 20000, () => hostPage2.of('join').find(m => m.id === guestId));
  const up2 = await traffic(guestPage, hostPage2, { producer: 6, n: 100 });
  const down2 = await traffic(hostPage2, guestPage, { id: guestId, producer: 7, n: 100 });
  out({ step: 'voltou', back, oldId, ms: Date.now() - t, up: up2, down: down2, link: peerOf(host, guestId)?.link });

  // 9. convidado trava (processo morto, sem leave nem fechamento do WebRTC): o servidor avisa a queda da
  //    sinalização, mas o host só dá o par como perdido pelo próprio enlace (15 s sem pong)
  t = Date.now();
  guest.net.win.webContents.forcefullyCrashRenderer();
  const lost = await until('leave depois do travamento', 30000, () => hostPage2.of('leave').find(m => m.id === guestId));
  const lostMs = Date.now() - t;
  const left = await until('host sem o par (estado)', 5000, () => host.state().peers?.length === 0);
  out({ step: 'travou', lost, ms: lostMs, peers: left ? 0 : host.state().peers.length });

  host.net.close();
  await sleep(300);
  wss.close();
  out({ step: 'logs', host: host.logs.slice(-40) });
}

const watchdog = setTimeout(() => {
  out({ done: true, ok: false, error: 'tempo total esgotado' });
  app.exit(2);
}, 150000);
app.whenReady()
  .then(main)
  .then(() => { out({ done: true, ok: true }); clearTimeout(watchdog); app.exit(0); })
  .catch(error => {
    out({ done: true, ok: false, error: error.stack ?? String(error) });
    clearTimeout(watchdog);
    app.exit(1);
  });
