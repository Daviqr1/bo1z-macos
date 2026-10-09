// Acha o layout dos rings de loopback no binário do wasm por padrão de bytes (spec §4.1: "revalidar os endereços por
// padrão de bytes, não por constante fixa"). Âncora: o começo de NET_GetLoopPacket, que é o único lugar onde aparecem
// juntos base, stride, get, send, o limite de 17, o tamanho do slot e os offsets de len/tag:
//
//   local.get 0; i32.const STRIDE; i32.mul; local.tee L; i32.const BASE; i32.add; local.set 0
//   local.get L; i32.const BASE+SENDOFF; i32.add; i32.load        (send)
//   local.get L; i32.const BASE+GETOFF;  i32.add; i32.load        (get)
//   i32.sub; i32.const 17; i32.ge_u; if
//     local.get 0; local.get 0; i32.load offset=SENDOFF; i32.const 16; i32.sub; i32.store offset=GETOFF
//   end
//   … i32.const 15; i32.and; i32.const SLOTSIZE; i32.mul … i32.load offset=LENOFF … i32.load offset=TAGOFF; i32.store16 offset=8
//
// Também conta os produtores (`i32.atomic.rmw.add offset=BASE+SENDOFF`). Sem casamento único, devolve { ok: false }.
import { checkLayout, DEFAULT_LAYOUT } from './layout.mjs';

const S = name => ({ leb: 's', name }); // LEB128 com sinal (i32.const)
const U = name => ({ leb: 'u', name }); // LEB128 sem sinal (índice de local, offset de memarg)
const SEEK = max => ({ seek: max }); // o resto do padrão pode começar em qualquer ponto dos próximos `max` bytes

const GET_LOOP_PACKET = [
  0x20, 0x00, 0x41, S('stride'), 0x6c, 0x22, U('L'), 0x41, S('base'), 0x6a, 0x21, 0x00,
  0x20, U('L'), 0x41, S('sendAbs'), 0x6a, 0x28, 0x02, 0x00,
  0x20, U('L'), 0x41, S('getAbs'), 0x6a, 0x28, 0x02, 0x00,
  0x6b, 0x41, S('overrun'), 0x4f, 0x04, 0x40,
  0x20, 0x00, 0x20, 0x00, 0x28, 0x02, U('sendOff'), 0x41, S('slots'), 0x6b, 0x36, 0x02, U('getOff'), 0x0b,
  SEEK(64), 0x41, 0x0f, 0x71, 0x41, S('slotSize'), 0x6c,
  SEEK(32), 0x28, 0x02, U('lenOff'),
  SEEK(96), 0x28, 0x02, U('tagOff'), 0x3b, 0x01, 0x08,
];

function readLeb(buf, pos, signed) {
  let result = 0, shift = 0, byte;
  for (let i = 0; i < 5; ++i) {
    if (pos >= buf.length) return null;
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) {
      if (signed && shift < 32 && (byte & 0x40)) result |= -1 << shift;
      return { value: signed ? result | 0 : result >>> 0, pos };
    }
  }
  return null; // LEB de i32 tem no máximo 5 bytes
}

function matchAt(buf, pos, pattern, i, caps) {
  for (; i < pattern.length; ++i) {
    const p = pattern[i];
    if (typeof p === 'number') {
      if (buf[pos] !== p) return null;
      ++pos;
    } else if (p.leb) {
      const r = readLeb(buf, pos, p.leb === 's');
      if (!r) return null;
      if (p.name in caps && caps[p.name] !== r.value) return null;
      caps[p.name] = r.value;
      pos = r.pos;
    } else {
      for (let at = pos; at <= pos + p.seek && at < buf.length; ++at) {
        const sub = matchAt(buf, at, pattern, i + 1, { ...caps });
        if (sub) return sub;
      }
      return null;
    }
  }
  return caps;
}

function indexAll(buf, needle) {
  const out = [];
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function uleb(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}

// Ponteiro global da conexão do cliente local (CL_GetLocalClientConnection(0) devolve *PTR; serverAddress em +16).
// Âncora: o retorno da função, "i32.const PTR; i32.load; local.get 1; i32.const 32; i32.add; global.set 0; return",
// com o mesmo PTR testado no começo ("i32.const PTR; i32.load; i32.eqz; if") até 120 bytes antes. A ponte do convidado
// lê serverAddress para só encaminhar o que o cliente manda ao host (e não ao servidor local da estratégia shadow).
function findClientConnection(buf) {
  const found = new Set();
  for (const at of indexAll(buf, Buffer.from([0x28, 0x02, 0x00, 0x20, 0x01, 0x41, 0x20, 0x6a, 0x24, 0x00, 0x0f]))) {
    for (let start = at - 6; start <= at - 2; ++start) {
      if (buf[start] !== 0x41) continue;
      const r = readLeb(buf, start + 1, true);
      if (!r || r.pos !== at || r.value < 1024) continue;
      const probe = Buffer.from([0x41, ...uleb(r.value), 0x28, 0x02, 0x00, 0x45, 0x04, 0x40]);
      const before = buf.subarray(Math.max(0, start - 120), start);
      if (before.includes(probe)) found.add(r.value);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

// Base do segmento .rodata: __wasm_init_memory faz "i32.const BASE; i32.const 0; i32.const SIZE; memory.init 0".
function rodataBase(buf) {
  const hits = new Set();
  for (const at of indexAll(buf, Buffer.from([0xfc, 0x08, 0x00, 0x00]))) {
    // volta até 20 bytes procurando 41 BASE 41 00 41 SIZE imediatamente antes
    for (let start = at - 16; start < at - 4; ++start) {
      if (buf[start] !== 0x41) continue;
      const base = readLeb(buf, start + 1, true);
      if (!base || buf[base.pos] !== 0x41 || buf[base.pos + 1] !== 0x00 || buf[base.pos + 2] !== 0x41) continue;
      const size = readLeb(buf, base.pos + 3, true);
      if (size && size.pos === at && size.value > 4096) hits.add(base.value);
    }
  }
  return hits.size ? Math.min(...hits) : null;
}

// Global onde o motor guarda o ponteiro de um dvar: o registro é "i32.const GLOBAL; i32.const &nome; …;
// call _Dvar_Register*; i32.store". Acha &nome no .rodata e o GLOBAL logo antes dele (tem de ser único).
export function findDvarGlobals(input, names) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const out = Object.fromEntries(names.map(n => [n, null]));
  const base = rodataBase(buf);
  if (base === null) return out;
  // o .rodata é o primeiro segmento passivo; acha cada nome terminado em \0 (pode ser sufixo de outra string: o
  // linker funde "sv_running" no fim de "com_sv_running")
  for (const name of names) {
    const needle = Buffer.from(name + '\0');
    const found = new Set();
    for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) found.add(i);
    const globals = new Set();
    for (const fileOff of found) {
      // offset no arquivo -> endereço: precisa do início do segmento no arquivo; acha pelo par (BASE, conteúdo)
      const addr = base + (fileOff - rodataFileStart(buf));
      for (const at of indexAll(buf, Buffer.from([0x41, ...sleb(addr)]))) {
        for (let back = 2; back <= 6; ++back) {
          if (buf[at - back] !== 0x41) continue;
          const g = readLeb(buf, at - back + 1, true);
          if (g && g.pos === at && g.value > 1024) globals.add(g.value);
        }
      }
    }
    if (globals.size === 1) out[name] = [...globals][0];
  }
  return out;
}

function sleb(n) {
  const out = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return out; } out.push(b | 0x80); }
}

// Offset no arquivo onde começam os bytes do primeiro segmento de dados (seção 11).
let rodataCache = new WeakMap();
function rodataFileStart(buf) {
  if (rodataCache.has(buf)) return rodataCache.get(buf);
  let p = 8, result = -1;
  const rd = () => { let r = 0, s = 0, x; do { x = buf[p++]; r |= (x & 127) << s; s += 7; } while (x & 128); return r >>> 0; };
  while (p < buf.length) {
    const id = buf[p++], len = rd(), start = p;
    if (id === 11) {
      rd(); // número de segmentos
      const flags = rd();
      if (flags === 0 || flags === 2) { if (flags === 2) rd(); while (buf[p++] !== 0x0b); }
      rd(); // tamanho
      result = p;
      break;
    }
    p = start + len;
  }
  rodataCache.set(buf, result);
  return result;
}

// bytes: Uint8Array/Buffer do .wasm inteiro.
export function scanWasm(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Pré-filtro barato: "local.get 0; i32.const <qualquer>; i32.mul; local.tee" e depois o casamento completo.
  const hits = [];
  for (const at of indexAll(buf, Buffer.from([0x6c, 0x22]))) {
    for (let start = at - 7; start <= at - 3; ++start) {
      if (start < 0 || buf[start] !== 0x20 || buf[start + 1] !== 0x00 || buf[start + 2] !== 0x41) continue;
      const caps = matchAt(buf, start, GET_LOOP_PACKET, 0, {});
      if (caps) hits.push({ at: start, caps });
    }
  }
  if (hits.length !== 1) return { ok: false, reason: `NET_GetLoopPacket: ${hits.length} casamentos (esperado 1)` };
  const c = hits[0].caps;
  const layout = {
    base: c.base, stride: c.stride, slotSize: c.slotSize, slots: c.slots, maxLen: c.lenOff,
    lenOff: c.lenOff, tagOff: c.tagOff, getOff: c.getOff, sendOff: c.sendOff, overrun: c.overrun,
    memoryBytes: DEFAULT_LAYOUT.memoryBytes, clientServerPort: DEFAULT_LAYOUT.clientServerPort,
  };
  if (c.sendAbs !== c.base + c.sendOff || c.getAbs !== c.base + c.getOff)
    return { ok: false, reason: 'endereços absolutos de get/send não batem com base+offset' };
  try { checkLayout(layout); } catch (error) { return { ok: false, reason: error.message }; }
  // Produtores: i32.atomic.rmw.add (0xfe 0x1e) align=2 offset=BASE+SENDOFF.
  const producers = indexAll(buf, Buffer.from([0xfe, 0x1e, 0x02, ...uleb(c.sendAbs)])).length;
  if (!producers) return { ok: false, reason: 'nenhum produtor (atomic.rmw.add em send) encontrado' };
  layout.clientConnPtr = findClientConnection(buf); // null: convidado sem "armar" pelo serverAddress (ver page.mjs)
  layout.serverAddressOff = 16;
  // Dvars que a ponte lê/escreve direto (valor atual em dvar+24): sv_running/zombiemode para diagnóstico, sv_paused
  // para congelar o servidor sombra do convidado depois que ele passa a seguir o host.
  layout.dvars = findDvarGlobals(buf, ['sv_running', 'sv_paused', 'zombiemode', 'sv_timeout']);
  layout.dvarValueOff = 24;
  return { ok: true, layout, at: hits[0].at, producers };
}
