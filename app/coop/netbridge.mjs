// F1: ponte JS entre os rings de loopback do motor e a rede (Plano A da spec, sem patch no wasm).
//
// Host (roda o servidor do jogo):
//   openHostRing()          reserva no heap do wasm um ring extra para um convidado e devolve o índice k (2..65535).
//                           O servidor responde para loopbacks[from.port & 0xffff], e from.port vem do tag que a ponte
//                           grava no slot: pacote do convidado entra no ring 1 com tag k => respostas caem no ring k.
//   injectToServer(bytes,k) pacote do convidado -> S.loopbacks[1] com tag k (2 produtores: o cliente local do host e a
//                           ponte; ver ring.mjs/publish e o contador `clobbered`).
//   drainRing(k, cb)        pacotes do servidor para o convidado k (só a ponte lê esse ring).
// Convidado (sem servidor local; `connect localhost`):
//   injectToClient(bytes)   pacote do host -> C.loopbacks[0] (caixa de entrada do cliente; produtor único), com tag =
//                           layout.clientServerPort: o cliente compara a porta do remetente com a do "localhost".
//   drainClientOut(cb)      pacotes do cliente -> leitor passivo do C.loopbacks[1] (o motor pode drenar esse ring
//                           sozinho quando não há servidor; o cursor da ponte é independente).
import { DEFAULT_LAYOUT, MAX_RING, RING_CLIENT, RING_SERVER } from './layout.mjs';
import { RingIO } from './ring.mjs';

export const OOB_MARKER = -1; // pacote sem conexão começa com int32 -1 ("\xff\xff\xff\xff")

export function isOOB(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xff && bytes[2] === 0xff && bytes[3] === 0xff;
}

// Texto de um pacote sem conexão (ex.: "getchallenge", "connect ..."), para log. null se não for OOB.
export function oobText(bytes, max = 64) {
  if (!isOOB(bytes)) return null;
  let s = '';
  for (let i = 4; i < bytes.length && s.length < max; ++i) s += bytes[i] >= 32 && bytes[i] < 127 ? String.fromCharCode(bytes[i]) : '.';
  return s;
}

// qport de um pacote sequenciado cliente->servidor (u16 LE logo depois da sequência de 4 bytes), ou null.
export function clientQport(bytes) {
  if (bytes.length < 6 || isOOB(bytes)) return null;
  return bytes[4] | (bytes[5] << 8);
}

export function createNetBridge({ buffer, layout = DEFAULT_LAYOUT, malloc = null, free = null, log = () => {} }) {
  const io = new RingIO(buffer, layout);
  const L = io.layout;
  const serverRing = io.addr(RING_SERVER), clientRing = io.addr(RING_CLIENT);
  const hostRings = new Map(); // k -> { ring, ptr, reader }
  const recent = []; // publicações recentes no ring 1 do host, para detectar clobber pelo motor
  const stats = { injectedToServer: 0, casRetries: 0, injectFailed: 0, clobbered: 0, phantom: 0, drainedForGuests: 0,
    injectedToClient: 0, drainedFromClient: 0, oversize: 0, queued: 0, dropped: 0, localOnly: 0 };
  // Criado já com a ponte (antes do main do motor, no N1): o convidado não perde o getchallenge do começo.
  const clientReader = io.reader(io.addr(RING_SERVER), { fromNow: true });

  // Reserva um bloco de 2*stride no heap: qualquer bloco desse tamanho contém uma janela [base+k*stride, +stride).
  // O servidor só endereça k <= 0xffff, então o bloco precisa estar abaixo de base + 65536*stride (~1,47 GB). O heap
  // passa disso no fim de um mapa carregado (wasmBreak chega a ~1,77 GB): reserve os rings ANTES de subir o mapa.
  function allocRing() {
    if (!malloc) throw new Error('openHostRing: sem malloc (glue sem o patch N1?)');
    const size = 2 * L.stride, rejected = [];
    try {
      for (let attempt = 0; attempt < 4; ++attempt) {
        const ptr = malloc(size) >>> 0;
        if (!ptr) break;
        const k = Math.ceil((ptr - L.base) / L.stride), ring = L.base + k * L.stride;
        if (k >= 2 && k <= MAX_RING && !hostRings.has(k) && ring >= ptr && ring + L.stride <= ptr + size)
          return { k, ring, ptr };
        rejected.push(ptr);
      }
    } finally {
      for (const ptr of rejected) free?.(ptr);
    }
    throw new Error(`openHostRing: heap fora do alcance do servidor (k > ${MAX_RING}); abra a sala antes de carregar o mapa`);
  }

  function openHostRing(k) {
    let entry;
    if (k === undefined) entry = allocRing();
    else {
      // k explícito: só para testes/ferramentas que já reservaram a memória do ring.
      if (!(k >= 2 && k <= MAX_RING) || hostRings.has(k)) throw new RangeError(`openHostRing: k inválido ${k}`);
      entry = { k, ring: io.addr(k), ptr: 0 };
    }
    if (entry.ring + L.stride > io.u8.length) throw new RangeError('openHostRing: ring fora da memória');
    io.clear(entry.ring);
    entry.reader = io.reader(entry.ring, { fromNow: false });
    hostRings.set(entry.k, entry);
    log('ring', `k=${entry.k} em ${entry.ring} (bloco ${entry.ptr})`);
    return entry.k;
  }

  // Fecha o ring k. A memória só é liberada com freeMemory=true: um pacote do convidado ainda no ring 1 com tag k
  // faria o servidor escrever no ring k depois do free. Sem convidado conectado nesse k, é seguro liberar.
  function closeHostRing(k, { freeMemory = false } = {}) {
    const entry = hostRings.get(k);
    if (!entry) return false;
    hostRings.delete(k);
    if (freeMemory && entry.ptr) free?.(entry.ptr);
    return true;
  }

  // Contrapressão: o motor sobrescreve o slot mais velho quando o ring enche (e com send-get >= 17 lê o slot que o
  // produtor pode estar escrevendo). A ponte só publica com folga (send-get < ROOM); o resto espera na fila e sai no
  // pump(). ROOM deixa 2 slots para o produtor do motor (cliente local no ring 1 do host).
  const ROOM = L.slots - 2, QUEUE_MAX = 512;
  const serverQueue = [], clientQueue = [];
  const hasRoom = ring => ((io.loadSend(ring) - io.loadGet(ring)) >>> 0) < ROOM;
  function enqueue(queue, item) {
    queue.push(item);
    if (queue.length > QUEUE_MAX) { queue.shift(); ++stats.dropped; }
  }

  function publishToServer(bytes, k) {
    const r = io.publish(serverRing, bytes, k);
    stats.casRetries += r.retries;
    if (!r.ok) { ++stats.injectFailed; return false; }
    ++stats.injectedToServer;
    recent.push({ seq: r.seq, tag: k, len: bytes.length, next: r.next, clobberDone: false });
    if (recent.length > 64) checkClobbers();
    return true;
  }

  function injectToServer(bytes, k) {
    if (!hostRings.has(k)) throw new RangeError(`injectToServer: ring ${k} não aberto`);
    if (bytes.length > L.maxLen) { ++stats.oversize; return false; }
    if (!serverQueue.length && hasRoom(serverRing)) return publishToServer(bytes, k);
    enqueue(serverQueue, { bytes, k });
    ++stats.queued;
    return true;
  }

  // Corrida de 2 produtores no ring 1 do host. O motor lê `send` (load comum), copia e só então soma 1. Se ele leu
  // `send` = N antes do nosso CAS N->N+1 e terminou depois:
  //  - clobbered: escreveu por cima do nosso slot N (nosso pacote se perde; se a escrita cruzou com a nossa, o pacote
  //    dele pode sair misturado);
  //  - phantom:   a soma dele leva send a N+2 sem ninguém ter escrito o slot N+1, então o servidor lê o pacote velho
  //    que estava lá (de 16 publicações atrás) e o pacote do motor some (ficou no slot N, ou por baixo do nosso).
  // O netchan descarta sequência repetida e retransmite o confiável; os contadores medem a taxa (pergunta 2 da spec).
  function checkClobbers() {
    const send = io.loadSend(serverRing);
    let keep = 0;
    for (const p of recent) {
      const age = (send - p.seq) >>> 0;
      if (age >= L.slots) continue; // o slot já foi reciclado normalmente; não dá mais para saber
      if (!p.clobberDone && !io.stillOurs(serverRing, p.seq, p.tag, p.len)) { ++stats.clobbered; p.clobberDone = true; }
      if (age >= 2 && p.next) {
        if (io.sameSignature(serverRing, (p.seq + 1) >>> 0, p.next)) ++stats.phantom;
        p.next = null; // N+1 já foi publicado: ou foi reescrito (normal) ou é fantasma; não muda mais até N+17
      }
      if (age < 4 || p.next) recent[keep++] = p; // ainda pode ser atingido; confere de novo depois
    }
    recent.length = keep;
  }

  function drainRing(k, onPacket, max) {
    const entry = hostRings.get(k);
    if (!entry) throw new RangeError(`drainRing: ring ${k} não aberto`);
    const n = entry.reader.drain(bytes => onPacket(bytes), max);
    stats.drainedForGuests += n;
    return n;
  }

  const clientTag = L.clientServerPort ?? 0;
  function publishToClient(bytes) {
    const r = io.publish(clientRing, bytes, clientTag);
    stats.casRetries += r.retries;
    if (!r.ok) { ++stats.injectFailed; return false; }
    ++stats.injectedToClient;
    return true;
  }

  function injectToClient(bytes) {
    if (bytes.length > L.maxLen) { ++stats.oversize; return false; }
    if (!clientQueue.length && hasRoom(clientRing)) return publishToClient(bytes);
    enqueue(clientQueue, bytes);
    ++stats.queued;
    return true;
  }

  // Chamar com frequência (a cada poucos ms): esvazia as filas enquanto houver folga e confere clobbers.
  function pump() {
    while (serverQueue.length && hasRoom(serverRing)) {
      const { bytes, k } = serverQueue.shift();
      if (hostRings.has(k)) publishToServer(bytes, k);
    }
    while (clientQueue.length && hasRoom(clientRing)) publishToClient(clientQueue.shift());
    if (recent.length) checkClobbers();
    return serverQueue.length + clientQueue.length;
  }

  // armed=false: o cliente ainda fala com o servidor local (estratégia shadow); os pacotes são lidos e descartados.
  function drainClientOut(onPacket, max, armed = true) {
    const n = clientReader.drain(bytes => { if (armed) onPacket(bytes); else ++stats.localOnly; }, max);
    if (armed) stats.drainedFromClient += n;
    return n;
  }

  // Valor atual (int na +24) de um dvar conhecido pelo scanner; null se o scanner não achou ou ainda não registrado.
  function dvar(name) {
    const g = L.dvars?.[name];
    if (!g) return null;
    const d = Atomics.load(io.i32, g >> 2) >>> 0;
    return d ? Atomics.load(io.i32, (d + (L.dvarValueOff ?? 24)) >> 2) : null;
  }
  function setDvar(name, value) {
    const g = L.dvars?.[name];
    if (!g) return false;
    const d = Atomics.load(io.i32, g >> 2) >>> 0;
    if (!d) return false;
    Atomics.store(io.i32, (d + (L.dvarValueOff ?? 24)) >> 2, value);
    return true;
  }

  // Para onde o cliente local está conectado: { type, port } do serverAddress, ou null sem o ponteiro do scanner.
  function clientTarget() {
    if (!L.clientConnPtr) return null;
    const conn = Atomics.load(io.i32, L.clientConnPtr >> 2) >>> 0;
    if (!conn) return { type: 0, port: 0 };
    const a = conn + (L.serverAddressOff ?? 16);
    return { type: Atomics.load(io.i32, a >> 2), port: io.u8[a + 8] | (io.u8[a + 9] << 8) };
  }

  function snapshot() {
    checkClobbers();
    const readers = { client: { lost: clientReader.lost, torn: clientReader.torn, bad: clientReader.bad } };
    for (const [k, e] of hostRings) readers[k] = { lost: e.reader.lost, torn: e.reader.torn, bad: e.reader.bad };
    return { ...stats, readers, rings: [...hostRings.keys()], pending: serverQueue.length + clientQueue.length };
  }

  return { layout: L, io, openHostRing, closeHostRing, injectToServer, drainRing, injectToClient, drainClientOut, clientTarget, dvar, setDvar, pump,
    checkClobbers, stats: snapshot };
}
