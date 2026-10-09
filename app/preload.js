// Roda no mundo da página antes dos scripts do vel.gg. O engine.js deles só repassa __kisakParity.commands
// ao motor quando __headlessInput está ligado (fora isso, __headlessInput só marca um campo da telemetria).
// Os comandos são escolhidos pelo mapa da página (<html data-map>), lido na hora em que o motor sobe.
const { contextBridge, ipcRenderer } = require('electron');

const { commands, volume, renderScale, muted } = ipcRenderer.sendSync('bo1z:config');

// Telemetria leve: o mundo da página manda um resumo de frames a cada 10 s; o main grava em logs/perf.jsonl.
contextBridge.exposeInMainWorld('__bo1zPerf', { report: summary => ipcRenderer.send('bo1z:perf', summary) });

contextBridge.executeInMainWorld({
  func: (perMap, volume, renderScale, muted) => {
    // Resolução de render: o canvas.js do site usa min(devicePixelRatio, 1920/largura, 1440/altura) uma vez, antes
    // de entregar o canvas ao motor. Trocar o DPR visto pela página muda a resolução do jogo inteiro.
    if (renderScale > 0) Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, get: () => renderScale });
    // Volume inicial: o play.js só respeita um volume salvo com volumeChosen (o slider de Options grava isso).
    // Mapas onde o jogador já escolheu o volume ficam como estão.
    for (const slug of ['five', 'kino', 'riese', 'nacht', 'verruckt', 'shinonuma', 'ascension', 'cotd', 'shangrila', 'moon']) {
      try {
        const key = slug + '-settings', saved = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (saved?.volumeChosen !== true) localStorage.setItem(key, JSON.stringify({ ...saved, volume, volumeChosen: true }));
      } catch { /* sem localStorage: fica o padrão do site */ }
    }
    const currentMap = () => document.documentElement?.dataset.map ?? new URLSearchParams(location.search).get('map');
    Object.defineProperty(globalThis, '__headlessInput', { value: true, configurable: true });
    Object.defineProperty(globalThis, '__kisakParity', { configurable: true,
      get: () => ({ commands: [...(perMap['*'] ?? []), ...(perMap[currentMap()] ?? [])] }) });
    if (muted) globalThis.__kisakMuted = true;
    globalThis.__bo1zInputTap = []; // glue patcheado (I1) empurra cada _KB_Input aqui; o gravador drena

    // Lê o anel de presents do motor (o mesmo do overlay ?perf=1 do site, com cursor próprio): sem chamada ao wasm.
    let engine = null, reader = null, frames = [], hitches = [];
    setInterval(() => {
      const current = globalThis.five?.engine;
      if (current !== engine) { engine = current; reader = current?.presentReader?.() ?? null; }
      let batch = null;
      try { batch = reader?.(); } catch { batch = null; } // motor parado: só não amostra
      if (!batch) return;
      batch.intervals.forEach((ms, i) => { frames.push(ms); if (ms > 50) hitches.push([Math.round(batch.times[i]), Math.round(ms)]); });
    }, 1000);
    setInterval(() => {
      if (!frames.length) return;
      const sorted = Float64Array.from(frames).sort(), q = p => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
      globalThis.__bo1zPerf.report({ t: Date.now(), map: currentMap(), screen: document.body?.dataset.screen ?? null,
        frames: sorted.length, fps: +(sorted.length / 10).toFixed(1), p50: q(.5), p95: q(.95), p99: q(.99), max: q(1),
        over33: frames.filter(ms => ms > 33).length, hitches });
      frames = []; hitches = [];
    }, 10000);
  },
  args: [commands, volume, renderScale, muted],
});
