// Layout dos rings de loopback do motor (KisakBlack-web.wasm, sha256 61192df3…cc98). Ver docs/COOP-P2P-SPEC.md §1.2.
// Os valores reais vêm do scanner (wasmscan.mjs) sobre o wasm servido; DEFAULT_LAYOUT é o da versão analisada e serve
// de referência nos testes e de conferência no main.js (se o scanner achar outra coisa, o co-op fica desligado).
//
// Um ring (loopback_t) = 16 slots + get + send:
//   slot i em ring + i*slotSize: data[0..maxLen-1], len (i32) em +lenOff, tag/porta (i32) em +tagOff
//   get (u32) em ring + getOff, send (u32) em ring + sendOff
// Produtor do motor: s = send (load comum); grava data, tag, len no slot s&15; só então atomic.rmw.add send.
// Consumidor do motor (NET_GetLoopPacket): se send-get >= 17, get = send-16; se get < send: atomic add get, copia o slot.

export const DEFAULT_LAYOUT = Object.freeze({
  base: 135783616, // &loopbacks[0] (0x817E4C0)
  stride: 20360, // sizeof(loopback_t)
  slotSize: 1272,
  slots: 16,
  maxLen: 1264, // bytes de dado por slot (MAX_PACKETLEN deste build)
  lenOff: 1264,
  tagOff: 1268,
  getOff: 20352,
  sendOff: 20356,
  overrun: 17, // send-get >= overrun => o consumidor do motor pula para send-16
  memoryBytes: 2147418112, // 32767 páginas, memória compartilhada fixa (não cresce)
});

export const RING_CLIENT = 0; // caixa de entrada do cliente local
export const RING_SERVER = 1; // caixa de entrada do servidor local
export const MAX_RING = 0xffff; // o servidor escolhe o ring por adr.port & 0xffff

export function ringAddr(layout, k) {
  return layout.base + k * layout.stride;
}

// Confere a coerência interna de um layout (vindo do scanner ou de config). Lança erro descritivo se algo não fecha.
export function checkLayout(l) {
  const fail = msg => { throw new Error(`layout inválido: ${msg}`); };
  for (const key of ['base', 'stride', 'slotSize', 'slots', 'maxLen', 'lenOff', 'tagOff', 'getOff', 'sendOff', 'overrun'])
    if (!Number.isSafeInteger(l[key]) || l[key] <= 0) fail(`${key}=${l[key]}`);
  if (l.slots !== 16) fail(`slots=${l.slots} (o motor usa & 15)`);
  if (l.lenOff !== l.maxLen || l.tagOff !== l.lenOff + 4 || l.slotSize !== l.tagOff + 4) fail('slot não é {data, len, tag}');
  if (l.getOff !== l.slots * l.slotSize || l.sendOff !== l.getOff + 4 || l.stride !== l.sendOff + 4) fail('ring não é {slots, get, send}');
  if (l.base % 8 || l.stride % 8 || l.slotSize % 4) fail('alinhamento');
  if (l.overrun !== l.slots + 1) fail(`overrun=${l.overrun}`);
  return l;
}
