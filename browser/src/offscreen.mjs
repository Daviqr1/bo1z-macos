// Documento offscreen da extensão (chrome.offscreen, motivo WEB_RTC): vive enquanto o navegador estiver aberto, então a
// sala e a conexão WebRTC sobrevivem à troca tela inicial -> mapa (cada uma é uma navegação da aba). Roda a NetSession
// da janela net do app (app/net/session.mjs, copiada para net/ no build) e a sessão da extensão (lib/session.mjs);
// as abas e o popup conversam com ele por chrome.runtime.Port (lib/hub.mjs). Só chrome.runtime existe aqui.
import { ExtSession } from './lib/session.mjs';
import { Hub, PORT_NAMES } from './lib/hub.mjs';

const log = line => console.log(`BO1Z_EXT ${line}`);

// Ports que chegam enquanto o módulo da rede carrega: guarda as mensagens para não perder o hello.
let hub = null;
const early = [];
chrome.runtime.onConnect.addListener(port => {
  if (!PORT_NAMES.has(port.name)) return;
  if (hub) { hub.connect(port); return; }
  const buffer = [], keep = m => buffer.push(m);
  port.onMessage.addListener(keep);
  early.push({ port, buffer, keep });
});

let NetSession = null;
try { ({ NetSession } = await import('./net/session.mjs')); }
catch (error) { log(`rede indisponível (app/net não veio no build): ${error.message}`); }

const session = new ExtSession({ log });
if (NetSession) {
  session.net = new NetSession({ WebSocket, RTCPeerConnection, log: line => log(`net ${line}`),
    onState: state => session.onNetState(state) });
  addEventListener('pagehide', () => session.net.close?.());
}
const openTab = async url => (await chrome.runtime.sendMessage({ to: 'sw', t: 'open', url }))?.tabId ?? null;
hub = new Hub({ session, net: session.net, log, openTab });
for (const { port, buffer, keep } of early.splice(0)) { port.onMessage.removeListener(keep); hub.connect(port, buffer); }
globalThis.__bo1zExtSession = session; // depuração e testes (DevTools do offscreen)
globalThis.__bo1zExtHub = hub;
log(`offscreen pronto (rede: ${NetSession ? 'WebRTC' : 'ausente'})`);
