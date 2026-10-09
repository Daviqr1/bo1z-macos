// Extensão do navegador: ganchos do motor sem mexer no glue (browser/src/lib/engine.mjs) — argumentos do co-op,
// argv na memória, N1 depois de __wasm_call_ctors, decisão do wasm do convidado (sha256 + G1).
// O wasm real não é versionado: BO1Z_WASM=<caminho do KisakBlack-web.wasm> roda contra ele.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { GUEST_WASM_SHA256, coopArgs, engineName, isEngineImports, prepareGuestWasm, readArgv, sha256Hex, wrapExports,
  writeArgv } from '../browser/src/lib/engine.mjs';
import { patchGuestWasm } from '../app/coop/wasmpatch.mjs';
import { bumpAllocator, makeMemory } from './helpers.mjs';

// argumentos como o engine.js do vel.gg monta (fiveArguments + ajustes do play.js), resumidos
const ARGS = ['+set', 'fs_b', '/opfs/pack-nacht/files', '+set', 'zombiemode', '1', '+set', 'r_customMode', '1280x720',
  '+devmap', 'zombie_cod5_prototype'];

test('argumentos: host ganha nome e sv_timeout antes do +devmap; convidado ganha +connect depois do mapa', () => {
  const host = coopArgs(ARGS, { role: 'host', name: 'Davi Ç!' });
  assert.deepEqual(host.args.slice(0, ARGS.length - 2), ARGS.slice(0, -2));
  assert.deepEqual(host.args.slice(ARGS.length - 2), ['+set', 'name', 'Davi', '+set', 'sv_timeout', '30', '+devmap', 'zombie_cod5_prototype']);
  assert.deepEqual(host.applied, ['name', 'sv_timeout']);
  const guest = coopArgs(ARGS, { role: 'guest', name: 'Irmão' });
  const at = guest.args.indexOf('+devmap');
  assert.deepEqual(guest.args.slice(at - 3), ['+set', 'name', 'Irmo', '+devmap', 'zombie_cod5_prototype', '+connect', 'localhost:3074']);
  assert.ok(!guest.args.includes('sv_timeout'));
  assert.deepEqual(guest.applied, ['name', 'shadow']);
  // não repete e não inventa mapa
  assert.deepEqual(coopArgs(guest.args, { role: 'guest', name: 'x' }).applied, []);
  assert.throws(() => coopArgs(['+set', 'a', '1'], { role: 'guest' }), /sem \+devmap/);
  assert.throws(() => coopArgs(['+devmap'], { role: 'guest' }), /sem \+devmap/);
  assert.equal(engineName(''), 'Player');
  assert.equal(engineName('  Um_Nome.Muito-Comprido demais  '), 'Um_Nome.Muito-C');
});

test('argv na memória compartilhada: lê o que o callMain escreveu e grava um argv novo no malloc', () => {
  const buffer = makeMemory(), heap = bumpAllocator();
  const original = writeArgv(buffer, heap.malloc, ['./this.program', ...ARGS]);
  assert.deepEqual(readArgv(buffer, original.argc, original.argv), ['./this.program', ...ARGS]);
  const next = writeArgv(buffer, heap.malloc, ['./this.program', 'ção', '']);
  assert.deepEqual(readArgv(buffer, next.argc, next.argv), ['./this.program', 'ção', '']);
  assert.equal(new DataView(buffer).getUint32(next.argv + 12, true), 0); // argv[argc] = NULL
  assert.throws(() => writeArgv(buffer, () => 0, ['x']), /malloc/);
});

function fakeEngine() {
  const buffer = makeMemory(), heap = bumpAllocator(), calls = [];
  const memory = { buffer };
  const exports = {
    __wasm_call_ctors: () => calls.push('ctors'),
    _emscripten_proxy_main: (argc, argv) => { calls.push(['main', readArgv(buffer, argc, argv)]); return 0; },
    malloc: heap.malloc, free: heap.free, KB_Input: () => 1, other: 42,
  };
  // o que o callMain do glue faz: argv na pilha (aqui no malloc) e chama a entrada
  const callMain = (ex, args) => { const w = writeArgv(buffer, heap.malloc, ['./this.program', ...args]); return ex._emscripten_proxy_main(w.argc, w.argv); };
  return { buffer, memory, exports, calls, callMain };
}

test('exports embrulhados: bo1z:kb logo depois dos construtores; entrada com argumentos reescritos; resto intacto', () => {
  const e = fakeEngine(), seen = [];
  const out = wrapExports(e.exports, { memory: e.memory, onRuntime: () => seen.push(`kb depois de ${e.calls.at(-1)}`),
    rewrite: args => coopArgs(args, { role: 'guest', name: 'Davi' }).args });
  assert.notEqual(out, e.exports);
  assert.equal(out.other, 42);
  assert.equal(out.malloc, e.exports.malloc);
  out.__wasm_call_ctors();
  assert.deepEqual(seen, ['kb depois de ctors']);
  assert.equal(e.callMain(out, ARGS), 0);
  const [, argv] = e.calls.at(-1);
  assert.equal(argv[0], './this.program');
  assert.deepEqual(argv.slice(-4), ['+devmap', 'zombie_cod5_prototype', '+connect', 'localhost:3074']);
});

test('sem papel no co-op a entrada passa direto; reescrita com erro cai no argv original (o jogo sobe solo)', () => {
  const e = fakeEngine(), logs = [];
  const solo = wrapExports(e.exports, { memory: e.memory, onRuntime: () => {} });
  assert.equal(solo._emscripten_proxy_main, e.exports._emscripten_proxy_main);
  const broken = wrapExports(e.exports, { memory: e.memory, onRuntime: () => { throw new Error('kb'); },
    rewrite: () => { throw new Error('sem +devmap'); }, log: l => logs.push(l) });
  broken.__wasm_call_ctors(); // erro no gancho não derruba os construtores
  e.callMain(broken, ARGS);
  assert.deepEqual(e.calls.at(-1)[1].slice(1), ARGS);
  assert.ok(logs.some(l => /bo1z:kb falhou/.test(l)) && logs.some(l => /não aplicados: sem \+devmap/.test(l)));
  // wasm sem as funções esperadas: avisa e não inventa nada
  const bare = wrapExports({ malloc: () => 0 }, { memory: e.memory, onRuntime: () => {}, rewrite: a => a, log: l => logs.push(l) });
  assert.deepEqual(Object.keys(bare), ['malloc']);
  assert.ok(logs.some(l => /sem __wasm_call_ctors/.test(l)) && logs.some(l => /sem _emscripten_proxy_main/.test(l)));
});

test('instanciação do motor: só a memória importada compartilhada conta', () => {
  const shared = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  assert.equal(isEngineImports({ env: { memory: shared } }), true);
  assert.equal(isEngineImports({ env: { memory: new WebAssembly.Memory({ initial: 1 }) } }), false);
  assert.equal(isEngineImports({ env: {} }), false);
  assert.equal(isEngineImports(undefined), false);
});

test('convidado: hash desconhecido não entra; patch que falha não entra; com hash e G1, entra', async () => {
  const bytes = new TextEncoder().encode('nao sou o wasm do vel.gg');
  const sha = await sha256Hex(bytes);
  assert.equal(sha, (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
  let r = prepareGuestWasm({ bytes, sha, patchGuestWasm });
  assert.equal(r.ok, false);
  assert.match(r.reason, /wasm do vel\.gg mudou/);
  r = prepareGuestWasm({ bytes, sha, patchGuestWasm, expected: [sha] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /G1 do convidado falhou: não é wasm/);
  r = prepareGuestWasm({ bytes, sha, expected: [sha], patchGuestWasm: b => ({ buf: b, applied: [{ label: 'G1' }], errors: [] }) });
  assert.deepEqual([r.ok, r.applied], [true, ['G1']]);
  assert.deepEqual(GUEST_WASM_SHA256, ['61192df377020627f52fa7e9fd28047bd53662aa46e5e3cd6e7fad0c5c35cc98']);
});

const REAL = process.env.BO1Z_WASM;
test('wasm real: hash conhecido e G1 aplicado; um byte trocado e o convidado não entra', { skip: !REAL || !existsSync(REAL) }, async () => {
  const bytes = new Uint8Array(readFileSync(REAL));
  const sha = await sha256Hex(bytes);
  const r = prepareGuestWasm({ bytes, sha, patchGuestWasm });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.applied, ['G1']);
  assert.ok(WebAssembly.validate(r.buf));
  const changed = bytes.slice();
  changed[changed.length - 1] ^= 1;
  assert.equal(prepareGuestWasm({ bytes: changed, sha: await sha256Hex(changed), patchGuestWasm }).ok, false);
});
