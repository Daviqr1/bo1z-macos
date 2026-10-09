// Dublês dos contextos da extensão para os testes no Node: chrome.runtime.Port (com a serialização JSON de verdade),
// window (postMessage com ports) e a NetSession da janela net (app/net, peça em paralelo; só a interface do COOP-ARCH).

// Par de chrome.runtime.Port: o que um lado manda chega no outro como JSON, numa tarefa nova (como no Chrome).
export function portPair(name, tabId = null) {
  const make = () => ({ name, listeners: new Set(), gone: new Set(), peer: null, dead: false });
  const a = make(), b = make();
  a.peer = b; b.peer = a;
  const api = side => ({
    name,
    sender: side === b && tabId !== null ? { tab: { id: tabId } } : undefined,
    postMessage(m) {
      if (side.dead) throw new Error('Attempting to use a disconnected port object');
      const json = JSON.stringify(m);
      setTimeout(() => { if (!side.peer.dead) for (const fn of side.peer.listeners) fn(JSON.parse(json)); });
    },
    onMessage: { addListener: fn => side.listeners.add(fn), removeListener: fn => side.listeners.delete(fn) },
    onDisconnect: { addListener: fn => side.gone.add(fn) },
    disconnect() {
      if (side.dead) return;
      side.dead = side.peer.dead = true;
      setTimeout(() => { for (const fn of side.peer.gone) fn(); });
    },
  });
  return { page: api(a), offscreen: api(b), kill: () => api(b).disconnect() };
}

// window de mentira: postMessage entrega 'message' com source = a própria janela e os ports transferidos.
export function fakeWindow() {
  const win = new EventTarget();
  win.postMessage = (data, origin, transfer = []) => setTimeout(() => {
    const event = new Event('message');
    Object.assign(event, { data: structuredClone(data), source: win, ports: transfer });
    win.dispatchEvent(event);
  });
  return win;
}

// NetSession de mentira: guarda os comandos e o port de pacotes; o teste empurra estados com emit().
export class StubNet {
  constructor() { this.commands = []; this.port = null; this.fromPage = []; this.closedPorts = 0; }
  command(cmd, args) { this.commands.push({ cmd, args }); }
  attachPort(port) {
    if (this.port && this.port !== port) { this.port.onmessage = null; this.port.close(); ++this.closedPorts; }
    this.port = port;
    port.onmessage = event => this.fromPage.push(event.data);
    port.start?.();
  }
  toPage(msg) { this.port?.postMessage(msg); }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(5); }
  return true;
}
