// Janela net vista do processo principal (para o main.js usar; o teste de ponta a ponta usa a mesma coisa):
// cria a janela oculta com o preload certo, entrega comandos e ports de pacotes e repassa o estado (COOP-ARCH §4).
//
//   const { applyNetSwitches, createNetWindow } = require('./net/net-window.js');
//   applyNetSwitches(app);                                   // antes do app.whenReady()
//   const net = createNetWindow({ onState: s => ..., onLog: line => ... });   // depois do whenReady
//   net.command('config', { signalUrl, name }); net.command('create', { name, map });
//   ipcMain.on('bo1z:coop-hello', e => { const { port1, port2 } = new MessageChannelMain();
//     e.sender.postMessage('bo1z:coop-port', null, [port1]); net.attachPort(port2); });
//
// Comandos e ports pedidos antes de a página net ligar ficam na fila até o primeiro bo1z:net-state dela.
'use strict';
const path = require('node:path');

// Chaves do Chromium para a rede (antes do app.whenReady()). Sem o mDNS nos candidatos "host" (IP local de verdade
// no lugar de um nome .local): dois jogadores na mesma casa conectam direto mesmo em rede que bloqueia multicast, em
// vez de cair no relay. O IP local só vai para o servidor de salas e para o outro jogador.
function applyNetSwitches(app) {
  const current = app.commandLine.getSwitchValue('disable-features');
  const features = new Set(current ? current.split(',') : []);
  features.add('WebRtcHideLocalIpsWithMdns');
  app.commandLine.appendSwitch('disable-features', [...features].join(','));
}

function createNetWindow({ onState = () => {}, onLog = null, show = false } = {}) {
  const { BrowserWindow, ipcMain } = require('electron');
  const win = new BrowserWindow({
    show, width: 480, height: 320, title: 'BO1 Zombies — rede', skipTaskbar: true, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'net-preload.js'),
      contextIsolation: true, sandbox: true, spellcheck: false,
      backgroundThrottling: false, // janela oculta: sem isso os timers (ping de 1 s, ICE restart) ficam lentos
    },
  });
  const contents = win.webContents;
  let ready = false, last = null;
  const queue = [];
  const whenReady = fn => { if (ready) fn(); else queue.push(fn); };

  const onStateIpc = (event, state) => {
    if (event.sender !== contents) return;
    last = state;
    if (!ready) { ready = true; for (const fn of queue.splice(0)) fn(); }
    onState(state);
  };
  ipcMain.on('bo1z:net-state', onStateIpc);
  win.on('closed', () => ipcMain.off('bo1z:net-state', onStateIpc));
  if (onLog) contents.on('console-message', ({ message }) => {
    if (message.startsWith('BO1Z_NET ')) onLog(message.slice(9));
  });
  // Processo da janela caiu: recarrega (a sala se perde; o main vê phase 'idle' no próximo estado e pode reentrar).
  contents.on('render-process-gone', (_event, details) => {
    onLog?.(`janela net caiu (${details.reason}); recarregando`);
    ready = false;
    if (!win.isDestroyed()) contents.reload();
  });
  win.loadFile(path.join(__dirname, 'net.html'));

  return {
    win,
    get state() { return last; },
    get ready() { return ready; },
    command(cmd, args = null) {
      whenReady(() => { if (!win.isDestroyed()) contents.send('bo1z:net-cmd', { cmd, args }); });
    },
    attachPort(port) {
      whenReady(() => { if (!win.isDestroyed()) contents.postMessage('bo1z:net-port', null, [port]); });
    },
    // close: a página sai da sala (pagehide -> leave). destroy: sem aviso (como um travamento).
    close() { if (!win.isDestroyed()) win.close(); },
    destroy() { if (!win.isDestroyed()) win.destroy(); },
  };
}

module.exports = { applyNetSwitches, createNetWindow };
