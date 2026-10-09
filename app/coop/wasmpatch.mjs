// Patches do wasm do CONVIDADO (Plano B da spec, só em memória, aplicados pelo main sobre o wasm baixado do vel.gg).
// Achados com o motor rodando (2026-10-09), estratégia shadow: o convidado sobe o mapa com servidor local (para o
// cgame deste motor achar zombiemode, árvores de animação e os dados que ele lê direto do servidor) e conecta no host.
//
// G1 CL_PacketEvent: pacotes sequenciados são aceitos se NET_CompareAdr(from, netchan.remoteAddress) — e em loopback
//    NET_CompareAdr ignora a porta. Resultado: os snapshots do servidor local (porta 0, sequência alta) entram no
//    netchan do convidado no lugar dos do host (porta 524) e ele desenha o mundo errado. Troca a chamada por
//    NET_CompareBaseAdr (mesma assinatura; compara a porta em loopback). Mesmo critério que o motor já usa para o
//    connectResponse.
//
// Os índices de função vêm da seção "name" do próprio wasm (o vel.gg publica com nomes), então o patch acompanha uma
// recompilação enquanto as funções existirem; qualquer coisa fora do esperado (0 ou 2+ ocorrências, LEB de tamanho
// diferente) => sem patch e o motivo no log.

import { bytes, indexOfBytes, utf8 } from './bytes.mjs';

function reader(buf, pos = 0) {
  return {
    get pos() { return pos; }, set pos(v) { pos = v; },
    byte: () => buf[pos++],
    u32() { let r = 0, s = 0, b; do { b = buf[pos++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; },
    str() { const n = this.u32(); const s = utf8(buf.subarray(pos, pos + n)); pos += n; return s; },
  };
}

function uleb(n) { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }

// { imports, names: Map(nome -> índice), body(índice) -> { start, end } }
export function parseWasm(buf) {
  if (buf.length < 8 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) throw new Error('não é wasm');
  const r = reader(buf, 8);
  let imports = 0, code = null;
  const names = new Map();
  while (r.pos < buf.length) {
    const id = r.byte(), size = r.u32(), start = r.pos, end = start + size;
    if (id === 2) { // import
      const n = r.u32();
      for (let i = 0; i < n; ++i) {
        r.str(); r.str();
        const kind = r.byte();
        if (kind === 0) { r.u32(); ++imports; }
        else if (kind === 1) { r.byte(); const f = r.u32(); r.u32(); if (f & 1) r.u32(); }
        else if (kind === 2) { const f = r.u32(); r.u32(); if (f & 1) r.u32(); }
        else if (kind === 3) { r.byte(); r.byte(); }
        else if (kind === 4) { r.byte(); r.u32(); }
      }
    } else if (id === 10) code = { start, end };
    else if (id === 0) {
      const name = r.str();
      if (name === 'name') {
        while (r.pos < end) {
          const sub = r.byte(), len = r.u32(), subEnd = r.pos + len;
          if (sub === 1) { const n = r.u32(); for (let i = 0; i < n; ++i) { const idx = r.u32(); names.set(r.str(), idx); } }
          r.pos = subEnd;
        }
      }
    }
    r.pos = end;
  }
  if (!code) throw new Error('sem seção de código');
  // índice da função -> corpo (lido sob demanda: são dezenas de milhares de funções)
  let offsets = null;
  const body = idx => {
    if (!offsets) {
      offsets = [];
      const c = reader(buf, code.start), n = c.u32();
      for (let i = 0; i < n; ++i) { const size = c.u32(); offsets.push(c.pos); c.pos += size; }
      offsets.push(code.end);
    }
    const i = idx - imports;
    if (i < 0 || i + 1 >= offsets.length) throw new Error(`função ${idx} fora do código`);
    return { start: offsets[i], end: offsets[i + 1] };
  };
  return { imports, names, body };
}

function findName(names, prefix) {
  const hits = [...names.keys()].filter(n => n === prefix || n.startsWith(prefix + '('));
  if (hits.length !== 1) throw new Error(`${prefix}: ${hits.length} funções com esse nome`);
  return names.get(hits[0]);
}

function indexAllIn(buf, needle, start, end) {
  const out = [];
  for (let i = indexOfBytes(buf, needle, start); i >= 0 && i < end; i = indexOfBytes(buf, needle, i + 1)) out.push(i);
  return out;
}

// Troca, dentro do corpo de `inFn`, a única chamada a `from` seguida de `tail` por uma chamada a `to`.
function retargetCall(buf, wasm, label, inFn, from, to, tail) {
  const fn = wasm.body(findName(wasm.names, inFn));
  const a = uleb(findName(wasm.names, from)), b = uleb(findName(wasm.names, to));
  if (a.length !== b.length) throw new Error(`${label}: índices com LEB de tamanhos diferentes`);
  const sites = indexAllIn(buf, bytes([0x10, ...a, ...tail]), fn.start, fn.end);
  if (sites.length !== 1) throw new Error(`${label}: ${sites.length} chamadas em ${inFn} (esperado 1)`);
  buf.set(b, sites[0] + 1);
  return { label, at: sites[0] };
}

// Devolve { buf (cópia patcheada, Uint8Array), applied: [...], errors: [...] }. Nunca mexe no buffer de entrada.
export function patchGuestWasm(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const buf = new Uint8Array(src.length);
  buf.set(src);
  const applied = [], errors = [];
  let wasm;
  try { wasm = parseWasm(buf); } catch (error) { return { buf, applied, errors: [error.message] }; }
  const steps = [
    () => retargetCall(buf, wasm, 'G1', 'CL_PacketEvent', 'NET_CompareAdr', 'NET_CompareBaseAdr', [0x45, 0x04, 0x40]),
  ];
  for (const step of steps) {
    try { applied.push(step()); } catch (error) { errors.push(error.message); }
  }
  return { buf, applied, errors };
}
