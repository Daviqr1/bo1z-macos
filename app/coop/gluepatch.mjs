// Patch N1 do glue (KisakBlack-web.mjs): expõe a memória e o malloc do motor para a ponte de co-op, logo depois de
// initRuntime() e antes do main do motor (engine.js cria o módulo com noInitialRun e só chama callMain depois do
// pack). É o momento de heap mais baixo: a ponte reserva ali os rings dos convidados (k <= 0xffff, ver netbridge.mjs).
// Funciona tanto no glue formatado (build-glue.mjs) quanto no original minificado (main.js, em tempo de execução).
// Só na página: as pthreads (workers "em-pthread") rodam o mesmo arquivo e não ganham nada.
const ANCHOR = /initRuntime\(\);(\s*)Module\["onRuntimeInitialized"\]\?\.\(\);/g;

export const N1_MARK = 'globalThis.__bo1zKB = {';

export function applyN1(src) {
  if (src.includes(N1_MARK)) throw new Error('N1: já aplicado');
  const hits = src.match(ANCHOR) ?? [];
  if (hits.length !== 1) throw new Error(`N1: âncora encontrada ${hits.length}x`);
  return src.replace(ANCHOR, (_, ws) => 'initRuntime();' + ws +
    'if (!ENVIRONMENT_IS_PTHREAD && globalThis.window) {' +
    ' globalThis.__bo1zKB = { memory: wasmMemory, malloc: _malloc, free: _free, module: Module };' +
    ' globalThis.dispatchEvent(new Event("bo1z:kb")); }' + ws +
    'Module["onRuntimeInitialized"]?.();');
}
