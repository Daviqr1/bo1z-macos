// Co-op do BO1 Zombies no navegador: content script no mundo isolado da aba do vel.gg (document_start). Tira o
// convite (#bo1z-join=…) da barra de endereço na hora e carrega lib/isolated.mjs, que liga a aba ao documento
// offscreen da extensão (sala, rede, pacotes do motor).
(() => {
  'use strict';
  if (window.top !== window) return;
  const hash = location.hash;
  if (/^#bo1z-join=/.test(hash)) history.replaceState(history.state, '', location.pathname + location.search);
  import(chrome.runtime.getURL('lib/isolated.mjs'))
    .then(m => m.start({ chrome, inviteHash: hash }))
    .catch(error => console.warn(`BO1Z_EXT co-op indisponível: ${error.message}`));
})();
