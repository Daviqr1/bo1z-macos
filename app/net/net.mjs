// Ponto de entrada da janela net: liga o preload (comandos/estado/ports do main) à NetSession com as APIs reais do
// Chromium (WebSocket, RTCPeerConnection). Logs vão para o console com o prefixo BO1Z_NET (o main pode gravá-los
// pelo evento console-message, como faz com BO1Z_COOP).
import { NetSession } from './session.mjs';

const api = globalThis.__bo1zNet;
const log = line => console.log(`BO1Z_NET ${line}`);

const session = new NetSession({
  WebSocket: globalThis.WebSocket,
  RTCPeerConnection: globalThis.RTCPeerConnection,
  log,
  onState: state => api?.state(state),
});
globalThis.__bo1zNetSession = session; // depuração (DevTools) e teste de ponta a ponta

// Ports de pacotes das páginas do jogo (o preload repassa por window.postMessage com transferência).
addEventListener('message', event => {
  if (event.source !== window || !event.data?.bo1zNetPort || !event.ports[0]) return;
  session.attachPort(event.ports[0]);
});
// Janela fechando (app saindo): sai da sala de verdade, para o host não esperar o par cair por tempo.
addEventListener('pagehide', () => session.close());

if (api) api.start(({ cmd, args }) => session.command(cmd, args));
else log('sem preload (__bo1zNet): abra esta página pela janela net do app');
