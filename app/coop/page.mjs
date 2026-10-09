// Co-op no mundo da página do vel.gg: liga a ponte (netbridge.mjs) aos rings do motor e a um MessagePort que leva os
// pacotes até o processo principal (udp.js). Carregado pelo preload só com sala ativa
// (https://vel.gg/__bo1z/coop/page.mjs, servido pelo main a partir de app/coop/).
//
// Mensagens no port:  main -> página: { t: 'join', id, slot, name } | { t: 'leave', id } | { t: 'pkt', id?, b } | { t: 'net', stats }
//                     página -> main: { t: 'pkt', id?, b } | { t: 'ready', rings } | { t: 'full', id } | { t: 'error', message }
import { createNetBridge, oobText } from './netbridge.mjs';

// qport que o cliente do convidado manda no userinfo do "connect" (\qport\-5671, com sinal). Motor novo = qport novo.
export function connectQport(text) {
  if (!text?.startsWith('connect ')) return null;
  const m = /\\qport\\(-?\d+)/.exec(text);
  return m ? Number(m[1]) & 0xffff : null;
}

const RESERVED_RINGS = 8; // 3 convidados + folga para quem cai e volta (cada ring custa ~40 KB do heap)

// rings: ks já reservados (Worker: o malloc é feito na página). schedule: 'interval' (setInterval, piso de ~4 ms na
// página) ou 'wait' (Atomics.waitAsync de 1 ms, para o Worker dedicado).
export function startCoop({ role, port, layout, kb, log = console.log, intervalMs = 1, statsEveryMs = 10000, rings = null, schedule = 'interval' }) {
  const bridge = createNetBridge({ buffer: kb.memory.buffer, layout, malloc: kb.malloc, free: kb.free,
    log: (what, msg) => log(`${what} ${msg}`) });
  // Cada ring k é um endereço (porta k) para o servidor. O servidor guarda o slot de quem conectou por ele até o
  // timeout; um "connect" novo pelo mesmo k com outro qport (motor recarregado, outro convidado) levaria
  // EXE_ERR_QPORT e o cliente desiste. Por isso: ring novo a cada entrada e a cada qport novo; reciclagem só dos mais
  // antigos (o slot velho já expirou quando chega a vez deles).
  const spare = [], peers = new Map(), retired = [], ringQport = new Map();
  const takeRing = () => spare.shift() ?? retired.shift();
  const traffic = { in: 0, out: 0, inBytes: 0, outBytes: 0 }, handshake = [];
  let net = null;

  if (role === 'host') {
    // Reserva já (N1 roda antes do main do motor): é quando o heap está baixo o bastante para k <= 0xffff.
    if (rings) for (const k of rings) spare.push(bridge.openHostRing(k));
    else for (let i = 0; i < RESERVED_RINGS; ++i) spare.push(bridge.openHostRing());
    log(`rings reservados: ${spare.join(',')}`);
  }
  port.postMessage({ t: 'ready', role, rings: [...spare] });

  // Linhas OOB (getchallenge, challengeResponse, connect, connectResponse, disconnect…) mostram o handshake no log.
  const trace = (dir, b, id) => {
    const text = oobText(b, 48);
    if (text === null) return;
    if (text === null) return;
    const line = `${dir}${id ? ' #' + id : ''} ${text.replace(/^(connect) .*/, '$1 …')}`;
    handshake.push(`${Math.round(performance.now())} ${line}`);
    if (handshake.length > 200) handshake.shift();
    log(`oob ${line}`);
  };

  function checkConnect(id, b) {
    const qport = connectQport(oobText(b, 4096)), k = peers.get(id);
    if (qport === null || k === undefined) return;
    const before = ringQport.get(k);
    if (before === undefined || before === qport) { ringQport.set(k, qport); return; }
    const fresh = takeRing();
    if (fresh === undefined) { log(`sem ring livre para o novo connect de #${id}`); return; }
    retired.push(k);
    peers.set(id, fresh);
    ringQport.set(fresh, qport);
    bridge.drainRing(fresh, () => {});
    log(`connect de #${id} com qport novo (${before} -> ${qport}): ring ${k} -> ${fresh}`);
  }

  port.onmessage = ({ data: m }) => {
    if (m.t === 'pkt') {
      ++traffic.in; traffic.inBytes += m.b.length;
      trace('in', m.b, m.id);
      if (role === 'host') {
        if (m.b[0] === 0xff) checkConnect(m.id, m.b);
        const k = peers.get(m.id);
        if (k !== undefined) bridge.injectToServer(m.b, k);
      } else bridge.injectToClient(m.b);
    } else if (m.t === 'join' && role === 'host') {
      if (peers.has(m.id)) return; // o main reapresenta os convidados quando a página fica pronta; o join pode vir 2x
      const k = takeRing();
      if (k === undefined) { port.postMessage({ t: 'full', id: m.id }); log(`sem ring livre para #${m.id}`); return; }
      peers.set(m.id, k);
      bridge.drainRing(k, () => {}); // descarta o que o servidor ainda tinha para o dono anterior desse k
      log(`convidado #${m.id} ${m.name ?? ''} slot ${m.slot} -> ring ${k}`);
    } else if (m.t === 'leave' && role === 'host') {
      const k = peers.get(m.id);
      peers.delete(m.id);
      if (k !== undefined) retired.push(k);
      log(`convidado #${m.id} saiu (${m.reason ?? ''})`);
    } else if (m.t === 'net') net = m.stats;
  };

  const send = (b, id) => {
    ++traffic.out; traffic.outBytes += b.length;
    trace('out', b, id);
    port.postMessage({ t: 'pkt', id, b }); // cópia: transferir o ArrayBuffer para o MessagePortMain do Electron falha
  };

  // Convidado: só encaminha o que o cliente manda quando ele está conectado ao host (serverAddress = "localhost" com a
  // porta do layout). Na estratégia shadow o cliente primeiro fala com o servidor local (porta 0): isso não sai daqui.
  let armed = false;
  const armedNow = () => {
    const t = bridge.clientTarget();
    return t === null ? true : t.type === 2 && t.port === (layout.clientServerPort ?? 0);
  };
  // Servidor sombra: depois que o cliente passa a seguir o host, o servidor local do convidado fica pausado
  // (sv_paused=1): não simula o "jogador fantasma" (que os zumbis locais matariam, encerrando a partida local) nem
  // gasta CPU, mas continua de pé com os dados que o cgame lê. O motor não volta o valor sozinho; reaplicamos mesmo assim.
  let pausedShadow = false;
  function holdShadow() {
    if (!armed || bridge.dvar('sv_running') !== 1) return;
    if (bridge.dvar('sv_paused') !== 1 && bridge.setDvar('sv_paused', 1) && !pausedShadow) { pausedShadow = true; log('servidor sombra pausado (sv_paused=1)'); }
  }
  function tick() {
    if (role === 'host') for (const [id, k] of peers) bridge.drainRing(k, b => send(b, id));
    else {
      const now = armedNow();
      if (now !== armed) { armed = now; log(armed ? 'cliente apontando para o host: encaminhando' : 'cliente fora do host (servidor local): segurando'); }
      bridge.drainClientOut(b => send(b), Infinity, armed);
      holdShadow();
    }
    bridge.pump();
  }

  const stats = () => ({ role, armed, pausedShadow, traffic: { ...traffic }, peers: Object.fromEntries(peers), bridge: bridge.stats(), net });
  let timer = null, running = true;
  if (schedule === 'wait') {
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    (async () => { while (running) { tick(); await Atomics.waitAsync(sleeper, 0, 0, intervalMs).value; } })();
  } else timer = setInterval(tick, intervalMs);
  // Estatísticas no log só quando o tráfego muda (a cada statsEveryMs no máximo), para não encher o arquivo parado.
  let lastStats = '';
  const statsTimer = statsEveryMs ? setInterval(() => {
    const s = stats(), key = JSON.stringify([s.traffic.in, s.traffic.out, s.bridge.clobbered, s.bridge.phantom, s.bridge.dropped]);
    if (key !== lastStats) { lastStats = key; log(`stats ${JSON.stringify(s)}`); }
  }, statsEveryMs) : null;
  return {
    bridge, stats, handshake, tick,
    stop() { running = false; clearInterval(timer); if (statsTimer) clearInterval(statsTimer); port.onmessage = null; },
  };
}

// Ponto de entrada usado pelo preload: espera o motor (evento bo1z:kb do patch N1) e o port do main.
// getLayout() só é chamado depois do evento: o main analisa o wasm quando ele passa pelo protocolo https.
// A ponte roda num Worker dedicado (bridge-worker.mjs); sem Worker, roda aqui mesmo (setInterval).
export async function boot({ role, portPromise, getLayout, worker = true }) {
  const log = msg => console.log(`BO1Z_COOP ${msg}`);
  try {
    const kb = globalThis.__bo1zKB ?? await new Promise(resolve => addEventListener('bo1z:kb', () => resolve(globalThis.__bo1zKB), { once: true }));
    const [port, layout] = await Promise.all([portPromise, getLayout()]);
    if (!layout?.ok) throw new Error(`layout dos rings indisponível: ${layout?.reason ?? 'wasm não analisado'}`);
    let rings = null;
    if (role === 'host') {
      // malloc só na thread da página (Module); o Worker recebe os k prontos
      const reserve = createNetBridge({ buffer: kb.memory.buffer, layout: layout.layout, malloc: kb.malloc, free: kb.free });
      rings = Array.from({ length: RESERVED_RINGS }, () => reserve.openHostRing());
    }
    if (worker && typeof Worker === 'function') {
      try {
        const w = new Worker(new URL('./bridge-worker.mjs', import.meta.url), { type: 'module', name: 'bo1z-coop' });
        let last = null;
        const facade = { mode: 'worker', role, layout: layout.layout, worker: w, stats: () => last, handshake: [] };
        await new Promise((resolve, reject) => {
          w.onmessage = ({ data: m }) => {
            if (m.t === 'log') { log(m.line); if (/^oob /.test(m.line)) { facade.handshake.push(m.line); if (facade.handshake.length > 200) facade.handshake.shift(); } }
            else if (m.t === 'stats') last = m.stats;
            else if (m.t === 'started') resolve();
            else if (m.t === 'error') reject(new Error(m.message));
          };
          w.onerror = e => reject(new Error(e.message || 'erro no Worker'));
          w.postMessage({ t: 'start', buffer: kb.memory.buffer, layout: layout.layout, role, rings, port }, [port]);
        });
        globalThis.__bo1zCoop = facade;
        log(`ativo como ${role} (Worker)`);
        return facade;
      } catch (error) {
        log(`Worker indisponível (${error.message}); ponte na página`);
      }
    }
    const coop = startCoop({ role, port, layout: layout.layout, kb, log, rings });
    globalThis.__bo1zCoop = coop;
    log(`ativo como ${role}`);
    return coop;
  } catch (error) {
    log(`erro ${error.message}`);
    throw error;
  }
}
