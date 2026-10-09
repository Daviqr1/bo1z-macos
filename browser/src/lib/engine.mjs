// Ganchos do motor do vel.gg na extensão, sem tocar no glue nem no engine.js (que não redistribuímos). O glue
// (KisakBlack-web.mjs, Emscripten com PROXY_TO_PTHREAD) instancia o wasm na thread da página com
// WebAssembly.instantiateStreaming(fetch(wasm), imports) — ou instantiate(bytes, imports) se o streaming falhar —, e
// passa o módulo compilado às pthreads. A extensão embrulha essas duas chamadas (content-main.js) e, com o resultado:
//  - N1: embrulha o export __wasm_call_ctors (initRuntime) e, logo depois dele, expõe globalThis.__bo1zKB e dispara
//    'bo1z:kb', como o patch N1 do app (app/coop/gluepatch.mjs). Só na thread da página (as pthreads instanciam o
//    módulo por conta própria, sem passar por aqui);
//  - convidado: G1 (app/coop/wasmpatch.mjs) nos bytes, só se o sha256 do wasm original for um dos conhecidos;
//  - argumentos: embrulha _emscripten_proxy_main(argc, argv), a entrada que o callMain do glue chama, e reescreve o
//    argv na memória: '+set name <nome>' (e '+set sv_timeout 30' no host) antes de '+devmap', e no convidado
//    '+connect localhost:3074' logo depois de '+devmap <mapa>' (estratégia shadow, app/coop/main-coop.js).
// O glue só lê instance.exports (receiveInstance), então devolvemos { module, instance: { exports } } com uma cópia
// dos exports em que só essas duas funções mudam.

// wasm do vel.gg analisado e testado com o motor rodando (docs/COOP-STATUS.md). Outro hash: convidado não entra.
export const GUEST_WASM_SHA256 = Object.freeze(['61192df377020627f52fa7e9fd28047bd53662aa46e5e3cd6e7fad0c5c35cc98']);

// Mesmo saneamento do app (main-coop.js engineName): o placar do motor aceita poucos caracteres.
export function engineName(name) {
  return String(name ?? '').replace(/[^A-Za-z0-9_.\- ]/g, '').trim().slice(0, 15) || 'Player';
}

// Argumentos do motor (sem o argv[0]) para a partida de co-op. Devolve { args, applied } ou lança se não houver
// '+devmap' (aí o motor não sobe um mapa e a estratégia shadow não vale).
export function coopArgs(args, { role, name }) {
  const out = [...args];
  const devmap = out.indexOf('+devmap');
  if (devmap < 0 || devmap + 1 >= out.length) throw new Error('argumentos sem +devmap <mapa>');
  if (out.includes('+connect')) return { args: out, applied: [] }; // já reescrito (não repete)
  const pre = ['+set', 'name', engineName(name)];
  if (role === 'host') pre.push('+set', 'sv_timeout', '30');
  out.splice(out.indexOf('+devmap'), 0, ...pre);
  const applied = ['name', ...(role === 'host' ? ['sv_timeout'] : [])];
  if (role === 'guest') {
    out.splice(out.indexOf('+devmap') + 2, 0, '+connect', 'localhost:3074');
    applied.push('shadow');
  }
  return { args: out, applied };
}

const decoder = new TextDecoder(), encoder = new TextEncoder();

// argv do C (ponteiros u32 para strings terminadas em 0) -> strings. A memória do motor é compartilhada: o
// TextDecoder não aceita vista de SharedArrayBuffer, então copia antes.
export function readArgv(buffer, argc, argv) {
  const u8 = new Uint8Array(buffer), dv = new DataView(buffer), out = [];
  for (let i = 0; i < argc; ++i) {
    const p = dv.getUint32(argv + 4 * i, true);
    let end = p;
    while (u8[end] !== 0 && end - p < 4096) ++end;
    out.push(decoder.decode(u8.slice(p, end)));
  }
  return out;
}

// strings -> argv novo num bloco só do malloc do motor (nunca liberado: o main usa o argv até o fim).
export function writeArgv(buffer, malloc, args) {
  const strings = args.map(a => encoder.encode(a));
  const table = (args.length + 1) * 4, size = table + strings.reduce((n, s) => n + s.length + 1, 0);
  const block = malloc(size);
  if (!block) throw new Error('malloc do argv falhou');
  const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
  let at = block + table;
  strings.forEach((s, i) => {
    dv.setUint32(block + 4 * i, at, true);
    u8.set(s, at);
    u8[at + s.length] = 0;
    at += s.length + 1;
  });
  dv.setUint32(block + 4 * args.length, 0, true);
  return { argc: args.length, argv: block };
}

// Cópia dos exports com N1 (onRuntime depois de __wasm_call_ctors) e, se rewrite vier, a troca de argumentos na
// entrada. rewrite(args) -> args novos (sem argv[0]) ou null para deixar como está.
export function wrapExports(exports, { memory, onRuntime, rewrite = null, log = () => {} }) {
  const out = Object.assign({}, exports);
  const ctors = exports.__wasm_call_ctors;
  if (typeof ctors === 'function') {
    out.__wasm_call_ctors = function (...a) {
      const r = ctors.apply(this, a);
      try { onRuntime(); } catch (error) { log(`bo1z:kb falhou: ${error.message}`); }
      return r;
    };
  } else log('wasm sem __wasm_call_ctors: bo1z:kb não será disparado');
  const entry = exports._emscripten_proxy_main;
  if (rewrite && typeof entry === 'function') {
    out._emscripten_proxy_main = function (argc, argv) {
      try {
        const args = readArgv(memory.buffer, argc, argv);
        const next = rewrite(args.slice(1));
        if (next) {
          const w = writeArgv(memory.buffer, exports.malloc, [args[0], ...next]);
          return entry.call(this, w.argc, w.argv);
        }
      } catch (error) { log(`argumentos do co-op não aplicados: ${error.message}`); }
      return entry.call(this, argc, argv);
    };
  } else if (rewrite) log('wasm sem _emscripten_proxy_main: argumentos do co-op não aplicados');
  return out;
}

export async function sha256Hex(bytes, subtle = globalThis.crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

// Decisão do convidado sobre o wasm baixado: só com o hash conhecido e o G1 aplicado sem erro.
// -> { ok: true, buf, applied } | { ok: false, reason }
export function prepareGuestWasm({ bytes, sha, patchGuestWasm, expected = GUEST_WASM_SHA256 }) {
  if (!expected.includes(sha))
    return { ok: false, reason: `wasm do vel.gg mudou (sha256 ${sha.slice(0, 12)}…): esta versão da extensão não sabe ` +
      'preparar o convidado. Atualize a extensão; por ora o jogo sobe solo.' };
  const p = patchGuestWasm(bytes);
  if (p.errors.length || !p.applied.some(a => a.label === 'G1'))
    return { ok: false, reason: `patch G1 do convidado falhou: ${p.errors.join('; ') || 'não aplicado'}` };
  return { ok: true, buf: p.buf, applied: p.applied.map(a => a.label) };
}

// O que identifica a instanciação do motor (e não de outro wasm da página): memória importada compartilhada.
export function isEngineImports(imports) {
  const memory = imports?.env?.memory;
  return typeof WebAssembly !== 'undefined' && memory instanceof WebAssembly.Memory &&
    memory.buffer instanceof SharedArrayBuffer;
}
