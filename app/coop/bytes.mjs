// Busca de bytes em Uint8Array (sem Buffer do Node): o scanner e o patcher do wasm rodam no main do Electron e também
// no navegador (extensão).
export const asBytes = input => input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength);

export function indexOfBytes(hay, needle, from = 0) {
  const first = needle[0], last = hay.length - needle.length;
  for (let i = hay.indexOf(first, from); i >= 0 && i <= last; i = hay.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) ++j;
    if (j === needle.length) return i;
  }
  return -1;
}

export const includesBytes = (hay, needle) => indexOfBytes(hay, needle) >= 0;
export const bytes = arr => Uint8Array.from(arr);
const utf8decoder = new TextDecoder();
export const utf8 = view => utf8decoder.decode(view);
const utf8encoder = new TextEncoder();
export const utf8Bytes = text => utf8encoder.encode(text);
