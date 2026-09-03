// The renderer: sets the camera up, traces the frame, folds it into the running
// average, adds bloom and puts it on the screen. Also owns the caustic volume
// and the one-pixel pass that works out what is under the pointer.

const RENDER = {
  scale: 0.75,          // resolution the tracer runs at, relative to the window
  smoothing: 3,         // rounds of blur over the fields before they are traced
  exposure: 0.9,
  bloom: 0.45,
  vignette: 0.32,
  reflections: true,
  refraction: true,
  shadows: true,
  caustics: true,
  gas: true,
  accumulate: true,
  surfSteps: 160,
  shadowSteps: 40,
  surfStep: 0.55,
  clarity: 3.0,         // multiplier on Beer-Lambert absorption
  shadowSigma: 2.6,
  gasSigma: 1.9,
  glowGain: 0.30,
  reflectGain: 1.0,
  sunElevation: 46,     // degrees above the horizon
  sunAzimuth: 38,       // degrees around
  sunIntensity: 3.7,
  skyGain: 0.85,
  turbidity: 0.35,
  fov: 42,              // degrees, vertical
  photons: 192,
  view: 0,              // 0 beauty, then the inspection views in VIEWS
};

const VIEWS = ['Finished picture', 'Material colour', 'Surface normals', 'Temperature',
  'Speed', 'Sunlight reaching', 'Caustics', 'Pressure', 'Fill fraction'];

/** Where the ray under the pointer lands, so the brush can sit on the surface. */
const PICK_FS = GLSL_HEAD + GLSL_COMMON + RAY_LIB + `
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform vec2 uPickUV;
out vec4 oPick;
void main() {
  vec2 uv = uPickUV * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * uv.x + uCamUp * uv.y);
  vec2 br = boxRange(uCamPos, rd, boxLo(), boxHi());
  float t0 = max(br.x, 0.0);
  if (br.y > t0) {
    Hit h = marchSurface(uCamPos, rd, t0, br.y);
    if (h.hit) { oPick = vec4(uCamPos + rd * h.t, 1.0); return; }
  }
  oPick = vec4(uCamPos + rd * max(t0, 0.0), 0.0);
}`;

class Renderer {
  constructor(gfx, sim) {
    this.gfx = gfx;
    this.sim = sim;
    this.frame = 0;
    this.width = 0;
    this.height = 0;
    this.pickResult = { pos: [0, 0, 0], hit: false };
    this.#compile();
    this.#allocVolumes();
  }

  #compile() {
    const g = this.gfx;
    this.progTrace = g.program('trace', TRACE_FS);
    this.progAccum = g.program('accum', ACCUM_FS);
    this.progBright = g.program('bright', BRIGHT_FS);
    this.progBlur = g.program('bloomblur', BLOOM_BLUR_FS);
    this.progComposite = g.program('composite', COMPOSITE_FS);
    this.progPhoton = g.program('photon', PHOTON_FS);
    this.progPhotonSplat = g.program('photonsplat', PHOTON_SPLAT_FS, PHOTON_SPLAT_VS);
    this.progCausticBlur = g.program('causticblur', CAUSTIC_BLUR_FS);
    this.progPick = g.program('pick', PICK_FS);
  }

  #allocVolumes() {
    const g = this.gfx;
    const A = this.sim.n;
    const vol = () => g.texture(A.w, A.h, { internal: 'R16F' });
    this.cSplat = vol(); this.cTmpA = vol(); this.cTmpB = vol();
    this.caustic = [vol(), vol()];
    this.ci = 0;
    this.fbSplat = g.framebuffer([this.cSplat]);
    this.fbTmpA = g.framebuffer([this.cTmpA]);
    this.fbTmpB = g.framebuffer([this.cTmpB]);
    this.fbCaustic = this.caustic.map((t) => g.framebuffer([t]));
    this.zero = g.texture(1, 1, { internal: 'R16F' });

    this.pick = g.texture(1, 1, { internal: 'RGBA32F', filter: 'NEAREST' });
    this.fbPick = g.framebuffer([this.pick]);
    g.clear(this.fbPick);
    for (const fb of [this.fbSplat, this.fbTmpA, this.fbTmpB, ...this.fbCaustic]) g.clear(fb);
    this.pickBuf = new Float32Array(4);
    this.#photonSize(RENDER.photons);
  }

  #photonSize(n) {
    const g = this.gfx;
    if (this.photonN === n) return;
    this.photonN = n;
    if (this.photonTex) this.gfx.gl.deleteTexture(this.photonTex.tex);
    this.photonTex = g.texture(n, n, { internal: 'RGBA32F', filter: 'NEAREST' });
    this.fbPhoton = g.framebuffer([this.photonTex]);
  }

  resize(width, height) {
    const g = this.gfx;
    const w = Math.max(64, Math.round(width * RENDER.scale));
    const h = Math.max(64, Math.round(height * RENDER.scale));
    if (w === this.width && h === this.height) return;
    for (const o of this.sized || []) g.free(o);
    this.sized = [];
    this.width = w;
    this.height = h;
    const hdr = () => { const t = g.texture(w, h, { internal: 'RGBA16F' }); this.sized.push(t); return t; };
    this.hdr = hdr();
    this.history = [hdr(), hdr()];
    this.hi = 0;
    this.fbHDR = g.framebuffer([this.hdr]);
    this.fbHistory = this.history.map((t) => g.framebuffer([t]));
    this.sized.push(this.fbHDR, ...this.fbHistory);
    this.bloom = [];
    let bw = Math.max(4, w >> 1), bh = Math.max(4, h >> 1);
    for (let i = 0; i < 4; i++) {
      const a = g.texture(bw, bh, { internal: 'RGBA16F' });
      const b = g.texture(bw, bh, { internal: 'RGBA16F' });
      const lvl = { a, b, fa: g.framebuffer([a]), fb: g.framebuffer([b]), w: bw, h: bh };
      this.sized.push(a, b, lvl.fa, lvl.fb);
      this.bloom.push(lvl);
      bw = Math.max(4, bw >> 1);
      bh = Math.max(4, bh >> 1);
    }
    this.reset();
  }

  reset() { this.frame = 0; }

  sunDirection() {
    const e = RENDER.sunElevation * Math.PI / 180;
    const a = RENDER.sunAzimuth * Math.PI / 180;
    return v3norm([Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]);
  }

  /** Everything the ray library needs, gathered once per frame. */
  sceneUniforms() {
    const sim = this.sim;
    const f = sim.fields();
    const sun = this.sunDirection();
    const warm = Math.max(0, 1 - Math.max(RENDER.sunElevation, 0) / 60);
    return {
      ...sim.gridUniforms,
      uFA: f[0], uFB: f[1], uFC: f[2], uFD: f[3],
      ...sim.coarseUniforms(),
      uCaustic: RENDER.caustics ? this.caustic[this.ci] : this.zero,
      uIso: 0.5,
      uDx: sim.dx,
      uClarity: RENDER.clarity,
      uShadowSigma: RENDER.shadowSigma,
      uGasSigma: RENDER.gasSigma,
      uGlowGain: RENDER.glowGain,
      uFloorY: 1.0,
      uDoShadows: RENDER.shadows ? 1 : 0,
      uDoReflect: RENDER.reflections ? 1 : 0,
      uDoRefract: RENDER.refraction ? 1 : 0,
      uDoCaustics: RENDER.caustics ? 1 : 0,
      uDoGas: RENDER.gas ? 1 : 0,
      uSurfSteps: RENDER.surfSteps,
      uShadowSteps: RENDER.shadowSteps,
      uSurfStep: RENDER.surfStep,
      uSunDir: sun,
      uSunColour: [
        RENDER.sunIntensity * (1 + warm * 0.5),
        RENDER.sunIntensity * (1 - warm * 0.18),
        RENDER.sunIntensity * (1 - warm * 0.45),
      ],
      uSkyGain: RENDER.skyGain,
      uTurbidity: RENDER.turbidity,
      uFrameSeed: (this.frame * 2654435761) >>> 0,
      uGVel: sim.gVel[sim.velIdx || 0],
      uGAux: sim.gAux[sim.auxIdx || 0],
      uPress: sim.gPress[0],
      uView: RENDER.view,
    };
  }

  /** Trace photons from the sun through every water surface and drop them where they land. */
  updateCaustics(scene) {
    if (!RENDER.caustics) return;
    const g = this.gfx;
    this.#photonSize(RENDER.photons);
    g.pass(this.fbPhoton, this.progPhoton, {
      ...scene, uPhotonRes: [this.photonN, this.photonN], uSeed: this.frame >>> 0,
    });
    // Photon energy is spread over the box, so the gain follows the photon count.
    const cells = this.sim.n.nx * this.sim.n.ny * this.sim.n.nz;
    const gain = 0.55 * cells / (this.photonN * this.photonN * 26);
    g.scatter(this.fbSplat, this.progPhotonSplat, {
      ...this.sim.gridUniforms, uDrops: this.photonTex,
      uPhotonSize: [this.photonN, this.photonN], uPhotonGain: gain,
    }, this.photonN * this.photonN, { clear: true });
    const b = this.sim.gridUniforms;
    g.pass(this.fbTmpA, this.progCausticBlur, { ...b, uSrc: this.cSplat, uPrev: this.zero, uStep: [1, 0, 0], uBlend: 0 });
    g.pass(this.fbTmpB, this.progCausticBlur, { ...b, uSrc: this.cTmpA, uPrev: this.zero, uStep: [0, 1, 0], uBlend: 0 });
    g.pass(this.fbCaustic[1 - this.ci], this.progCausticBlur, {
      ...b, uSrc: this.cTmpB, uPrev: this.caustic[this.ci], uStep: [0, 0, 1], uBlend: 0.35,
    });
    this.ci = 1 - this.ci;
  }

  cameraUniforms(cam, aspect) {
    const fwd = v3norm(v3sub(cam.target, cam.position));
    const tan = Math.tan(RENDER.fov * Math.PI / 360);
    let right = v3cross(fwd, [0, 1, 0]);
    if (v3len(right) < 1e-5) right = v3cross(fwd, [0, 0, 1]);
    right = v3norm(right);
    const up = v3cross(right, fwd);
    return {
      uCamPos: cam.position,
      uCamFwd: fwd,
      uCamRight: v3scale(right, tan * aspect),
      uCamUp: v3scale(up, tan),
    };
  }

  /** One pixel, traced through the cursor, so the brush knows where it is. */
  pickAt(scene, cam, aspect, uv) {
    const g = this.gfx;
    g.bind(this.fbPick);
    g.gl.readPixels(0, 0, 1, 1, g.gl.RGBA, g.gl.FLOAT, this.pickBuf);
    this.pickResult = { pos: [this.pickBuf[0], this.pickBuf[1], this.pickBuf[2]], hit: this.pickBuf[3] > 0.5 };
    g.pass(this.fbPick, this.progPick, {
      ...scene, ...this.cameraUniforms(cam, aspect), uPickUV: uv,
    });
    return this.pickResult;
  }

  draw(scene, cam, aspect, brush, settled) {
    const g = this.gfx;
    const jitter = [halton(this.frame + 1, 2) - 0.5, halton(this.frame + 1, 3) - 0.5];
    g.pass(this.fbHDR, this.progTrace, {
      ...scene, ...this.cameraUniforms(cam, aspect),
      uRes: [this.width, this.height],
      uJitter: jitter,
      uReflectGain: RENDER.reflectGain,
    });

    // Temporal accumulation: converge hard when nothing is moving, gently when it is.
    const blend = !RENDER.accumulate ? 1 : (settled ? Math.max(0.06, 1 / (this.frame + 1)) : 0.42);
    g.pass(this.fbHistory[1 - this.hi], this.progAccum, {
      uNew: this.hdr, uHistory: this.frame === 0 ? this.hdr : this.history[this.hi], uBlend: this.frame === 0 ? 1 : blend,
    });
    this.hi = 1 - this.hi;
    const lit = this.history[this.hi];

    // Bloom
    let src = lit;
    let srcSize = [this.width, this.height];
    for (let i = 0; i < this.bloom.length; i++) {
      const lvl = this.bloom[i];
      g.pass(lvl.fa, this.progBright, {
        uSrc: src, uSrcSize: srcSize, uThreshold: i === 0 ? 1.0 : 0.0, uExposure: i === 0 ? RENDER.exposure : 1,
      });
      g.pass(lvl.fb, this.progBlur, { uSrc: lvl.a, uTexel: [1 / lvl.w, 0] });
      g.pass(lvl.fa, this.progBlur, { uSrc: lvl.b, uTexel: [0, 1 / lvl.h] });
      src = lvl.a;
      srcSize = [lvl.w, lvl.h];
    }

    g.bind(null);
    g.gl.useProgram(this.progComposite.prog);
    g.setUniforms(this.progComposite, {
      uHDR: lit,
      uBloom: this.bloom[1].a,
      uBloomWide: this.bloom[this.bloom.length - 1].a,
      uRes: [g.canvas.width, g.canvas.height],
      uExposure: RENDER.exposure,
      uBloomGain: RENDER.bloom,
      uVignette: RENDER.vignette,
      ...this.cameraUniforms(cam, aspect),
      uBrushShow: brush.show ? 1 : 0,
      uBrushPos: brush.pos,
      uBrushRadius: brush.radius,
      uBrushTint: brush.tint,
    });
    g.gl.drawArrays(g.gl.TRIANGLES, 0, 3);
    this.frame++;
  }
}
