// Content script no mundo isolado da aba do vel.gg: a ponte entre o mundo da página (content-main.js + page.mjs) e o
// documento offscreen da extensão (rede + estado da sala), que sobrevive à navegação tela inicial -> mapa.
//
//   página (mundo principal) ── MessagePort "ctl" (lobby, estado) + MessagePort de pacotes (protocolo §1, binário)
//        ⇅ (aqui)
//   chrome.runtime.Port 'bo1z-page' (JSON: pacotes em base64, wire.mjs) ⇅ offscreen (hub.mjs)
//
// Também: preferências (chrome.storage) para o offscreen, a lista de mapas do site, o convite no hash
// (#bo1z-join=…, invite.mjs) e a navegação para o mapa quando o host inicia.
import { ENCODINGS, packMsg, unpackMsg } from './wire.mjs';
import { parseInviteHash, slugFromPath } from './invite.mjs';
import { parseMapList } from './maps.mjs';
import { cleanName, loadPrefs } from './prefs.mjs';

const RETRY_MS = [100, 250, 500, 1000, 2000, 5000];

export class IsolatedLink {
  // runtime: { connect(name) -> Port, sendMessage(msg) -> Promise }; storage: chrome.storage.local (+ onChanged em
  // storageEvents); win: window (postMessage/addEventListener/history); nav: location (href, assign, reload);
  // base: URL da extensão.
  constructor({ runtime, storage, storageEvents = null, win, nav, base, inviteHash = '', fetchText = null, log = () => {} }) {
    Object.assign(this, { runtime, storage, storageEvents, win, nav, base, fetchText, log });
    this.invite = parseInviteHash(inviteHash);
    this.rport = null;
    this.ctl = null; // MessagePort com o mundo da página
    this.pkt = null; // MessagePort de pacotes (ponte do motor)
    this.state = null;
    this.game = undefined;
    this.pending = new Map(); // id da chamada -> true (para responder erro se a conexão cair)
    this.tries = 0;
    this.closed = false;
    this.prefs = { name: '', signal: '' };
  }

  async start() {
    this.listenMain();
    this.prefs = await loadPrefs(this.storage);
    this.storageEvents?.addListener((changes, area) => {
      if (area !== 'local' || (!changes.name && !changes.signal)) return;
      loadPrefs(this.storage).then(prefs => { this.prefs = prefs; this.rpost({ t: 'prefs', prefs }); });
    });
    this.loadMaps();
    await this.connect();
  }

  close() {
    this.closed = true;
    for (const p of [this.ctl, this.pkt]) { if (p) { p.onmessage = null; p.close(); } }
    try { this.rport?.disconnect(); } catch { /* já caiu */ }
    this.rport = null;
  }

  // ---- mundo da página: entrega o port "ctl" quando o content-main.js pede (a ordem de carga dos dois scripts varia)
  listenMain() {
    const channel = new MessageChannel();
    this.ctl = channel.port1;
    this.ctl.onmessage = ({ data, ports }) => this.fromMain(data, ports);
    let sent = false;
    this.win.addEventListener('message', event => {
      if (event.source !== this.win || event.data?.bo1zExt !== 'main' || sent) return;
      sent = true;
      this.win.postMessage({ bo1zExt: 'iso', base: this.base }, '*', [channel.port2]);
      if (this.state) this.toMain({ t: 'state', state: this.state });
      if (this.game !== undefined) this.toMain({ t: 'game', game: this.game });
    });
    this.win.postMessage({ bo1zExt: 'iso' }, '*'); // se o mundo da página já carregou, ele responde 'main'
  }

  toMain(m, transfer = []) { try { this.ctl.postMessage(m, transfer); } catch (error) { this.log(`ctl: ${error.message}`); } }

  fromMain(m, ports = []) {
    switch (m?.t) {
      case 'call': {
        if (!this.rport) { this.toMain({ t: 'result', id: m.id, ok: false, error: 'sem conexão com a extensão' }); return; }
        const first = m.args?.[0];
        if ((m.fn === 'create' || m.fn === 'join') && first?.name) this.rememberName(first.name);
        this.pending.set(m.id, true);
        this.rpost({ t: 'call', id: m.id, fn: m.fn, args: m.args ?? [] });
        break;
      }
      case 'pkt-port': if (ports[0]) this.bindPackets(ports[0]); break;
      case 'active': case 'coop-error': this.rpost(m); break;
      case 'echo': { // medida de latência: codifica aqui, como um pacote
        const codec = ENCODINGS[m.e ?? 'b64'];
        if (codec && m.b instanceof Uint8Array) this.rpost({ t: 'echo', seq: m.seq, e: m.e, b: codec.encode(m.b) });
        break;
      }
      case 'log': this.log(String(m.line ?? '')); break;
    }
  }

  rememberName(name) {
    const clean = cleanName(name);
    if (clean && clean !== this.prefs.name) {
      this.prefs = { ...this.prefs, name: clean };
      Promise.resolve(this.storage.set({ name: clean })).catch(() => {});
    }
  }

  bindPackets(port) {
    if (this.pkt && this.pkt !== port) { this.pkt.onmessage = null; try { this.pkt.close(); } catch { /* fechado */ } }
    this.pkt = port;
    port.onmessage = ({ data }) => this.rpost(packMsg(data));
    this.attach();
  }

  // Liga a ponte desta aba à rede, uma vez por conexão com o offscreen (de novo só se ele cair e voltar).
  attach() {
    if (!this.pkt || !this.rport || this.attachedTo === this.rport) return;
    if (this.rpost({ t: 'attach' })) this.attachedTo = this.rport;
  }

  // ---- offscreen
  rpost(m) {
    if (!this.rport) return false;
    try { this.rport.postMessage(m); return true; } catch { return false; }
  }

  async connect() {
    if (this.closed) return;
    try { await this.runtime.sendMessage({ to: 'sw', t: 'ensure' }); }
    catch (error) { this.log(`service worker: ${error.message}`); }
    let port;
    try { port = this.runtime.connect('bo1z-page'); } catch (error) { this.retry(`connect: ${error.message}`); return; }
    this.rport = port;
    port.onMessage.addListener(m => this.fromOffscreen(m));
    port.onDisconnect.addListener(() => {
      if (this.rport === port) this.rport = null;
      for (const id of this.pending.keys()) this.toMain({ t: 'result', id, ok: false, error: 'conexão com a extensão caiu' });
      this.pending.clear();
      this.retry('desconectado');
    });
    this.rpost({ t: 'hello', href: this.nav.href, slug: slugFromPath(new URL(this.nav.href).pathname) });
    this.rpost({ t: 'prefs', prefs: this.prefs });
    if (this.maps) this.rpost({ t: 'maps', maps: this.maps });
  }

  retry(why) {
    if (this.closed) return;
    const ms = RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)];
    this.log(`offscreen ${why}; tentando de novo em ${ms} ms`);
    setTimeout(() => this.connect(), ms);
  }

  fromOffscreen(m) {
    switch (m?.t) {
      case 'p': case 'm': {
        const msg = unpackMsg(m);
        if (msg && this.pkt) this.pkt.postMessage(msg, msg.b ? [msg.b.buffer] : []);
        break;
      }
      case 'hello':
        this.tries = 0;
        this.setState(m.state, m.game);
        this.attach(); // offscreen recriado: a ponte desta aba volta à rede
        if (this.invite) { const { code, signalUrl } = this.invite; this.invite = null; this.joinInvite(code, signalUrl); }
        break;
      case 'state': this.setState(m.state, m.game); break;
      case 'result':
        this.pending.delete(m.id);
        this.toMain(m);
        break;
      case 'navigate': this.go(m.url); break;
      case 'echo': {
        const codec = ENCODINGS[m.e ?? 'b64'], b = codec?.decode(m.b);
        if (b) this.toMain({ t: 'echo', seq: m.seq, b }, [b.buffer]);
        break;
      }
    }
  }

  // Vai para a página do mapa (host iniciou). Mantém a query da página atual (?renderer=…, ?perf=1; menos horde, como a
  // tela inicial do site faz). Se já está nessa URL, só mudar o hash não recarrega: põe a marca e recarrega.
  go(url) {
    const target = new URL(url), here = new URL(this.nav.href);
    if (!target.search) {
      const params = new URLSearchParams(here.search);
      params.delete('horde');
      target.search = params.toString();
    }
    this.log(`indo para ${target.href}`);
    if (target.origin + target.pathname + target.search === here.origin + here.pathname + here.search) {
      this.win.history.replaceState(this.win.history.state, '', target.href);
      this.nav.reload();
    } else this.nav.assign(target.href);
  }

  setState(state, game = null) {
    this.state = state;
    this.toMain({ t: 'state', state });
    if (JSON.stringify(game) !== JSON.stringify(this.game)) { this.game = game; this.toMain({ t: 'game', game }); }
  }

  // Convite aberto no navegador: entra na sala com o nome salvo.
  joinInvite(code, signalUrl) {
    this.log(`convite: sala ${code}${signalUrl ? ` em ${signalUrl}` : ''}`);
    const args = [{ code, signalUrl, name: this.prefs.name || 'Jogador' }];
    this.rpost({ t: 'call', id: `invite-${Date.now()}`, fn: 'join', args });
  }

  async loadMaps() {
    if (!this.fetchText) return;
    try {
      const maps = parseMapList(await this.fetchText(new URL('maps.js', 'https://vel.gg/bo1z/').href));
      if (maps.length) { this.maps = maps; this.rpost({ t: 'maps', maps }); }
    } catch (error) { this.log(`maps.js: ${error.message}`); }
  }
}

// Ponto de entrada (content-isolated.js).
export function start({ chrome, inviteHash }) {
  const link = new IsolatedLink({
    runtime: { connect: name => chrome.runtime.connect({ name }), sendMessage: msg => chrome.runtime.sendMessage(msg) },
    storage: chrome.storage.local, storageEvents: chrome.storage.onChanged, win: window, nav: location,
    base: chrome.runtime.getURL(''), inviteHash,
    fetchText: async url => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); },
    log: line => console.log(`BO1Z_EXT ${line}`),
  });
  link.start();
  return link;
}
