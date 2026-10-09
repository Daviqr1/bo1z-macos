// Patches do wasm do convidado (app/coop/wasmpatch.mjs). O wasm real não é versionado: BO1Z_WASM=<caminho> roda contra ele.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseWasm, patchGuestWasm } from '../app/coop/wasmpatch.mjs';

test('entrada que não é wasm: nenhum patch, erro explicado, buffer intacto', () => {
  const junk = Buffer.from('nao sou wasm');
  const r = patchGuestWasm(junk);
  assert.deepEqual(r.applied, []);
  assert.match(r.errors[0], /não é wasm/);
  assert.equal(r.buf.toString(), 'nao sou wasm');
});

const REAL = process.env.BO1Z_WASM;
test('wasm real: G1 troca NET_CompareAdr por NET_CompareBaseAdr só no CL_PacketEvent (2 bytes)', { skip: !REAL || !existsSync(REAL) }, () => {
  const original = readFileSync(REAL);
  const w = parseWasm(original);
  assert.equal(w.imports, 170);
  const r = patchGuestWasm(original);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.applied.map(a => a.label), ['G1']);
  const diff = [];
  for (let i = 0; i < original.length; ++i) if (original[i] !== r.buf[i]) diff.push(i);
  assert.equal(diff.length, 2);
  const fn = w.body([...w.names].find(([n]) => n.startsWith('CL_PacketEvent('))[1]);
  assert.ok(diff.every(i => i >= fn.start && i < fn.end));
  // a entrada não foi tocada e o resultado ainda é um módulo válido
  assert.notEqual(r.buf, original);
  assert.ok(WebAssembly.validate(r.buf));
});
