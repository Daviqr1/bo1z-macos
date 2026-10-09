// F0: emulação fiel do lado do motor sobre os rings (mesma sequência de loads/stores da desmontagem do wasm).
// Usada pelos testes e pelo benchmark de corrida; nada daqui roda no app.
//
// Produtor (NET_OutOfBandPrint, NET_OutOfBandData, Netchan_Transmit, Netchan_TransmitNextFragment, … — 7 sítios):
//   br_table [2,2,0,1] sobre adr.type: só tipo 2 (NA_LOOPBACK) grava; 0/1 nada; >= 3 descartado.
//   ring = sock <= 0 ? 1 : sock == 1 ? adr.port & 0xffff : sock;  tag = sock <= 0 ? sock : 0
//   s = send (i32.load comum); slot = ring + (s & 15) * 1272; memory.copy data; tag em +1268; len em +1264;
//   i32.atomic.rmw.add send, 1
// Consumidor (NET_GetLoopPacket(sock, from, msg)):
//   if (send - get >= 17) get = send - 16  (store comum)
//   g = get; if (g < send, sem sinal) { atomic add get, 1; len = slot.len; copia; cursize = slot.len (relido);
//     from = { type: 2, port: slot.tag & 0xffff } }
import { DEFAULT_LAYOUT, ringAddr } from '../app/coop/layout.mjs';

export const NA_BOT = 0, NA_BAD = 1, NA_LOOPBACK = 2, NA_BROADCAST = 3, NA_IP = 4;

export class EngineSim {
  constructor(buffer, layout = DEFAULT_LAYOUT) {
    this.layout = layout;
    this.u8 = new Uint8Array(buffer);
    this.i32 = new Int32Array(buffer);
    this.spin = 0; // iterações de espera entre ler `send` e publicar (alarga a janela de corrida nos testes)
  }

  // Envio de um pacote pelo socket `sock` (0 = cliente local, 1 = servidor) para `adr` ({ type, port }).
  sendPacket(sock, bytes, adr = { type: NA_LOOPBACK, port: 0 }) {
    if (adr.type !== NA_LOOPBACK) return false; // tipos 0/1: nada; IP/broadcast: descartado
    const L = this.layout;
    const ring = ringAddr(L, sock <= 0 ? 1 : sock === 1 ? adr.port & 0xffff : sock);
    const tag = sock <= 0 ? sock : 0;
    const s = this.i32[(ring + L.sendOff) >> 2] >>> 0; // load comum
    const slot = ring + (s & 15) * L.slotSize;
    if (bytes.length) this.u8.set(bytes, slot); // memory.copy, sem checar tamanho (os chamadores limitam)
    for (let i = 0; i < this.spin; ++i) Atomics.load(this.i32, 0); // janela artificial entre a cópia e a publicação
    this.i32[(slot + L.tagOff) >> 2] = tag;
    this.i32[(slot + L.lenOff) >> 2] = bytes.length;
    Atomics.add(this.i32, (ring + L.sendOff) >> 2, 1);
    return true;
  }

  // NET_GetLoopPacket: devolve { bytes, cursize, from: { type: 2, port } } ou null. cursize !== bytes.length quando
  // um produtor reescreveu o len entre as duas leituras (só acontece com o ring 16 à frente).
  getLoopPacket(sock) {
    const L = this.layout, ring = ringAddr(L, sock);
    const getIdx = (ring + L.getOff) >> 2, sendIdx = (ring + L.sendOff) >> 2;
    if (((this.i32[sendIdx] - this.i32[getIdx]) >>> 0) >= L.overrun) this.i32[getIdx] = (this.i32[sendIdx] - 16) | 0;
    const g = this.i32[getIdx] >>> 0;
    if (!(g < (this.i32[sendIdx] >>> 0))) return null;
    Atomics.add(this.i32, getIdx, 1);
    const slot = ring + (g & 15) * L.slotSize;
    const len = this.i32[(slot + L.lenOff) >> 2];
    const bytes = this.u8.slice(slot, slot + len); // o motor confia no len (não há checagem de limite)
    const cursize = this.i32[(slot + L.lenOff) >> 2]; // relido, como no wasm
    const port = this.i32[(slot + L.tagOff) >> 2] & 0xffff;
    return { bytes, cursize, from: { type: NA_LOOPBACK, port } };
  }
}
