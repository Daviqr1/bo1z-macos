// Preload da janela oculta "net" (COOP-ARCH §4). Expõe ao mundo da página só o necessário:
//   __bo1zNet.start(onCommand)  registra quem recebe os comandos do main (bo1z:net-cmd) e libera o que chegou antes
//   __bo1zNet.state(state)      manda o estado da rede ao main (bo1z:net-state)
// Os MessagePorts de pacotes (bo1z:net-port) passam para o mundo da página por window.postMessage com transferência,
// como o app/preload.js faz com o port da página do jogo. Comandos e ports que chegam antes do net.mjs ligar ficam
// guardados aqui (o IPC pode chegar antes de o módulo da página rodar).
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let onCommand = null;
const pendingCommands = [], pendingPorts = [];
const postPorts = ports => window.postMessage({ bo1zNetPort: true }, '*', ports);

ipcRenderer.on('bo1z:net-cmd', (_event, message) => {
  if (!message || typeof message.cmd !== 'string') return;
  const command = { cmd: message.cmd, args: message.args ?? null };
  if (onCommand) onCommand(command); else pendingCommands.push(command);
});

ipcRenderer.on('bo1z:net-port', event => {
  if (!event.ports?.length) return;
  if (onCommand) postPorts(event.ports); else pendingPorts.push(event.ports);
});

contextBridge.exposeInMainWorld('__bo1zNet', {
  start(callback) {
    if (onCommand || typeof callback !== 'function') return;
    onCommand = callback;
    for (const ports of pendingPorts.splice(0)) postPorts(ports);
    for (const command of pendingCommands.splice(0)) onCommand(command);
  },
  state(state) { ipcRenderer.send('bo1z:net-state', state); },
});
