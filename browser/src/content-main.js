// Co-op do BO1 Zombies no navegador: content script no mundo PRINCIPAL da aba do vel.gg (document_start, antes dos
// scripts do site). Script clássico e curto: o que precisa existir antes do site rodar fica aqui —
//  - #bo1z-start na URL (a extensão navegou para o mapa porque o host iniciou): início automático, como a escolha de
//    mapa da tela inicial (globalThis.__kisakLandingPick antes do play.js);
//  - window.__bo1zLobby (COOP-ARCH §3) para o lobby, com as chamadas esperando a extensão;
//  - gancho em WebAssembly.instantiateStreaming/instantiate: a instanciação do motor (memória importada compartilhada)
//    passa por lib/page-main.mjs (N1, G1, argumentos, ponte); qualquer outro wasm passa direto.
// O resto (lib/page-main.mjs e os módulos de app/coop) vem da própria extensão por import() quando o mundo isolado
// (content-isolated.js) entrega o port "ctl" e a URL base.
(() => {
  'use strict';
  if (window.top !== window || globalThis.__bo1zExt) return;
  const native = { instantiateStreaming: WebAssembly.instantiateStreaming, instantiate: WebAssembly.instantiate };
  const ext = globalThis.__bo1zExt = { native, listeners: new Set(), state: null };
  const warn = message => console.warn(`BO1Z_EXT ${message}`);

  if (/^#bo1z-start(&|$)/.test(location.hash)) {
    globalThis.__kisakLandingPick = true;
    history.replaceState(history.state, '', location.pathname + location.search);
  }

  // Contexto da extensão (o mundo isolado pode carregar antes ou depois deste script: quem chega depois puxa a conversa).
  let gotContext;
  ext.ctx = new Promise(resolve => { gotContext = resolve; });
  addEventListener('message', event => {
    if (event.source !== window || event.data?.bo1zExt !== 'iso' || ext.ctl) return;
    if (event.ports?.[0]) { ext.ctl = event.ports[0]; gotContext({ base: event.data.base, ctl: ext.ctl }); }
    else window.postMessage({ bo1zExt: 'main' }, '*');
  });
  window.postMessage({ bo1zExt: 'main' }, '*');
  ext.api = ext.ctx.then(ctx => import(ctx.base + 'lib/page-main.mjs').then(m => m.start(ext, ctx)));
  ext.api.catch(error => warn(`co-op não carregou: ${error.message}`));

  const call = (fn, ...args) => ext.api.then(api => api.call(fn, args));
  globalThis.__bo1zLobby = Object.freeze({
    getState: () => ext.state ? Promise.resolve(ext.state) : call('getState'),
    onState(cb) { ext.listeners.add(cb); return () => ext.listeners.delete(cb); },
    create: opts => call('create', opts),
    join: opts => call('join', opts),
    connectByAddress: opts => call('connectByAddress', opts),
    leave: () => call('leave'),
    setMap: zone => call('setMap', zone),
    setReady: ready => call('setReady', ready),
    start: () => call('start'),
    copyInvite: () => ext.api.then(api => api.copyInvite()),
  });

  // Motor: o glue importa a memória (compartilhada, 2 GiB) em env.memory; é o que o distingue de outros wasm.
  const isEngine = imports => {
    const memory = imports?.env?.memory;
    return memory instanceof WebAssembly.Memory && memory.buffer instanceof SharedArrayBuffer;
  };
  const hooked = (kind, source, imports) => {
    const late = new Promise(resolve => setTimeout(resolve, 10000, null));
    return Promise.race([ext.api, late]).catch(() => null).then(api => {
      if (api) return api.instantiate({ kind, source, imports });
      warn('extensão sem resposta: o motor sobe sem co-op');
      return kind === 'streaming' ? native.instantiateStreaming.call(WebAssembly, source, imports)
        : native.instantiate.call(WebAssembly, source, imports);
    });
  };
  WebAssembly.instantiateStreaming = function instantiateStreaming(source, imports, ...rest) {
    if (!isEngine(imports)) return native.instantiateStreaming.call(this, source, imports, ...rest);
    return hooked('streaming', source, imports);
  };
  WebAssembly.instantiate = function instantiate(source, imports, ...rest) {
    if (!isEngine(imports) || source instanceof WebAssembly.Module)
      return native.instantiate.call(this, source, imports, ...rest);
    return hooked('bytes', source, imports);
  };
})();
