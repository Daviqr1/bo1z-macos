// Ponte do co-op num Worker dedicado: drena os rings a cada ~1 ms (Atomics.waitAsync, sem o piso de 4 ms dos timers
// aninhados da página) e injeta cada pacote da rede assim que ele chega, sem depender da thread da página (que pode
// travar dezenas de ms com o jogo). Recebe da página: { t:'start', buffer, layout, role, rings, port } — os rings do
// host já foram reservados lá (malloc é do Module, na thread da página); aqui só são abertos pelo k.
import { startCoop } from './page.mjs';

let coop = null;
self.onmessage = ({ data: m }) => {
  if (m?.t !== 'start' || coop) return;
  const log = line => self.postMessage({ t: 'log', line });
  const kb = { memory: { buffer: m.buffer }, malloc: null, free: null };
  try {
    coop = startCoop({ role: m.role, port: m.port, layout: m.layout, kb, log, rings: m.rings, schedule: 'wait' });
    self.postMessage({ t: 'started' });
    // estatísticas para a página (o lobby mostra) a cada 1 s
    setInterval(() => self.postMessage({ t: 'stats', stats: coop.stats() }), 1000);
  } catch (error) {
    self.postMessage({ t: 'error', message: error.message });
  }
};
