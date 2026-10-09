// Prototype patches for the hot path (applied to a COPY of the glue source text in memory, never to the original).
// Each patch replaces one method body. Used by hotpath_bench.mjs when PATCH=<comma list> (a,b,c,d,e).
// a = constants() alloc-free + dyn offsets typed array     (kb.pretty.js:1387-1467, 1985-1991)
// b = textureGroup() direct-mapped numeric cache             (kb.pretty.js:1468-1535)
// c = stencil ops no-alloc / no spurious sv bump             (kb.pretty.js:2205-2211, 2313-2317)
// d = vertexAttribPointer offset-only rebase fast path       (kb.pretty.js:2281-2304, 980-1007)
// e = op 4 bindBufferRange reuses range objects              (kb.pretty.js:2121-2127)

function cut(src, startMarker, endMarker, replacement) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('marker not found: ' + startMarker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(0, a) + replacement + src.slice(b);
}

export function applyPatches(src, list) {
  const on = new Set(list.split(','));
  if (on.has('a')) {
    src = cut(src, '      constants() {\n', '      textureGroup(stage) {', `      constants() {
        const p = this.program, r0 = this.ranges[0], r1 = this.ranges[1];
        let c = this.lastConstants;
        if (c && c.program === p && c.epoch === this.uniformEpoch && c.uniforms === p.uniformVersion &&
            (r0 ? c.b0 === r0.buffer && c.o0 === r0.offset && c.s0 === r0.size && c.v0 === r0.buffer.version : c.b0 === null) &&
            (r1 ? c.b1 === r1.buffer && c.o1 === r1.offset && c.s1 === r1.size && c.v1 === r1.buffer.version : c.b1 === null))
          return this.constGen;
        const vm = p.vs.reflection.webgpu.constant_buffer, pm = p.ps.reflection.webgpu.constant_buffer;
        const ua = this.uniformAlignment;
        const vA = p.alignV ??= (Math.ceil(vm.bytes / ua) * ua), pA = p.alignP ??= (Math.ceil(pm.bytes / ua) * ua);
        if (this.uniformOffset + vA + pA > this.uniformCapacity) this.submit();
        const dyn = this.dyn ||= new Uint32Array(2);
        const bytes = this.uniformBytes, view = (this.uniformView ||= new DataView(bytes.buffer));
        for (let stage = 0; stage < 2; ++stage) {
          const meta = stage ? pm : vm, range = stage ? r1 : r0, offset = this.uniformOffset;
          const copied = range ? Math.min(range.size, meta.bytes - 16) : 0;
          if (copied) bytes.set(range.buffer.bytes.subarray(range.offset, range.offset + copied), offset);
          if (copied < meta.bytes) bytes.fill(0, offset + copied, offset + meta.bytes);
          const fixup = offset + (meta.fixup_offset ?? meta.bytes - 16);
          if (!stage) {
            const size = p.uniforms.get("kb_inv_viewport");
            view.setFloat32(fixup, size ? size[0] : 1 / this.canvas.width, true);
            view.setFloat32(fixup + 4, size ? size[1] : 1 / this.canvas.height, true);
            view.setUint32(fixup + 8, p.mask[0], true);
            view.setUint32(fixup + 12, p.mask[1], true);
          } else {
            view.setInt32(fixup, p.uniforms.get("kb_alpha_func") || 0, true);
            view.setFloat32(fixup + 4, p.uniforms.get("kb_alpha_ref") || 0, true);
          }
          dyn[stage] = offset;
          this.uniformOffset += stage ? pA : vA;
        }
        c ||= this.lastConstants = {};
        c.program = p; c.epoch = this.uniformEpoch; c.uniforms = p.uniformVersion;
        c.b0 = r0 ? r0.buffer : null; c.o0 = r0 ? r0.offset : 0; c.s0 = r0 ? r0.size : 0; c.v0 = r0 ? r0.buffer.version : 0;
        c.b1 = r1 ? r1.buffer : null; c.o1 = r1 ? r1.offset : 0; c.s1 = r1 ? r1.size : 0; c.v1 = r1 ? r1.buffer.version : 0;
        return ++this.constGen;
      }
`);
    src = src.replace('constructor(device, canvas, context = canvas.getContext("webgpu")) {', 'constructor(device, canvas, context = canvas.getContext("webgpu")) {\n        this.constGen = 1;');
    src = src.replace('const offsets = this.constants(),\n          indexFormat', 'const offsets = this.constants(),\n          indexFormat');
    src = src.replace(`          last.constants !== this.program.constants ||
          last.offsets !== offsets
        ) {
          pass.setBindGroup(0, this.program.constants, offsets);`, `          last.constants !== this.program.constants ||
          last.offsets !== offsets
        ) {
          pass.setBindGroup(0, this.program.constants, this.dyn, 0, 2);`);
  }
  if (on.has('b')) {
    src = src.replace('      textureGroup(stage) {', '      textureGroupSlow(stage) {');
    src = src.replace('      sampler(state = new Map()) {', `      textureGroup(stage) {
        const p = this.program, row = stage ? p.vs : p.ps, samplers = row.reflection.samplers, n = samplers.length, base = stage ? 16 : 0;
        const cache = (p.tgc ||= [new Array(64).fill(null), new Array(64).fill(null)])[stage];
        const ids = (this.tgIds ||= new Int32Array(64));
        let h = 0x811c9dc5 | 0;
        for (let i = 0; i < n; ++i) {
          const s = samplers[i], unit = this.units[base + s.register], texture = unit && unit.texture;
          if (!texture || !texture.gpu) throw new Error("WebGPU sampled texture missing: " + s.register);
          const gs = this.sampler((unit.sampler && unit.sampler.parameters) || texture.parameters);
          const a = texture.id, b = texture.generation, c = gs.id;
          ids[3 * i] = a; ids[3 * i + 1] = b; ids[3 * i + 2] = c;
          h = Math.imul(h ^ a, 0x01000193); h = Math.imul(h ^ b, 0x01000193); h = Math.imul(h ^ c, 0x01000193);
        }
        const slot = (h ^ (h >>> 15)) & 63, e = cache[slot], m = 3 * n;
        if (e && e.n === m) {
          let ok = true; const eid = e.ids;
          for (let i = 0; i < m; ++i) if (eid[i] !== ids[i]) { ok = false; break; }
          if (ok) return e.group;
        }
        const group = this.textureGroupSlow(stage);
        cache[slot] = { n: m, ids: ids.slice(0, m), group };
        return group;
      }
      sampler(state = new Map()) {`);
  }
  if (on.has('c')) {
    src = src.replace(`                this.stencilState(a, { func: b, ref: c, readMask: d });`, `                this.stencilFn(a, b, c, d);`);
    src = src.replace(`                this.stencilState(a, { writeMask: b });`, `                this.stencilWm(a, b);`);
    src = src.replace(`                this.stencilState(a, { fail: b, depthFail: c, pass: d });`, `                this.stencilOp(a, b, c, d);`);
    src = src.replace('      stencilState(face, state) {', `      stencilFn(face, func, ref, readMask) {
        const F = this.stencilFront, B = this.stencilBack;
        if (face !== 1029 && (F.func !== func || F.readMask !== readMask)) ++this.sv;
        else if (face !== 1028 && (B.func !== func || B.readMask !== readMask)) ++this.sv;
        if (face !== 1029) { F.func = func; F.ref = ref; F.readMask = readMask; }
        if (face !== 1028) { B.func = func; B.ref = ref; B.readMask = readMask; }
      }
      stencilWm(face, w) {
        const F = this.stencilFront, B = this.stencilBack;
        if ((face !== 1029 && F.writeMask !== w) || (face !== 1028 && B.writeMask !== w)) ++this.sv;
        if (face !== 1029) F.writeMask = w;
        if (face !== 1028) B.writeMask = w;
      }
      stencilOp(face, fail, depthFail, pass) {
        const F = this.stencilFront, B = this.stencilBack;
        if ((face !== 1029 && (F.fail !== fail || F.depthFail !== depthFail || F.pass !== pass)) ||
            (face !== 1028 && (B.fail !== fail || B.depthFail !== depthFail || B.pass !== pass))) ++this.sv;
        if (face !== 1029) { F.fail = fail; F.depthFail = depthFail; F.pass = pass; }
        if (face !== 1028) { B.fail = fail; B.depthFail = depthFail; B.pass = pass; }
      }
      stencilState(face, state) {`);
  }
  if (on.has('d')) {
    src = cut(src, '      pointer(location, size, type, normalized, stride, offset) {', '      bindTexture(target, texture) {', `      pointer(location, size, type, normalized, stride, offset) {
        const vao = this.vao, o = vao.attributes[location], buffer = this.buffers.get(34962);
        if (o && o.buffer === buffer && o.size === size && o.type === type && o.normalized === normalized && o.stride === stride) {
          if (o.offset === offset) return;
          // offset-only change by a whole number of strides on a non-converted attribute: pipeline layout is unchanged,
          // only the vertex-buffer binding offset moves. Do not invalidate the layout cache.
          if (stride > 0 && (normalized || (type !== 5121 && type !== 5122)) && (offset - o.offset) % stride === 0) {
            o.offset = offset;
            vao.offsetVersion = (vao.offsetVersion | 0) + 1;
            return;
          }
        }
        vao.layoutVersion = (vao.layoutVersion | 0) + 1;
        vao.attributes[location] = { enabled: o?.enabled, buffer, size, type, normalized, stride, offset };
      }
`);
    src = cut(src, '      vertexLayout() {', '      vertexLayoutUncached() {', `      vertexLayout() {
        const vao = this.vao, vs = this.program.vs, c = vao.layoutCache;
        if (c && c.version === vao.layoutVersion && c.vs === vs) {
          let ok = true;
          const conv = c.converted;
          for (let i = 0; i < conv.length; i += 3)
            if (this.convertedAttribute(conv[i], conv[i + 1]) !== conv[i + 2]) ok = false;
          if (ok) {
            if (c.offVer !== vao.offsetVersion) {
              // refresh binding offsets only
              const r = c.result, att = vao.attributes, phase = c.phase, slotOf = c.slotOf;
              let good = true;
              const seen = c.seen.fill(false);
              for (let l = 0; l < phase.length && good; ++l) {
                const a = att[l], nb = a.offset - phase[l], s = slotOf[l];
                if (!seen[s]) { r.bindings[s].offset = nb; seen[s] = true; }
                else if (r.bindings[s].offset !== nb) good = false;
              }
              if (good) { c.offVer = vao.offsetVersion; return r; }
            } else return c.result;
          }
        }
        const result = this.vertexLayoutUncached(), converted = [];
        const n = vs.reflection.attributes.length, phase = new Array(n), slotOf = new Array(n);
        for (let location = 0; location < n; ++location) {
          const a = vao.attributes[location];
          if (!a.normalized && (a.type === 5121 || a.type === 5122)) {
            const stride = a.stride || a.size * (a.type === 5121 ? 1 : 2);
            converted.push(a, stride, this.convertedAttribute(a, stride));
          }
        }
        // recover per-attribute phase and slot from the result: layouts[slot].attributes[].{shaderLocation,offset}
        for (let s = 0; s < result.layouts.length; ++s)
          for (const at of result.layouts[s].attributes) { phase[at.shaderLocation] = at.offset; slotOf[at.shaderLocation] = s; }
        vao.layoutCache = { version: vao.layoutVersion, vs, result, converted, phase, slotOf, offVer: vao.offsetVersion, seen: new Array(result.layouts.length).fill(false) };
        return result;
      }
`);
  }
  if (on.has('e')) {
    src = src.replace(`                this.ranges[b] = {
                  buffer: tables.buffers[c],
                  offset: d,
                  size: e,
                };`, `                {
                  const r = this.ranges[b] || (this.ranges[b] = { buffer: null, offset: 0, size: 0 });
                  r.buffer = tables.buffers[c]; r.offset = d; r.size = e;
                }`);
  }
  return src;
}
