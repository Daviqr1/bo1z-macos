// Service worker da extensão: cria o documento offscreen (onde ficam a sala e o WebRTC) sob demanda e abre uma aba do
// mapa quando o host inicia e a aba da sala já foi fechada. Sem estado: o Chrome desliga o service worker quando quer.

const OFFSCREEN = 'offscreen.html';
let creating = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }
  return chrome.offscreen.hasDocument();
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return false;
  creating ??= chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ['WEB_RTC'],
    justification: 'Conexão WebRTC do co-op que precisa continuar enquanto a aba do jogo troca de página.' })
    .finally(() => { creating = null; });
  await creating;
  return true;
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.to !== 'sw') return false;
  const fail = e => reply({ ok: false, error: e.message });
  if (m.t === 'ensure') ensureOffscreen().then(created => reply({ ok: true, created }), fail);
  else if (m.t === 'open' && /^https:\/\/vel\.gg\/bo1z\//.test(String(m.url)))
    chrome.tabs.create({ url: m.url }).then(tab => reply({ ok: true, tabId: tab.id }), fail);
  else return false;
  return true;
});

// Primeira instalação: abre as opções (nome do jogador e servidor de convite).
chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.runtime.openOptionsPage(); });
