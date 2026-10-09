// Mundo principal da aba do vel.gg (carregado pelo content-main.js quando o mundo isolado entrega o contexto): API do
// lobby (__bo1zLobby, COOP-ARCH §3) sobre o port "ctl", o lobby nativo (app/lobby/lobby.mjs, se veio no build), e o
// motor numa partida de co-op: N1/G1/argumentos (engine.mjs), layout dos rings (app/coop/wasmscan.mjs) e a ponte
// (app/coop/page.mjs boot, num Worker dedicado).
import { coopArgs, prepareGuestWasm, sha256Hex, wrapExports } from './engine.mjs';
import { percentiles } from './wire.mjs';

const GAME_WAIT_MS = 5000; // quanto o motor espera a resposta "esta aba é host/convidado?" antes de subir solo
const log = line => console.log(`BO1Z_COOP ${line}`);

const asBytes = src => src instanceof Uint8Array ? src : ArrayBuffer.isView(src)
  ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : new Uint8Array(src);

// page.mjs cria o Worker da ponte com new URL('./bridge-worker.mjs', import.meta.url): numa página do vel.gg isso é
// chrome-extension://… e o navegador recusa Worker de outra origem. Enquanto a ponte sobe, só essa URL vira um
// Worker blob: (mesma origem da página, herda o COEP) que importa o módulo da extensão (CORS dos recursos acessíveis).
// Os outros Workers da página (pthreads do motor, download) passam direto.
export function bridgeWorkerOverride(base, scope = globalThis) {
  const Native = scope.Worker, target = new URL('coop/bridge-worker.mjs', base).href;
  let blobUrl = null;
  const Mapped = class Worker extends Native {
    constructor(url, options) {
      if (String(url) === target) {
        blobUrl ??= URL.createObjectURL(new Blob([`import ${JSON.stringify(target)};\n`], { type: 'text/javascript' }));
        url = blobUrl;
      }
      super(url, options);
    }
  };
  scope.Worker = Mapped;
  return () => { if (scope.Worker === Mapped) scope.Worker = Native; };
}

class PageWorld {
  constructor(ext, { base, ctl }) {
    Object.assign(this, { ext, base, ctl });
    this.seq = 0;
    this.calls = new Map();
    this.echoes = new Map();
    this.game = undefined;
    this.gameKnown = new Promise(resolve => { this.resolveGame = resolve; });
    ctl.onmessage = ({ data }) => this.onMessage(data);
  }

  onMessage(m) {
    switch (m?.t) {
      case 'state':
        this.ext.state = m.state;
        for (const cb of this.ext.listeners) { try { cb(m.state); } catch { /* erro do lobby não derruba a extensão */ } }
        break;
      case 'game': this.game = m.game; this.resolveGame(m.game); break;
      case 'result': {
        const p = this.calls.get(m.id);
        if (!p) break;
        this.calls.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
        break;
      }
      case 'echo': this.echoes.get(m.seq)?.(m); break;
    }
  }

  call(fn, args = []) {
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.ctl.postMessage({ t: 'call', id, fn, args });
    });
  }

  async copyInvite() {
    const link = await this.call('copyInvite');
    if (link) { try { await navigator.clipboard.writeText(link); } catch { /* sem foco/permissão: o lobby mostra o link */ } }
    return link;
  }

  mountLobby() {
    const go = () => import(this.base + 'lobby/lobby.mjs')
      .then(m => m.mountLobby({ api: globalThis.__bo1zLobby, document, location }))
      .catch(error => log(`lobby indisponível: ${error.message}`));
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', go, { once: true }); else go();
  }

  // Papel desta aba na partida, conferido com o mapa da página na hora em que o motor sobe.
  async role() {
    const game = await Promise.race([this.gameKnown, new Promise(r => setTimeout(r, GAME_WAIT_MS, null))]) ?? this.game;
    if (!game?.role || !game.map) return { role: null, game: null };
    const zone = document.documentElement?.dataset.map, slug = location.pathname.replace(/\/$/, '').split('/').pop();
    if (zone ? zone !== game.map.zone : slug !== game.map.slug) return { role: null, game: null };
    return { role: game.role, game };
  }

  report(code, message) {
    log(`erro ${message}`);
    this.ctl.postMessage({ t: 'coop-error', code, message });
  }

  // WebAssembly.instantiate(Streaming) do glue do motor (content-main.js). Devolve { module, instance: { exports } }.
  async instantiate({ kind, source, imports }) {
    const { instantiate, instantiateStreaming } = this.ext.native;
    const timings = this.ext.timings = { instantiate: performance.now() };
    const plain = s => instantiate.call(WebAssembly, s, imports);
    let { role, game } = await this.role();
    timings.role = performance.now();
    let result, layout = null, page = null;
    const scanner = () => import(this.base + 'coop/wasmscan.mjs').then(m => m.scanWasm);
    if (role) page = import(this.base + 'coop/page.mjs').catch(error => ({ error }));

    if (role === 'guest') {
      // G1 só com o wasm conhecido; sem ele o convidado não entra (sobe solo e o lobby mostra o motivo)
      const bytes = kind === 'streaming' ? new Uint8Array(await (await source).arrayBuffer()) : asBytes(source);
      const [scanWasm, { patchGuestWasm }, sha] = await Promise.all([scanner(), import(this.base + 'coop/wasmpatch.mjs'),
        sha256Hex(bytes)]);
      const prep = prepareGuestWasm({ bytes, sha, patchGuestWasm });
      if (prep.ok) layout = { ...scanWasm(bytes), sha, source: 'extensão' };
      if (!prep.ok || !layout.ok) {
        this.report('engine', prep.ok ? `layout dos rings: ${layout.reason}` : prep.reason);
        role = null;
        result = await plain(bytes);
      } else {
        log(`wasm do convidado: ${prep.applied.join(', ')} (sha256 ${sha.slice(0, 16)}…)`);
        result = await plain(prep.buf);
      }
    } else if (role === 'host') {
      // streaming continua (compila enquanto baixa); uma cópia dos bytes vai para o scanner em paralelo
      let scan;
      if (kind === 'streaming') {
        const response = await source;
        const copy = response.clone();
        scan = Promise.all([copy.arrayBuffer(), scanner()])
          .then(([buf, scanWasm]) => this.scan(scanWasm, new Uint8Array(buf)));
        result = await instantiateStreaming.call(WebAssembly, response, imports);
      } else {
        scan = scanner().then(scanWasm => this.scan(scanWasm, asBytes(source)));
        result = await plain(source);
      }
      layout = await scan;
      if (!layout.ok) { this.report('engine', `layout dos rings: ${layout.reason}`); role = null; }
    } else {
      result = kind === 'streaming' ? await instantiateStreaming.call(WebAssembly, source, imports) : await plain(source);
    }

    const memory = imports.env.memory, raw = result.instance.exports;
    const exports = wrapExports(raw, {
      memory, log,
      onRuntime: () => {
        timings.kb = performance.now();
        const module = { _KB_Input: raw.KB_Input, _malloc: raw.malloc, _free: raw.free, wasmExports: raw,
          wasmModule: result.module };
        globalThis.__bo1zKB = { memory, malloc: raw.malloc, free: raw.free, module };
        globalThis.dispatchEvent(new Event('bo1z:kb'));
      },
      rewrite: role ? args => {
        const r = coopArgs(args, { role, name: game.name });
        log(`argumentos do motor (${r.applied.join(', ')}): ${r.args.join(' ')}`);
        if (globalThis.five) globalThis.five.arguments = r.args;
        return r.args;
      } : null,
    });
    if (role) {
      this.bootCoop(role, layout, await page);
      if (role === 'guest') this.noQuit();
    }
    timings.instantiated = performance.now();
    this.engineRole = role;
    return { module: result.module, instance: { exports } };
  }

  async scan(scanWasm, bytes) {
    const t0 = performance.now(), layout = { ...scanWasm(bytes), sha: await sha256Hex(bytes), source: 'extensão' };
    log(`wasm sha256 ${layout.sha.slice(0, 16)}… analisado em ${Math.round(performance.now() - t0)} ms: ` +
      (layout.ok ? `rings em ${layout.layout.base}, ${layout.producers} produtores` : `co-op desligado: ${layout.reason}`));
    return layout;
  }

  // Liga a ponte assim que o runtime do motor sobe (page.mjs espera o 'bo1z:kb'); o port de pacotes vai para o mundo
  // isolado, que o leva ao offscreen.
  async bootCoop(role, layout, { boot, error }) {
    if (!boot) { this.report('bridge', `app/coop/page.mjs não carregou: ${error?.message}`); return; }
    const channel = new MessageChannel();
    this.ctl.postMessage({ t: 'pkt-port' }, [channel.port2]);
    const restore = bridgeWorkerOverride(this.base);
    this.layout = layout;
    try {
      await boot({ role, portPromise: Promise.resolve(channel.port1), getLayout: async () => layout, worker: true });
      if (this.ext.timings) this.ext.timings.bridge = performance.now();
      this.ctl.postMessage({ t: 'active', role });
    } catch (error) {
      this.report('bridge', `ponte não subiu: ${error.message}`);
    } finally { restore(); }
  }

  // No convidado a página não sai sozinha no PLATFORM_DISCONNECTED_FROM_SERVER (troca de servidor na estratégia shadow):
  // o mesmo efeito do patch "noquit" do app no engine.js, aqui embrulhando o onQuit do play.js.
  noQuit() {
    const five = globalThis.five;
    if (!five || five.__bo1zNoQuit) return;
    const original = five.onQuit;
    Object.defineProperty(five, '__bo1zNoQuit', { value: true });
    five.onQuit = function onQuit(how) {
      if (how === 'disconnect') {
        delete five.quit;
        log('noquit: PLATFORM_DISCONNECTED_FROM_SERVER ignorado no convidado');
        return;
      }
      return original?.call(this, how);
    };
  }

  // Ida e volta página -> mundo isolado -> offscreen -> página (o caminho dos pacotes, sem o Worker da ponte).
  async measureRtt({ n = 300, size = 300, enc = 'b64' } = {}) {
    const times = [];
    for (let i = 0; i < n; ++i) {
      const b = new Uint8Array(size);
      for (let j = 0; j < size; ++j) b[j] = (i * 31 + j * 7) & 255;
      const seq = ++this.seq, t0 = performance.now();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.echoes.delete(seq); reject(new Error('eco sem resposta')); }, 3000);
        this.echoes.set(seq, m => { clearTimeout(timer); this.echoes.delete(seq); resolve(m); });
        this.ctl.postMessage({ t: 'echo', seq, e: enc, b }, [b.buffer]);
      });
      times.push(performance.now() - t0);
    }
    return { enc, size, ...percentiles(times) };
  }
}

export function start(ext, ctx) {
  const world = new PageWorld(ext, ctx);
  world.mountLobby();
  return {
    call: (fn, args) => world.call(fn, args),
    copyInvite: () => world.copyInvite(),
    instantiate: opts => world.instantiate(opts),
    measureRtt: opts => world.measureRtt(opts),
    get game() { return world.game; },
    get role() { return world.engineRole ?? null; },
    get layout() { return world.layout ?? null; },
  };
}
