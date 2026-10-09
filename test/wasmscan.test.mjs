// Scanner do layout dos rings por padrão de bytes (app/coop/wasmscan.mjs) e patch N1 do glue (app/coop/gluepatch.mjs).
// O wasm real não é versionado: os testes montam o trecho de NET_GetLoopPacket instrução por instrução. Com
// BO1Z_WASM=<caminho do KisakBlack-web.wasm> roda também contra o binário de verdade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_LAYOUT } from '../app/coop/layout.mjs';
import { scanWasm } from '../app/coop/wasmscan.mjs';
import { applyN1 } from '../app/coop/gluepatch.mjs';

function sleb(n, pad = 0) {
  const out = [];
  for (;;) {
    const b = n & 0x7f; n >>= 7;
    if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); break; }
    out.push(b | 0x80);
  }
  while (out.length < pad) { out[out.length - 1] |= 0x80; out.push(n < 0 ? 0x7f : 0x00); }
  return out;
}
function uleb(n) { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }

const I = {
  get: l => [0x20, ...uleb(l)], set: l => [0x21, ...uleb(l)], tee: l => [0x22, ...uleb(l)],
  c: (n, pad) => [0x41, ...sleb(n, pad)], add: [0x6a], sub: [0x6b], mul: [0x6c], and: [0x71], ltu: [0x49], geu: [0x4f],
  load: off => [0x28, 0x02, ...uleb(off)], store: off => [0x36, 0x02, ...uleb(off)], store16: off => [0x3b, 0x01, ...uleb(off)],
  if: [0x04, 0x40], end: [0x0b], drop: [0x1a], atomicAdd: off => [0xfe, 0x1e, 0x02, ...uleb(off)], memcpy: [0xfc, 0x0a, 0x00, 0x00],
};

// NET_GetLoopPacket como o compilador emitiu (i32.const de endereço com LEB de 5 bytes).
function getLoopPacket(L, pad = 5) {
  const send = L.base + L.sendOff, get = L.base + L.getOff;
  return [
    ...I.get(0), ...I.c(L.stride), ...I.mul, ...I.tee(3), ...I.c(L.base, pad), ...I.add, ...I.set(0),
    ...I.get(3), ...I.c(send, pad), ...I.add, ...I.load(0),
    ...I.get(3), ...I.c(get, pad), ...I.add, ...I.load(0),
    ...I.sub, ...I.c(L.overrun), ...I.geu, ...I.if,
    ...I.get(0), ...I.get(0), ...I.load(L.sendOff), ...I.c(L.slots), ...I.sub, ...I.store(L.getOff), ...I.end,
    ...I.c(0), ...I.set(3), ...I.get(0), ...I.load(L.getOff), ...I.tee(4), ...I.get(0), ...I.load(L.sendOff), ...I.ltu, ...I.if,
    ...I.c(1), ...I.set(3), ...I.get(0), ...I.c(1), ...I.atomicAdd(L.getOff), ...I.drop,
    ...I.get(0), ...I.get(4), ...I.c(15), ...I.and, ...I.c(L.slotSize), ...I.mul, ...I.add, ...I.tee(0), ...I.load(L.lenOff), ...I.tee(4), ...I.if,
    ...I.get(2), ...I.load(8), ...I.get(0), ...I.get(4), ...I.memcpy, ...I.end,
    ...I.get(2), ...I.get(0), ...I.load(L.lenOff), ...I.store(20),
    ...I.get(1), ...I.get(0), ...I.load(L.tagOff), ...I.store16(8), ...I.end,
  ];
}
// Um produtor: … i32.atomic.rmw.add offset=base+sendOff (com o endereço absoluto no memarg).
const producer = L => [...I.get(5), ...I.c(1), ...I.atomicAdd(L.base + L.sendOff), ...I.drop];

function binary(parts) {
  const noise = n => Array.from({ length: n }, (_, i) => (i * 131 + 7) & 0xff);
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...noise(3000), ...parts.flatMap(p => [...p, ...noise(500)])]);
}

test('scanner acha o layout do motor analisado no trecho de NET_GetLoopPacket', () => {
  const r = scanWasm(binary([producer(DEFAULT_LAYOUT), getLoopPacket(DEFAULT_LAYOUT), producer(DEFAULT_LAYOUT)]));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.layout, { ...DEFAULT_LAYOUT });
  assert.equal(r.producers, 2);
});

test('scanner acompanha um motor recompilado (base nova, LEB mínimo) e recusa o que não fecha', () => {
  const moved = { ...DEFAULT_LAYOUT, base: 140000000 };
  const r = scanWasm(binary([getLoopPacket(moved, 0), producer(moved)]));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.layout.base, 140000000);

  assert.match(scanWasm(binary([producer(DEFAULT_LAYOUT)])).reason, /0 casamentos/);
  assert.match(scanWasm(binary([getLoopPacket(DEFAULT_LAYOUT), getLoopPacket(DEFAULT_LAYOUT), producer(DEFAULT_LAYOUT)])).reason, /2 casamentos/);
  assert.match(scanWasm(binary([getLoopPacket(DEFAULT_LAYOUT)])).reason, /nenhum produtor/);
  // slot com tamanho diferente do que os offsets de len/tag implicam: layout incoerente, co-op desligado
  const weird = { ...DEFAULT_LAYOUT, slotSize: 1280 };
  assert.equal(scanWasm(binary([getLoopPacket(weird), producer(weird)])).ok, false);
});

const REAL = process.env.BO1Z_WASM;
test('scanner no wasm real (BO1Z_WASM)', { skip: !REAL || !existsSync(REAL) }, () => {
  const r = scanWasm(readFileSync(REAL));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.layout, { ...DEFAULT_LAYOUT });
  assert.equal(r.producers, 7); // NET_OutOfBandPrint/Data, Netchan_Transmit(+NextFragment), Netchan_Process, SV_SendClientVoiceData
});

test('N1: expõe __bo1zKB depois de initRuntime, no glue formatado e no minificado; âncora ausente/duplicada falha', () => {
  const pretty = 'function run(){\n    if (ABORT) return;\n    initRuntime();\n    Module["onRuntimeInitialized"]?.();\n    var x;\n}';
  const out = applyN1(pretty);
  assert.match(out, /initRuntime\(\);\n    if \(!ENVIRONMENT_IS_PTHREAD && globalThis\.window\) \{ globalThis\.__bo1zKB = \{ memory: wasmMemory, malloc: _malloc, free: _free, module: Module \}; globalThis\.dispatchEvent\(new Event\("bo1z:kb"\)\); \}\n    Module\["onRuntimeInitialized"\]/);
  const min = 'if(ABORT)return;initRuntime();Module["onRuntimeInitialized"]?.();var noInitialRun=1';
  assert.ok(applyN1(min).includes('initRuntime();if (!ENVIRONMENT_IS_PTHREAD'));
  assert.throws(() => applyN1('initRuntime(); return;'), /âncora encontrada 0x/);
  assert.throws(() => applyN1(min + min), /âncora encontrada 2x/);
  assert.throws(() => applyN1(out), /já aplicado/);
  // o glue já tem o grampo I1 (globalThis.__bo1zKBInput): não pode ser confundido com N1
  assert.ok(applyN1(min + ';globalThis.__bo1zKBInput = kbInput;').includes('__bo1zKB = {'));
});
