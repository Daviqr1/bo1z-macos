// Acesso da ponte JS aos rings de loopback do motor, sobre a memória compartilhada do wasm (SharedArrayBuffer).
// Duas operações, ambas sem tocar no `get` do motor:
//  - publish(): produtor. Grava o slot `send & 15` e só então publica com compareExchange(send, s, s+1). Se o motor
//    publicou no meio (o CAS falha), tenta de novo no slot seguinte. Depois confere se o slot ainda é dele (clobber).
//  - Reader: leitor passivo com cursor próprio ("snoop"). O motor nunca vê esse cursor; serve tanto para um ring que
//    só a ponte lê (ring k no host) quanto para um ring que o motor também drena (ring 1 do convidado).
import { checkLayout, DEFAULT_LAYOUT, ringAddr } from './layout.mjs';

export class RingIO {
  constructor(buffer, layout = DEFAULT_LAYOUT) {
    this.layout = checkLayout(layout);
    this.u8 = new Uint8Array(buffer);
    this.i32 = new Int32Array(buffer);
  }

  addr(k) { return ringAddr(this.layout, k); }
  slotAddr(ring, seq) { return ring + (seq & (this.layout.slots - 1)) * this.layout.slotSize; }
  loadSend(ring) { return Atomics.load(this.i32, (ring + this.layout.sendOff) >> 2) >>> 0; }
  loadGet(ring) { return Atomics.load(this.i32, (ring + this.layout.getOff) >> 2) >>> 0; }

  // Zera um ring inteiro (só para rings que a ponte criou no heap).
  clear(ring) { this.u8.fill(0, ring, ring + this.layout.stride); }

  // Grava `bytes` (≤ maxLen) com `tag` no ring. Devolve { ok, seq, retries, next }, onde `next` é a assinatura do
  // slot seguinte tirada ANTES do CAS (ninguém escreve nele antes de send chegar a seq+1): se depois o motor publicar
  // seq+1 sem reescrever esse slot, foi a corrida do "send lido velho" (ver netbridge.mjs, `phantom`).
  publish(ring, bytes, tag, maxRetries = 8) {
    const { maxLen, lenOff, tagOff, sendOff } = this.layout;
    if (bytes.length > maxLen) throw new RangeError(`pacote de ${bytes.length} B (máximo ${maxLen})`);
    const sendIdx = (ring + sendOff) >> 2;
    for (let retries = 0; retries <= maxRetries; ++retries) {
      const s = Atomics.load(this.i32, sendIdx);
      const slot = this.slotAddr(ring, s);
      this.u8.set(bytes, slot);
      // Mesma ordem do motor (data, tag, len). Os stores atômicos e o CAS são seq-cst: quem vê send+1 vê o slot.
      Atomics.store(this.i32, (slot + tagOff) >> 2, tag);
      Atomics.store(this.i32, (slot + lenOff) >> 2, bytes.length);
      const next = this.signature(ring, (s + 1) >>> 0);
      if (Atomics.compareExchange(this.i32, sendIdx, s, (s + 1) | 0) === s) return { ok: true, seq: s >>> 0, retries, next };
    }
    return { ok: false, seq: -1, retries: maxRetries + 1, next: null };
  }

  // Assinatura barata de um slot: tag, len e os 8 primeiros bytes (sequência do netchan + qport/ack).
  signature(ring, seq) {
    const slot = this.slotAddr(ring, seq), i = slot >> 2, { lenOff, tagOff } = this.layout;
    return [Atomics.load(this.i32, (slot + tagOff) >> 2), Atomics.load(this.i32, (slot + lenOff) >> 2),
      Atomics.load(this.i32, i), Atomics.load(this.i32, i + 1)];
  }

  sameSignature(ring, seq, sig) {
    const now = this.signature(ring, seq);
    return now[0] === sig[0] && now[1] === sig[1] && now[2] === sig[2] && now[3] === sig[3];
  }

  // O slot `seq` ainda tem o que a ponte gravou? (falso = o motor sobrescreveu: corrida de 2 produtores)
  stillOurs(ring, seq, tag, len) {
    const slot = this.slotAddr(ring, seq);
    return Atomics.load(this.i32, (slot + this.layout.tagOff) >> 2) === tag
      && Atomics.load(this.i32, (slot + this.layout.lenOff) >> 2) === len;
  }

  reader(ring, { fromNow = true } = {}) { return new Reader(this, ring, fromNow); }
}

export class Reader {
  constructor(io, ring, fromNow) {
    this.io = io;
    this.ring = ring;
    this.cursor = fromNow ? io.loadSend(ring) : 0;
    this.lost = 0; // pacotes que o produtor sobrescreveu antes da leitura (atraso > 16)
    this.torn = 0; // pacotes descartados porque o produtor pode ter reescrito o slot durante a cópia
    this.bad = 0; // len fora de [0, maxLen]
  }

  // Lê tudo que foi publicado desde a última chamada. onPacket(bytes: Uint8Array (cópia), tag: number).
  drain(onPacket, max = Infinity) {
    const { u8, i32, layout } = this.io;
    const { slots, maxLen, lenOff, tagOff } = layout;
    let send = this.io.loadSend(this.ring), n = 0;
    let behind = (send - this.cursor) >>> 0;
    if (behind > 0x7fffffff) { this.cursor = send; behind = 0; } // contador voltou (ring zerado/reaberto)
    if (behind > slots) { this.lost += behind - slots; this.cursor = (send - slots) >>> 0; }
    while (this.cursor !== send && n < max) {
      const seq = this.cursor, slot = this.io.slotAddr(this.ring, seq);
      const len = Atomics.load(i32, (slot + lenOff) >> 2), tag = Atomics.load(i32, (slot + tagOff) >> 2);
      const bytes = len >= 0 && len <= maxLen ? u8.slice(slot, slot + len) : null;
      // O motor reescreve o slot de `seq` quando publica seq+16, e começa a escrever com send == seq+16.
      send = this.io.loadSend(this.ring);
      this.cursor = (seq + 1) >>> 0;
      if (((send - seq) >>> 0) >= slots) { ++this.torn; continue; }
      if (!bytes) { ++this.bad; continue; }
      onPacket(bytes, tag);
      ++n;
    }
    return n;
  }
}
