// A thin WebGL2 layer: programs with typed uniform dispatch, float render
// targets, and the two draw shapes this app needs (a full-screen triangle for
// gather passes, a cloud of points for scatter passes).

class GLError extends Error {}

/** Every 3D field is a stack of z-slices tiled into one 2D texture. */
function atlasFor(nx, ny, nz) {
  const { tx, ty } = tileLayout(nz);
  return { nx, ny, nz, tx, ty, w: nx * tx, h: ny * ty };
}

class Gfx {
  constructor(canvas) {
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, desynchronized: true,
      powerPreference: 'high-performance', preserveDrawingBuffer: false };
    const gl = canvas.getContext('webgl2', opts);
    if (!gl) throw new GLError('This computer’s browser cannot do WebGL 2.');
    this.gl = gl;
    this.canvas = canvas;
    this.programs = new Map();
    this.owned = new Set();
    this.pending = [];
    this.adoptContext();
  }

  /**
   * Take on the drawing context: ask for the extensions this app cannot work without,
   * read its limits, and set the state that never changes afterwards.
   *
   * Called once at startup and again every time the driver resets and hands the
   * context back, because a restored context is a new one in every way that matters.
   * An extension granted to the old context is not granted to this one, and the first
   * thing to notice would be RGBA16F quietly ceasing to be renderable - an incomplete
   * framebuffer, from a line that has nothing to do with the real cause.
   */
  adoptContext() {
    const gl = this.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new GLError('This graphics card cannot render to floating point textures (EXT_color_buffer_float).');
    }
    // Lets a program be asked whether it has finished without stopping to wait for it.
    this.parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
    this.floatBlend = !!gl.getExtension('EXT_float_blend');
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    if (this.maxDrawBuffers < 4) throw new GLError('This graphics card supports too few render targets.');
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown graphics card';
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    // WebGL2 needs *some* vertex array bound; nothing is ever attached to it.
    gl.bindVertexArray(gl.createVertexArray());
  }

  /**
   * The context has gone and taken every object with it. Let the handles go without
   * deleting them: deleting an object belonging to a dead context is an error in its
   * own right, and a few hundred of those would bury whatever really went wrong.
   */
  forgetContext() {
    this.programs.clear();
    this.owned.clear();
    this.pending = [];
  }

  compile(type, src, name) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '';
      const lines = src.split('\n');
      const shown = [];
      for (const m of log.matchAll(/(\d+):(\d+)/g)) {
        const ln = Number(m[2]);
        for (let i = Math.max(1, ln - 2); i <= Math.min(lines.length, ln + 2); i++) {
          shown.push(`${i === ln ? '>' : ' '} ${String(i).padStart(4)} | ${lines[i - 1]}`);
        }
        shown.push('');
      }
      gl.deleteShader(sh);
      throw new GLError(`Shader "${name}" failed to compile:\n${log}\n${shown.join('\n')}`);
    }
    return sh;
  }

  /** Build (and cache) a program. `vs` defaults to the full-screen triangle. */
  /**
   * Build a program, but do not wait for it.
   *
   * Asking for LINK_STATUS is what makes a driver stop and finish compiling, so doing it
   * here - twenty-nine times in a row - serialises every shader in the app onto one
   * thread and gives the window nothing to show meanwhile. Instead every program is
   * queued and the answers collected later, in finishPrograms(), which lets a driver
   * compile them across as many threads as it has, and lets the page say what it is
   * doing while that happens.
   */
  program(name, fs, vs = VS_FULLSCREEN) {
    if (this.programs.has(name)) return this.programs.get(name);
    const gl = this.gl;
    const p = gl.createProgram();
    const v = this.compile(gl.VERTEX_SHADER, vs, name + ':vs');
    const f = this.compile(gl.FRAGMENT_SHADER, fs, name + ':fs');
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    const rec = { prog: p, uniforms: new Map(), name, shaders: [v, f], linked: false };
    this.programs.set(name, rec);
    this.pending.push(rec);
    return rec;
  }

  /**
   * Collect the results of everything queued by program(). `onProgress` is called with
   * (done, total, name) so the window can show what it is waiting for - which is the
   * difference between a black window and one that says which shader is slow.
   */
  finishPrograms(onProgress) {
    const gl = this.gl;
    const queue = this.pending;
    this.pending = [];
    queue.forEach((rec, i) => {
      if (onProgress) onProgress(i, queue.length, rec.name);
      if (!gl.getProgramParameter(rec.prog, gl.LINK_STATUS)) {
        throw new GLError(`Shader "${rec.name}" failed to link:\n${gl.getProgramInfoLog(rec.prog)}`);
      }
      for (const sh of rec.shaders) gl.deleteShader(sh);
      rec.shaders = null;
      rec.linked = true;
      // Remember every uniform's location and type so setUniforms can dispatch.
      const n = gl.getProgramParameter(rec.prog, gl.ACTIVE_UNIFORMS);
      for (let i2 = 0; i2 < n; i2++) {
        const info = gl.getActiveUniform(rec.prog, i2);
        const base = info.name.replace(/\[0\]$/, '');
        rec.uniforms.set(base, { loc: gl.getUniformLocation(rec.prog, info.name), type: info.type, size: info.size });
      }
    });
    if (onProgress) onProgress(queue.length, queue.length, '');
    return queue.length;
  }

  /** True once nothing is waiting to be linked. */
  get programsReady() { return this.pending.length === 0; }
  get programsPending() { return this.pending.length; }
  /** Whether the driver can be asked if a program is done without stopping to wait. */
  get canPollCompile() { return !!this.parallelCompile; }
  /** How many queued programs the driver says it has finished. Cheap; never blocks. */
  compiledCount() {
    const gl = this.gl, ext = this.parallelCompile;
    if (!ext) return 0;
    return this.pending.reduce((n, r) => n + (gl.getProgramParameter(r.prog, ext.COMPLETION_STATUS_KHR) ? 1 : 0), 0);
  }

  setUniforms(rec, values) {
    const gl = this.gl;
    let unit = 0;
    for (const [key, val] of Object.entries(values)) {
      const u = rec.uniforms.get(key);
      if (!u || val == null) continue;
      switch (u.type) {
        case gl.SAMPLER_2D:
        case gl.SAMPLER_2D_ARRAY:
        case gl.INT_SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, val.tex || val);
          gl.uniform1i(u.loc, unit);
          unit++;
          break;
        case gl.FLOAT: Array.isArray(val) ? gl.uniform1fv(u.loc, val) : gl.uniform1f(u.loc, val); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, val); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, val); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, val); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, val); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, val); break;
        case gl.INT: Array.isArray(val) ? gl.uniform1iv(u.loc, val) : gl.uniform1i(u.loc, val | 0); break;
        case gl.INT_VEC2: gl.uniform2iv(u.loc, val); break;
        case gl.INT_VEC3: gl.uniform3iv(u.loc, val); break;
        // The random seeds are unsigned. Without these cases they stay at zero,
        // and every "random" scatter comes out identical to the last one.
        case gl.UNSIGNED_INT: gl.uniform1ui(u.loc, val >>> 0); break;
        case gl.UNSIGNED_INT_VEC2: gl.uniform2uiv(u.loc, val); break;
        case gl.UNSIGNED_INT_VEC3: gl.uniform3uiv(u.loc, val); break;
        case gl.BOOL: gl.uniform1i(u.loc, val ? 1 : 0); break;
        default: break;
      }
    }
  }

  texture(w, h, { internal = 'RGBA16F', filter = 'LINEAR', wrap = 'CLAMP_TO_EDGE', data = null } = {}) {
    const gl = this.gl;
    const F = {
      RGBA16F: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
      RGBA32F: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
      RG16F: [gl.RG16F, gl.RG, gl.HALF_FLOAT],
      R16F: [gl.R16F, gl.RED, gl.HALF_FLOAT],
      R32F: [gl.R32F, gl.RED, gl.FLOAT],
      RGBA8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    }[internal];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 32-bit float textures can only be filtered where OES_texture_float_linear exists.
    const f = (internal.endsWith('32F') && !this.floatLinear) ? gl.NEAREST : gl[filter];
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl[wrap]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl[wrap]);
    gl.texImage2D(gl.TEXTURE_2D, 0, F[0], w, h, 0, F[1], F[2], data);
    const rec = { tex, w, h, internal };
    this.owned.add(rec);
    return rec;
  }

  /** Replace a rectangle of a texture. `data` is always plain Float32 (or bytes for RGBA8). */
  upload(t, data, x = 0, y = 0, w = t.w, h = t.h) {
    const gl = this.gl;
    const [fmt, type] = {
      RGBA16F: [gl.RGBA, gl.FLOAT], RGBA32F: [gl.RGBA, gl.FLOAT],
      R32F: [gl.RED, gl.FLOAT], R16F: [gl.RED, gl.FLOAT],
      RG16F: [gl.RG, gl.FLOAT], RGBA8: [gl.RGBA, gl.UNSIGNED_BYTE],
    }[t.internal];
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, fmt, type, data);
  }

  /**
   * `depth` attaches a depth buffer, which only the raster renderer wants: the ray tracer
   * works out what is in front by marching, so it has never needed one.
   */
  framebuffer(targets, { depth = false } = {}) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    let depthBuf = null;
    if (depth) {
      depthBuf = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuf);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, targets[0].w, targets[0].h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuf);
    }
    const bufs = [];
    targets.forEach((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    gl.drawBuffers(bufs);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Say which buffer, at what size, in what format. A bare status code tells
      // whoever reads the crash nothing, and these only ever fail on odd drivers
      // where reproducing it means knowing exactly what was being asked for.
      const shape = `${targets.length}x ${targets.map((t) => t.internal).join('+')} at ${targets[0].w}x${targets[0].h}`;
      throw new GLError(`Could not set up an off-screen buffer (0x${status.toString(16)}, ${shape}).`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const rec = { fb, w: targets[0].w, h: targets[0].h, n: targets.length, depth: depthBuf };
    this.owned.add(rec);
    return rec;
  }

  /** Delete one texture or framebuffer. */
  free(o) {
    if (!o || !this.owned.has(o)) return;
    if (o.depth) this.gl.deleteRenderbuffer(o.depth);
    if (o.tex) this.gl.deleteTexture(o.tex); else if (o.fb) this.gl.deleteFramebuffer(o.fb);
    this.owned.delete(o);
  }

  /** Delete every texture and framebuffer; compiled programs are kept. */
  releaseAll() { for (const o of [...this.owned]) this.free(o); }

  bind(target) {
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /** Run a fragment shader over every texel of `target`. */
  pass(target, rec, uniforms) {
    const gl = this.gl;
    this.bind(target);
    gl.useProgram(rec.prog);
    this.setUniforms(rec, uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Draw `count` points, additively blended into `target`. Used for scatter passes. */
  /**
   * Points that occlude one another, rather than adding up. This is the raster renderer's
   * one draw: every speck as a little sphere, nearest one winning.
   */
  points(target, rec, uniforms, count, { clearColour = null } = {}) {
    const gl = this.gl;
    this.bind(target);
    if (clearColour) {
      gl.clearColor(clearColour[0], clearColour[1], clearColour[2], clearColour[3]);
      gl.clearDepth(1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(rec.prog);
    this.setUniforms(rec, uniforms);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.DEPTH_TEST);
  }

  scatter(target, rec, uniforms, count, { clear = false } = {}) {
    const gl = this.gl;
    this.bind(target);
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(rec.prog);
    this.setUniforms(rec, uniforms);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.disable(gl.BLEND);
  }

  clear(target, r = 0, g = 0, b = 0, a = 0) {
    this.bind(target);
    this.gl.clearColor(r, g, b, a);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /** Draw `count` points with blending off, e.g. to write a run of particles. */
  points(target, rec, uniforms, count) {
    const gl = this.gl;
    this.bind(target);
    gl.useProgram(rec.prog);
    this.setUniforms(rec, uniforms);
    gl.drawArrays(gl.POINTS, 0, count);
  }
}

/** Covers the whole target with one oversized triangle - no vertex buffer needed. */
const VS_FULLSCREEN = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
