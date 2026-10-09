// Documento offscreen: as conexões (chrome.runtime.Port) das abas do vel.gg e do popup com a sessão (session.mjs) e a
// rede (NetSession). Cada aba fala por um Port só ('bo1z-page'): chamadas do lobby, estado empurrado, navegação e os
// pacotes do motor (wire.mjs). A página do jogo que liga a ponte manda 'attach': aqui ela vira o "port de pacotes" da
// NetSession (o mesmo papel do MessagePort da janela net no app, COOP-ARCH §1/§4), sem MessageChannel no meio.
//
// Port -> offscreen: { t:'hello', href, slug } | { t:'prefs', prefs } | { t:'maps', maps } | { t:'call', id, fn, args }
//                    | { t:'attach' } | { t:'detach' } | { t:'p', … } / { t:'m', m } (pacotes §1) | { t:'active', role }
//                    | { t:'coop-error', code, message } | { t:'echo', … } (medida de latência)
// offscreen -> Port: { t:'hello', tabId, state, game } | { t:'state', state, game } | { t:'result', id, ok, value|error }
//                    | { t:'navigate', url } | { t:'p', … } / { t:'m', m } | { t:'echo', … }
import { ENCODINGS, packMsg, unpackMsg } from './wire.mjs';

export const PORT_NAMES = new Set(['bo1z-page', 'bo1z-ui']);

export class Hub {
  // openTab(url) -> Promise<tabId|null>: abre uma aba (service worker) quando a dona da sala não está mais aberta.
  constructor({ session, net = null, log = () => {}, openTab = async () => null }) {
    Object.assign(this, { session, net, log, openTab });
    this.conns = new Set();
    session.on('state', state => { for (const c of this.conns) c.pushState(state); });
    session.on('navigate', nav => this.navigate(nav));
  }

  stats() { return [...this.conns].map(c => ({ kind: c.kind, tabId: c.tabId, attached: !!c.packets, ...c.counters })); }

  connect(port, early = []) {
    const conn = new Conn(this, port);
    this.conns.add(conn);
    for (const m of early) conn.onMessage(m);
    return conn;
  }

  async navigate({ url, tabId }) {
    const target = [...this.conns].find(c => c.kind === 'page' && c.tabId === tabId) ??
      (tabId === null ? [...this.conns].find(c => c.kind === 'page') : null);
    if (target) { this.log(`aba ${target.tabId} -> ${url}`); target.post({ t: 'navigate', url }); return; }
    // a aba da sala foi fechada: abre outra (ela vira a dona)
    const opened = await this.openTab(url).catch(() => null);
    if (opened !== null && opened !== undefined) this.session.owner = opened;
    this.log(`aba nova para ${url}: ${opened ?? 'falhou'}`);
  }
}

class Conn {
  constructor(hub, port) {
    this.hub = hub;
    this.port = port;
    this.kind = port.name === 'bo1z-ui' ? 'ui' : 'page';
    this.tabId = port.sender?.tab?.id ?? null;
    this.alive = true;
    this.packets = null; // "port" de pacotes entregue à NetSession enquanto esta aba roda a ponte
    this.counters = { fromPage: 0, toPage: 0, dropped: 0 }; // pacotes do motor (diagnóstico)
    port.onMessage.addListener(m => this.onMessage(m));
    port.onDisconnect.addListener(() => this.closed());
  }

  post(m) {
    if (!this.alive) return false;
    try { this.port.postMessage(m); return true; } catch { this.closed(); return false; }
  }

  pushState(state) { this.post({ t: 'state', state, game: this.hub.session.gameFor(this.tabId) }); }

  async onMessage(m) {
    const { session, net } = this.hub;
    switch (m?.t) {
      case 'p': case 'm': {
        const msg = unpackMsg(m);
        if (msg?.t === 'pkt') ++this.counters.fromPage;
        if (msg && this.packets?.onmessage) this.packets.onmessage({ data: msg });
        else ++this.counters.dropped;
        break;
      }
      case 'hello':
        this.post({ t: 'hello', tabId: this.tabId, state: session.getState(), game: session.gameFor(this.tabId) });
        break;
      case 'prefs': session.setPrefs(m.prefs ?? {}); break;
      case 'maps': session.setMaps(m.maps); break;
      case 'call': {
        const ctx = { tabId: m.tabId ?? this.tabId };
        try { this.post({ t: 'result', id: m.id, ok: true, value: await session.call(m.fn, m.args, ctx) }); }
        catch (error) { this.post({ t: 'result', id: m.id, ok: false, error: error.message }); }
        break;
      }
      case 'attach': this.attach(); break;
      case 'detach': this.detach(); break;
      case 'active': session.pageActive(m.role, this.tabId); break;
      case 'coop-error': session.pageError(m.code, m.message); break;
      case 'echo': {
        // medida de latência: decodifica e recodifica como um pacote de verdade
        const codec = ENCODINGS[m.e ?? 'b64'];
        if (codec) this.post({ t: 'echo', seq: m.seq, e: m.e, b: codec.encode(codec.decode(m.b)) });
        break;
      }
    }
  }

  // A página do jogo ligou a ponte: os pacotes desta aba passam a ser os da NetSession (a anterior é fechada por ela).
  attach() {
    const { net, log } = this.hub;
    if (!net) { log('attach sem rede (app/net ausente)'); return; }
    if (this.packets) return; // a mesma aba pedindo de novo (hello atrasado): já está ligada
    const conn = this;
    const packets = {
      onmessage: null,
      postMessage(msg) {
        if (conn.packets !== packets) return;
        if (msg?.t === 'pkt') ++conn.counters.toPage;
        conn.post(packMsg(msg));
      },
      start() {},
      close() { if (conn.packets === packets) conn.packets = null; },
    };
    this.packets = packets;
    net.attachPort(packets);
    log(`aba ${this.tabId}: ponte ligada à rede`);
  }

  detach() { if (this.packets) { this.packets.onmessage = null; this.packets = null; } }

  closed() {
    if (!this.alive) return;
    this.alive = false;
    this.detach();
    this.hub.conns.delete(this);
  }
}
