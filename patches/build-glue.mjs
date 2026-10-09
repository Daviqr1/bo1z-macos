// Gera patches/KisakBlack-web.patched.mjs a partir do glue formatado (prettier) do vel.gg + patches verificados.
// node patches/build-glue.mjs   (escreve também patches/manifest.json com o sha256 do original esperado)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyPatches } from './hotpath_patch.mjs';
const dir = new URL('./', import.meta.url).pathname;
let src = readFileSync(dir + 'KisakBlack-web.pretty.mjs', 'utf8');
const once = (from, to, label) => {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`${label}: âncora encontrada ${n}x`);
  src = src.replace(from, to);
};
// a/c/e: constants() sem alocação, stencil sem alocação/sv espúrio, ranges reutilizados (b/d reprovados na verificação).
const before = src;
src = applyPatches(src, 'a,c,e');
if (src === before) throw new Error('a,c,e não aplicaram');
// P01: warmPersist (JSON de ~85 ms) saía do caminho do frame a cada 600 frames; agora só com o executor ocioso >= 1 s.
once('let warmSaved = -1;', 'let warmSaved = -1, warmDirty = false;', 'P01.1');
once(`                busy = 0;
                tasks = 0;
                warmPersist();`, `                busy = 0;
                tasks = 0;
                warmDirty = ctx.manifest.size !== warmSaved;`, 'P01.2');
once('const res = Atomics.waitAsync(hdr, W, w);', 'const res = Atomics.waitAsync(hdr, W, w, warmDirty ? 1000 : Infinity);', 'P01.3');
once(`              await res.value;
              fIdle += performance.now() - i0;`, `              const v = await res.value;
              fIdle += performance.now() - i0;
              if (v === "timed-out" && warmDirty) {
                warmDirty = false;
                warmPersist();
              }`, 'P01.4');
// I1: grampo de input — cada _KB_Input(tipo, a, b) vai também para globalThis.__bo1zInputTap (só na página, onde
// existe __bo1zInputTap; workers não chamam _KB_Input). O gravador drena a cada segundo; replay reinjeta pela mesma função.
once('    _KB_Input = Module["_KB_Input"] = wasmExports["KB_Input"];', `    {
      const kbInput = wasmExports["KB_Input"];
      _KB_Input = Module["_KB_Input"] = (kind, a, b) => {
        const tap = globalThis.__bo1zInputTap;
        if (tap && !globalThis.__bo1zReplaying) { if (tap.length > 400000) tap.length = 0; } 
        if (tap && !globalThis.__bo1zReplaying) tap.push(Math.round(performance.now() * 10) / 10, kind, a, b);
        return kbInput(kind, a, b);
      };
      globalThis.__bo1zKBInput = kbInput;
    }`, 'I1');
writeFileSync(dir + 'KisakBlack-web.patched.mjs', src);
const sha = f => createHash('sha256').update(readFileSync(dir + f)).digest('hex');
writeFileSync(dir + 'manifest.json', JSON.stringify({ 'KisakBlack-web.mjs': { original: sha('KisakBlack-web.orig.mjs'), patched: 'KisakBlack-web.patched.mjs', patches: ['a', 'c', 'e', 'P01', 'I1'] } }, null, 2) + '\n');
console.log('ok', src.length);
