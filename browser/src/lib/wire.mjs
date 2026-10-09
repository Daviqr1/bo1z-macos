// Pacotes do motor entre o content script (mundo isolado da aba do vel.gg) e o documento offscreen da extensão.
// O chrome.runtime.Port só leva JSON: um Uint8Array viraria {"0":..,"1":..}. Medido no Chromium 141 (ida e volta
// página -> offscreen -> página, 300 voltas, docs em browser/README.md): base64 e "latin1" (um char por byte) ficam
// iguais até 1264 B, e o array de números é o mais caro nos pacotes grandes. Fica base64: tamanho previsível (4/3),
// sem escapes no JSON e nativo no Chrome 140+ (Uint8Array.toBase64/fromBase64); antes disso, btoa/atob.
//
// No Port: pacote { t:'p', i?, b, e? } (i = id do convidado no host; e = codificação quando não é base64, só nos
// testes de medida) e as demais mensagens do protocolo §1 (join/leave/net/ready/full) como { t:'m', m }.

export const MAX_PACKET = 1264; // COOP-ARCH §1

const nativeB64 = typeof Uint8Array.prototype.toBase64 === 'function' && typeof Uint8Array.fromBase64 === 'function';

export function toBase64(bytes, native = nativeB64) {
  if (native) return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text, native = nativeB64) {
  if (native) return Uint8Array.fromBase64(text);
  const bin = atob(text), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) out[i] = bin.charCodeAt(i);
  return out;
}

// Codificações comparadas na medida (tools/ext-smoke.mjs). Só 'b64' circula no jogo.
export const ENCODINGS = {
  b64: { encode: b => toBase64(b), decode: s => typeof s === 'string' ? fromBase64(s) : null },
  latin1: {
    encode: b => String.fromCharCode.apply(null, b),
    decode: s => {
      if (typeof s !== 'string') return null;
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; ++i) out[i] = s.charCodeAt(i);
      return out;
    },
  },
  arr: { encode: b => Array.from(b), decode: a => Array.isArray(a) ? Uint8Array.from(a) : null },
};

// Mensagem do protocolo §1 -> valor que o Port aceita.
export function packMsg(m, enc = 'b64') {
  if (m?.t === 'pkt' && m.b instanceof Uint8Array) {
    const w = { t: 'p', b: ENCODINGS[enc].encode(m.b) };
    if (m.id !== undefined && m.id !== null) w.i = m.id;
    if (enc !== 'b64') w.e = enc;
    return w;
  }
  return { t: 'm', m };
}

// Valor do Port -> mensagem do protocolo §1 (null = descarta: pacote malformado ou grande demais).
export function unpackMsg(w) {
  if (w?.t === 'p') {
    const codec = ENCODINGS[w.e ?? 'b64'];
    if (!codec) return null;
    let b;
    try { b = codec.decode(w.b); } catch { return null; }
    if (!b || !b.length || b.length > MAX_PACKET) return null;
    return w.i !== undefined ? { t: 'pkt', id: String(w.i), b } : { t: 'pkt', b };
  }
  if (w?.t === 'm' && w.m && typeof w.m === 'object' && typeof w.m.t === 'string') return w.m;
  return null;
}

// Percentis de uma lista de tempos (ms), para os relatórios de latência.
export function percentiles(times, ps = [0.5, 0.99]) {
  const sorted = Float64Array.from(times).sort();
  const at = p => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3) : null;
  return Object.fromEntries(ps.map(p => [`p${Math.round(p * 100)}`, at(p)]).concat([['max', at(1)], ['n', sorted.length]]));
}
