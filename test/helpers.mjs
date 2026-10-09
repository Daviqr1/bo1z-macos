// Utilitários dos testes: memória pequena com o mesmo layout de slots/rings do motor (base baixa) e pacotes que se
// autovalidam (produtor, sequência, crc32), para detectar mistura/perda/repetição.
import { DEFAULT_LAYOUT } from '../app/coop/layout.mjs';

export const TEST_LAYOUT = Object.freeze({ ...DEFAULT_LAYOUT, base: 4096, memoryBytes: 8 << 20 });

export function makeMemory(layout = TEST_LAYOUT) {
  return new SharedArrayBuffer(layout.memoryBytes);
}

// malloc de mentira (bump) sobre a memória de teste, começando depois dos rings 0 e 1.
export function bumpAllocator(layout = TEST_LAYOUT, start = layout.base + 2 * layout.stride + 4000) {
  let top = start;
  const freed = [];
  return {
    malloc: size => { const p = (top + 15) & ~15; top = p + size; return p; },
    free: p => freed.push(p),
    freed,
  };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; ++n) { let c = n; for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();

export function crc32(bytes, from = 0, to = bytes.length) {
  let c = -1;
  for (let i = from; i < to; ++i) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Pacote de teste: [u32 seq][u8 produtor][u8 0][u16 len][u32 crc dos bytes 12..len][payload pseudoaleatório].
// Os 4 primeiros bytes fazem papel da sequência do netchan (únicos por pacote).
export function makePacket(producer, seq, len) {
  const b = new Uint8Array(Math.max(12, len));
  const v = new DataView(b.buffer);
  v.setUint32(0, seq, true); b[4] = producer; v.setUint16(6, b.length, true);
  let x = (seq * 2654435761 + producer * 40503) >>> 0;
  for (let i = 12; i < b.length; ++i) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; }
  v.setUint32(8, crc32(b, 12), true);
  return b;
}

// { ok, producer, seq } — ok=false se o pacote veio misturado/cortado.
export function checkPacket(bytes) {
  if (bytes.length < 12) return { ok: false };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = v.getUint16(6, true);
  if (len !== bytes.length) return { ok: false };
  return { ok: v.getUint32(8, true) === crc32(bytes, 12), producer: bytes[4], seq: v.getUint32(0, true) };
}
