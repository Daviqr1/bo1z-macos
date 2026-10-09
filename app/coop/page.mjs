// Co-op no mundo da página do vel.gg: liga a ponte (netbridge.mjs) aos rings do motor e a um MessagePort que leva os
// pacotes até o processo principal (udp.js). Carregado pelo preload só com sala ativa
// (https://vel.gg/__bo1z/coop/page.mjs, servido pelo main a partir de app/coop/).
//
// Mensagens no port:  main -> página: { t: 'join', id, slot, name } | { t: 'leave', id } | { t: 'pkt', id?, b } | { t: 'net', stats }
//                     página -> main: { t: 'pkt', id?, b } | { t: 'ready', rings } | { t: 'full', id } | { t: 'error', message }
import { createNetBridge, oobText } from './netbridge.mjs';

const RESERVED_RINGS = 8; // 3 convidados + folga para quem cai e volta (cada ring custa ~40 KB do heap)

export function startCoop({ role, port, layout, kb, log = console.log, intervalMs = 1, statsEveryMs = 5000 }) {
  const bridge = createNetBridge({ buffer: kb.memory.buffer, layout, malloc: kb.malloc, free: kb.free,
    log: (what, msg) => log(`${what} ${msg}`) });
  const spare = [], peers = new Map(), byName = new Map(), retired = [];
  const traffic = { in: 0, out: 0, inBytes: 0, outBytes: 0 }, handshake = [];
  let net = null;

  if (role === 'host') {
    // Reserva já (N1 roda antes do main do motor): é quando o heap está baixo o bastante para k <= 0xffff.
    for (let i = 0; i < RESERVED_RINGS; ++i) spare.push(bridge.openHostRing());
    log(`rings reservados: ${spare.join(',')}`);
  }
  port.postMessage({ t: 'ready', role, rings: [...spare] });

  // Linhas OOB (getchallenge, challengeResponse, connect, connectResponse, disconnect…) mostram o handshake no log.
  const trace = (dir, b, id) => {
    const text = oobText(b, 48);
    if (text === null) return;
    const line = `${dir}${id ? ' #' + id : ''} ${text}`;
    handshake.push(`${Math.round(performance.now())} ${line}`);
    if (handshake.length > 200) handshake.shift();
    log(`oob ${line}`);
  };

  function ringFor(id, name) {
    // Quem volta com o mesmo nome reusa o mesmo k: para o servidor é o mesmo endereço (reconexão, não slot novo).
    const again = name && byName.get(name);
    if (again && ![...peers.values()].includes(again)) return again;
    const k = spare.shift() ?? retired.shift();
    if (k !== undefined && name) byName.set(name, k);
    return k;
  }

  port.onmessage = ({ data: m }) => {
    if (m.t === 'pkt') {
      ++traffic.in; traffic.inBytes += m.b.length;
      trace('in', m.b, m.id);
      if (role === 'host') { const k = peers.get(m.id); if (k !== undefined) bridge.injectToServer(m.b, k); }
      else bridge.injectToClient(m.b);
    } else if (m.t === 'join' && role === 'host') {
      if (peers.has(m.id)) return; // o main reapresenta os convidados quando a página fica pronta; o join pode vir 2x
      const k = ringFor(m.id, m.name);
      if (k === undefined) { port.postMessage({ t: 'full', id: m.id }); log(`sem ring livre para #${m.id}`); return; }
      peers.set(m.id, k);
      bridge.drainRing(k, () => {}); // descarta o que o servidor ainda tinha para o dono anterior desse k
      log(`convidado #${m.id} ${m.name ?? ''} slot ${m.slot} -> ring ${k}`);
    } else if (m.t === 'leave' && role === 'host') {
      const k = peers.get(m.id);
      peers.delete(m.id);
      if (k !== undefined && ![...byName.values()].includes(k)) retired.push(k);
      log(`convidado #${m.id} saiu (${m.reason ?? ''})`);
    } else if (m.t === 'net') net = m.stats;
  };

  const send = (b, id) => {
    ++traffic.out; traffic.outBytes += b.length;
    trace('out', b, id);
    port.postMessage({ t: 'pkt', id, b }); // cópia: transferir o ArrayBuffer para o MessagePortMain do Electron falha
  };

  function tick() {
    if (role === 'host') for (const [id, k] of peers) bridge.drainRing(k, b => send(b, id));
    else bridge.drainClientOut(b => send(b));
    bridge.pump();
  }

  const stats = () => ({ role, traffic: { ...traffic }, peers: Object.fromEntries(peers), bridge: bridge.stats(), net });
  const timer = setInterval(tick, intervalMs);
  const statsTimer = statsEveryMs ? setInterval(() => log(`stats ${JSON.stringify(stats())}`), statsEveryMs) : null;
  return {
    bridge, stats, handshake, tick,
    stop() { clearInterval(timer); if (statsTimer) clearInterval(statsTimer); port.onmessage = null; },
  };
}

// Ponto de entrada usado pelo preload: espera o motor (evento bo1z:kb do patch N1) e o port do main.
// getLayout() só é chamado depois do evento: o main analisa o wasm quando ele passa pelo protocolo https.
export async function boot({ role, portPromise, getLayout }) {
  const log = msg => console.log(`BO1Z_COOP ${msg}`);
  try {
    const kb = globalThis.__bo1zKB ?? await new Promise(resolve => addEventListener('bo1z:kb', () => resolve(globalThis.__bo1zKB), { once: true }));
    const [port, layout] = await Promise.all([portPromise, getLayout()]);
    if (!layout?.ok) throw new Error(`layout dos rings indisponível: ${layout?.reason ?? 'wasm não analisado'}`);
    const coop = startCoop({ role, port, layout: layout.layout, kb, log });
    globalThis.__bo1zCoop = coop;
    log(`ativo como ${role}`);
    return coop;
  } catch (error) {
    log(`erro ${error.message}`);
    throw error;
  }
}
