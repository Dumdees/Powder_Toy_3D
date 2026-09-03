// The solver. Owns every grid and particle texture and runs one pass after
// another in the order the physics demands.

/** Tunables the settings panel edits directly. SI units throughout. */
const PHYSICS = {
  gravity: 9.81,          // m/s^2
  timeScale: 1.0,
  substeps: 2,
  iterations: 40,         // pressure sweeps per substep
  flip: 0.95,             // 1 = pure FLIP (lively), 0 = pure PIC (syrupy)
  affine: 0.85,           // how much of the APIC affine field to carry
  pack: 1.0,              // strength of the anti-clumping volume correction
  packLimit: 1.25,        // fill fraction above which particles are nudged apart
  separate: 5.0,          // how fast that nudge acts, cells per second
  tension: 1.0,           // multiplier on each material's surface tension
  granular: 1.0,          // multiplier on the Coulomb yield stress
  yieldFloor: 1.2,        // strain rate below which grains behave as a stiff solid (1/s)
  cohesion: 4.0,          // turns each material's cohesion into a stress
  pressFloor: 0.9,        // a grain's own weight, so surface grains still have grip
  fricCap: 55,            // largest frictional deceleration, m/s^2
  cohesionAccel: 26,      // how strongly sticky powders hold together, m/s^2
  maxAccel: 260,          // cap on the plastic acceleration, m/s^2
  buoyancy: 0.45,         // multiplier on the Boussinesq term
  viscScale: 1.0,
  heatScale: 900,         // conduction is scaled onto a human timescale
  heatCouple: 9,          // how fast a particle equalises with its cell
  radiate: 1.0,
  latent: 0.55,           // seconds a particle must sit past a threshold to change
  ambient: 20,            // degrees C
  drag: 0.02,
  restitution: 0.12,
  wallFriction: 0.88,
};

const QUALITY = {
  low:    { grid: 48, particles: 1 << 16, iterations: 24, substeps: 2, scale: 0.55, photons: 128 },
  medium: { grid: 64, particles: 1 << 17, iterations: 36, substeps: 2, scale: 0.75, photons: 192 },
  high:   { grid: 64, particles: 1 << 18, iterations: 48, substeps: 3, scale: 1.0,  photons: 256 },
  ultra:  { grid: 80, particles: 1 << 18, iterations: 64, substeps: 3, scale: 1.0,  photons: 320 },
};

const COARSE_SCALE = 4;

class Sim {
  constructor(gfx, { grid = 64, particles = 1 << 17, boxMetres = 2.56 } = {}) {
    this.gfx = gfx;
    const n = grid;
    this.n = atlasFor(n, n, n);
    this.dx = boxMetres / n;
    this.boxMetres = boxMetres;

    const cn = Math.ceil(n / COARSE_SCALE);
    this.coarseN = atlasFor(cn, cn, cn);

    // Particle pool laid out as a texture, as square as we can make it.
    this.capacity = particles;
    this.pw = Math.min(2048, 1 << Math.ceil(Math.log2(Math.sqrt(particles))));
    this.ph = Math.ceil(particles / this.pw);
    this.capacity = this.pw * this.ph;
    this.used = 0;
    this.head = 0;          // where the next flowing particle goes
    this.solidTop = 0;      // slots below this hold fixed scenery and are never reused
    this.activeCount = 0;
    this.time = 0;
    this.emitters = [];
    this.spawnCarry = new Map();

    this.gridUniforms = {
      uGrid: [this.n.nx, this.n.ny, this.n.nz],
      uTiles: [this.n.tx, this.n.ty],
      uAtlas: [this.n.w, this.n.h],
    };

    this.#allocate();
    this.#compile();
  }

  #allocate() {
    const g = this.gfx;
    const A = this.n;
    const grid = (fmt = 'RGBA16F') => g.texture(A.w, A.h, { internal: fmt });
    const part = () => g.texture(this.pw, this.ph, { internal: 'RGBA32F', filter: 'NEAREST' });

    this.matTex = g.texture(MAT_ROWS, MAT_COUNT, { internal: 'RGBA32F', filter: 'NEAREST', data: packMaterials() });

    this.gMom = grid(); this.gHeat = grid(); this.gGran = grid();
    this.fbP2G = g.framebuffer([this.gMom, this.gHeat, this.gGran]);

    this.gVel = [grid(), grid()];
    this.gPre = grid();
    this.gAux = [grid(), grid()];
    this.gProp = grid();
    this.gNorm = grid();
    this.gTau = [grid(), grid()];
    this.fbPrep = g.framebuffer([this.gVel[0], this.gPre, this.gAux[0], this.gProp]);
    this.fbVel = this.gVel.map((t) => g.framebuffer([t]));
    this.fbAux = this.gAux.map((t) => g.framebuffer([t]));
    this.fbNorm = g.framebuffer([this.gNorm]);
    this.fbTau = g.framebuffer(this.gTau);

    this.gPress = [grid('R32F'), grid('R32F')];
    this.fbPress = this.gPress.map((t) => g.framebuffer([t]));
    this.gDiv = grid('R32F');
    this.fbDiv = g.framebuffer([this.gDiv]);

    this.pPos = [part(), part()];
    this.pVel = [part(), part()];
    this.pAux = [part(), part()];
    this.fbPart = [0, 1].map((i) => g.framebuffer([this.pPos[i], this.pVel[i], this.pAux[i]]));
    this.pC = [[grid0(g, this.pw, this.ph), grid0(g, this.pw, this.ph), grid0(g, this.pw, this.ph)],
               [grid0(g, this.pw, this.ph), grid0(g, this.pw, this.ph), grid0(g, this.pw, this.ph)]];
    this.fbC = this.pC.map((set) => g.framebuffer(set));
    this.pi = 0;

    // Fields the renderer marches through, plus a scratch copy for the blur.
    this.rF = [[grid(), grid(), grid(), grid()], [grid(), grid(), grid(), grid()]];
    this.fbR = this.rF.map((set) => g.framebuffer(set));
    this.ri = 0;

    this.coarse = g.texture(this.coarseN.w, this.coarseN.h, { internal: 'R16F', filter: 'NEAREST' });
    this.fbCoarse = g.framebuffer([this.coarse]);

    // Counting how many particles are still in play.
    this.countLevels = [];
    let w = this.pw >> 1, h = Math.max(1, this.ph >> 1);
    while (w > 4 || h > 4) {
      const t = g.texture(w, h, { internal: 'R32F', filter: 'NEAREST' });
      this.countLevels.push({ tex: t, fb: g.framebuffer([t]), w, h });
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    const t = g.texture(Math.max(1, w), Math.max(1, h), { internal: 'R32F', filter: 'NEAREST' });
    this.countLevels.push({ tex: t, fb: g.framebuffer([t]), w: Math.max(1, w), h: Math.max(1, h) });
    this.countPixels = new Float32Array(4 * 4 * 4);
  }

  #compile() {
    const g = this.gfx;
    this.progP2G = g.program('p2g', P2G_FS, P2G_VS);
    this.progPrep = g.program('prep', GRID_PREP_FS);
    this.progHeat = g.program('heat', HEAT_FS);
    this.progVisc = g.program('visc', VISC_FS);
    this.progStress = g.program('stress', STRESS_FS);
    this.progPlastic = g.program('plastic', PLASTIC_FS);
    this.progNormal = g.program('normal', NORMAL_FS);
    this.progTension = g.program('tension', TENSION_FS);
    this.progDiv = g.program('div', DIV_FS);
    this.progPressure = g.program('pressure', PRESSURE_FS);
    this.progProject = g.program('project', PROJECT_FS);
    this.progExtrap = g.program('extrap', EXTRAP_FS);
    this.progG2P = g.program('g2p', G2P_FS);
    this.progG2PC = g.program('g2pc', G2P_C_FS);
    this.progEmit = g.program('emit', EMIT_FS, EMIT_VS);
    this.progEmitZero = g.program('emitzero', EMIT_ZERO_FS, EMIT_VS);
    this.progRSplat = g.program('rsplat', RSPLAT_FS, RSPLAT_VS);
    this.progRBlur = g.program('rblur', RBLUR_FS);
    this.progCoarse = g.program('coarse', COARSE_FS);
    this.progCount = g.program('count', COUNT_FS);
  }

  get base() {
    return { ...this.gridUniforms, uMat: this.matTex, uPTex: [this.pw, this.ph], uDx: this.dx };
  }

  /** Wipe every particle and field. */
  clear() {
    const g = this.gfx;
    for (const fb of [...this.fbPart, ...this.fbC, ...this.fbPress, ...this.fbR]) g.clear(fb);
    for (const fb of [...this.fbVel, ...this.fbAux, this.fbNorm, this.fbDiv, this.fbCoarse]) g.clear(fb);
    this.used = 0;
    this.head = 0;
    this.solidTop = 0;
    this.activeCount = 0;
    this.time = 0;
    this.emitters = [];
    this.spawnCarry.clear();
  }

  /** Load a scene: upload its particles, remember its emitters. */
  load(scene) {
    this.clear();
    const built = buildParticles(scene, this.n.nx, this.n.ny, this.n.nz, this.capacity);
    this.emitters = built.emitters.map((e) => ({ ...e }));
    this.perCell = built.perCell;
    if (built.count > 0) {
      const rows = Math.ceil(built.count / this.pw);
      const pad = (src) => {
        const out = new Float32Array(rows * this.pw * 4);
        out.set(src.subarray(0, Math.min(src.length, out.length)));
        return out;
      };
      this.gfx.upload(this.pPos[this.pi], pad(built.pos), 0, 0, this.pw, rows);
      this.gfx.upload(this.pVel[this.pi], pad(built.vel), 0, 0, this.pw, rows);
      this.gfx.upload(this.pAux[this.pi], pad(built.aux), 0, 0, this.pw, rows);
    }
    this.used = Math.min(this.capacity, Math.ceil(built.count / this.pw) * this.pw);
    this.solidTop = Math.min(built.rigidCount, Math.floor(this.capacity * 0.7));
    this.head = Math.max(built.count % this.capacity, this.solidTop);
    this.activeCount = built.count;
    return built;
  }

  /**
   * Write a burst of particles into the pool.
   * Fixed materials are stacked at the bottom and kept; everything that flows
   * goes into a ring above them, so a spout running for ten minutes recycles its
   * own old water rather than eating the walls somebody built.
   */
  spawn({ mat, pos, radius, vel = [0, 0, 0], count, temp = null, volume = null, jitter = 0.15 }) {
    let n = Math.min(Math.floor(count), this.capacity);
    if (n <= 0 || mat <= 0) return 0;
    const m = MATERIALS[mat];
    const rigid = m.phase === PHASE.RIGID;
    const perCell = rigid ? 2 : (this.perCell || 4);
    let base, ringStart, ringSize;
    if (rigid) {
      const limit = Math.floor(this.capacity * 0.7);
      n = Math.min(n, Math.max(0, limit - this.solidTop));
      if (n === 0) return 0;
      base = this.solidTop;
      ringStart = 0;
      ringSize = this.capacity;
    } else {
      ringStart = this.solidTop;
      ringSize = Math.max(1, this.capacity - this.solidTop);
      base = Math.max(this.head, ringStart);
    }
    const u = {
      ...this.base,
      uBase: base,
      uRingStart: ringStart,
      uRingSize: ringSize,
      uSpawnPos: pos,
      uSpawnVel: vel,
      uSpawnRadius: radius,
      uSpawnMat: mat,
      uSpawnTemp: temp == null ? m.temp : temp,
      uSpawnVolume: volume == null ? 1 / perCell : volume,
      uJitter: jitter,
      uSeed: (Math.random() * 0xffffffff) >>> 0,
    };
    this.gfx.points(this.fbPart[this.pi], this.progEmit, u, n);
    this.gfx.points(this.fbC[this.pi], this.progEmitZero, u, n);
    if (rigid) {
      this.solidTop += n;
      this.head = Math.max(this.head, this.solidTop);
      this.used = Math.max(this.used, this.solidTop);
    } else {
      const end = base + n;
      this.head = ringStart + ((end - ringStart) % ringSize);
      this.used = end >= this.capacity ? this.capacity : Math.max(this.used, end);
    }
    return n;
  }

  /** Run the scene's own spouts for this frame, carrying fractional counts over. */
  runEmitters(dt) {
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      const carry = (this.spawnCarry.get(i) || 0) + e.rate * dt;
      const n = Math.floor(carry);
      this.spawnCarry.set(i, carry - n);
      if (n > 0) {
        this.spawn({
          mat: matId(e.mat),
          pos: [e.at[0] * this.n.nx, e.at[1] * this.n.ny, e.at[2] * this.n.nz],
          radius: e.radius,
          vel: e.vel,
          count: n,
          jitter: 0.25,
        });
      }
    }
  }

  /** One substep of the whole pipeline. */
  step(dt, brush) {
    const g = this.gfx;
    const P = PHYSICS;
    const b = this.base;
    const points = Math.max(8, this.used * 8);

    // 1. particles -> grid
    g.clear(this.fbP2G);
    g.scatter(this.fbP2G, this.progP2G, {
      ...b, uPos: this.pPos[this.pi], uVel: this.pVel[this.pi], uAux: this.pAux[this.pi],
      uC0: this.pC[this.pi][0], uC1: this.pC[this.pi][1], uC2: this.pC[this.pi][2],
      uAffine: P.affine,
    }, points);

    // 2. average, mark solids, apply weight
    g.pass(this.fbPrep, this.progPrep, {
      ...b, uMom: this.gMom, uHeat: this.gHeat, uGran: this.gGran,
      uDt: dt, uGravity: P.gravity, uAmbient: P.ambient, uDrag: P.drag,
    });
    let vi = 0, ai = 0;

    // 3. conduction
    for (let i = 0; i < 2; i++) {
      g.pass(this.fbAux[1 - ai], this.progHeat, {
        ...b, uAux: this.gAux[ai], uDt: dt, uAmbient: P.ambient,
        uHeatScale: P.heatScale, uRadiate: P.radiate,
      });
      ai = 1 - ai;
    }

    // 4. viscosity
    for (let i = 0; i < 2; i++) {
      g.pass(this.fbVel[1 - vi], this.progVisc, {
        ...b, uVel: this.gVel[vi], uAux: this.gAux[ai], uDt: dt, uViscScale: P.viscScale,
      });
      vi = 1 - vi;
    }

    // 5. surface tension
    if (P.tension > 0) {
      g.pass(this.fbNorm, this.progNormal, { ...b, uAux: this.gAux[ai] });
      g.pass(this.fbVel[1 - vi], this.progTension, {
        ...b, uVel: this.gVel[vi], uAux: this.gAux[ai], uProp: this.gProp, uNorm: this.gNorm,
        uDt: dt, uTension: P.tension,
      });
      vi = 1 - vi;
    }

    // 6. make it incompressible
    g.pass(this.fbDiv, this.progDiv, { ...b, uVel: this.gVel[vi], uAux: this.gAux[ai], uPack: P.pack });
    let pi = 0;
    for (let i = 0; i < P.iterations; i++) {
      g.pass(this.fbPress[1 - pi], this.progPressure, {
        ...b, uPress: this.gPress[pi], uVel: this.gVel[vi], uAux: this.gAux[ai], uDiv: this.gDiv,
        uDt: dt, uParity: i & 1,
      });
      pi = 1 - pi;
    }
    if (pi !== 0) {   // leave the answer in slot 0 so the next step can warm-start
      g.pass(this.fbPress[0], this.progPressure, {
        ...b, uPress: this.gPress[1], uVel: this.gVel[vi], uAux: this.gAux[ai], uDiv: this.gDiv,
        uDt: dt, uParity: 2,
      });
    }
    g.pass(this.fbVel[1 - vi], this.progProject, {
      ...b, uVel: this.gVel[vi], uAux: this.gAux[ai], uPress: this.gPress[0], uDt: dt,
    });
    vi = 1 - vi;

    // 7. grains yield. Coulomb friction acts on the velocity the pressure solve
    // actually produced, which is what lets a heap of sand stand up.
    if (P.granular > 0) {
      g.pass(this.fbTau, this.progStress, {
        ...b, uVel: this.gVel[vi], uAux: this.gAux[ai], uProp: this.gProp, uPress: this.gPress[0],
        uGranular: P.granular, uYieldFloor: P.yieldFloor, uCohesion: P.cohesion,
      });
      g.pass(this.fbVel[1 - vi], this.progPlastic, {
        ...b, uVel: this.gVel[vi], uAux: this.gAux[ai], uT0: this.gTau[0], uT1: this.gTau[1],
        uDt: dt, uMaxAccel: P.maxAccel,
      });
      vi = 1 - vi;
    }
    for (let i = 0; i < 2; i++) {
      g.pass(this.fbVel[1 - vi], this.progExtrap, { ...b, uVel: this.gVel[vi], uAux: this.gAux[ai] });
      vi = 1 - vi;
    }

    // 8. grid -> particles, and move them
    const on = brush && brush.active ? 1 : 0;
    g.pass(this.fbPart[1 - this.pi], this.progG2P, {
      ...b,
      uPos: this.pPos[this.pi], uVel: this.pVel[this.pi], uAux: this.pAux[this.pi],
      uGVel: this.gVel[vi], uGPre: this.gPre, uGAux: this.gAux[ai], uGPress: this.gPress[0],
      uDt: dt, uGravity: P.gravity, uAmbient: P.ambient, uFlip: P.flip,
      uBuoyancy: P.buoyancy, uLatent: P.latent, uHeatCouple: P.heatCouple,
      uRestitution: P.restitution, uWallFriction: P.wallFriction, uPackLimit: P.packLimit, uSeparate: P.separate,
      uGranular: P.granular, uPressFloor: P.pressFloor, uFricCap: P.fricCap, uCohesionAccel: P.cohesionAccel,
      uBrushOn: on, uBrushTool: on ? brush.tool : 0,
      uBrushPos: on ? brush.pos : [0, 0, 0],
      uBrushVel: on ? brush.vel : [0, 0, 0],
      uBrushRadius: on ? brush.radius : 0,
      uBrushStrength: on ? brush.strength : 0,
      uSeed: (Math.random() * 0xffffffff) >>> 0,
    });
    g.pass(this.fbC[1 - this.pi], this.progG2PC, {
      ...b, uPos: this.pPos[1 - this.pi], uGVel: this.gVel[vi], uCClamp: 6.0,
    });
    this.pi = 1 - this.pi;
    this.velIdx = vi;
    this.auxIdx = ai;
    this.time += dt;
  }

  /** Rebuild the fields the renderer needs, and the block map that speeds it up. */
  buildRenderFields() {
    const g = this.gfx;
    const b = this.base;
    g.clear(this.fbR[0]);
    g.scatter(this.fbR[0], this.progRSplat, {
      ...b, uPos: this.pPos[this.pi], uVel: this.pVel[this.pi], uAux: this.pAux[this.pi],
    }, Math.max(8, this.used * 8));
    let i = 0;
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let round = 0; round < Math.max(1, RENDER.smoothing); round++) {
      for (const step of axes) {
        const src = this.rF[i];
        g.pass(this.fbR[1 - i], this.progRBlur, {
          ...b, uA: src[0], uB: src[1], uC: src[2], uD: src[3], uStep: step,
        });
        i = 1 - i;
      }
    }
    this.ri = i;
    g.pass(this.fbCoarse, this.progCoarse, {
      ...b, uSrc: this.rF[i][3],
      uCGrid: [this.coarseN.nx, this.coarseN.ny, this.coarseN.nz],
      uCTiles: [this.coarseN.tx, this.coarseN.ty],
      uScale: COARSE_SCALE,
    });
  }

  fields() { return this.rF[this.ri]; }

  coarseUniforms() {
    return {
      uCoarse: this.coarse,
      uCGrid: [this.coarseN.nx, this.coarseN.ny, this.coarseN.nz],
      uCTiles: [this.coarseN.tx, this.coarseN.ty],
      uCAtlas: [this.coarseN.w, this.coarseN.h],
      uCoarseScale: COARSE_SCALE,
    };
  }

  /** Count how many slots still hold something, by repeated halving. */
  measure() {
    const g = this.gfx;
    let src = this.pPos[this.pi];
    let first = 1;
    for (const lvl of this.countLevels) {
      g.pass(lvl.fb, this.progCount, { uSrc: src, uFirst: first, uSize: [lvl.w * 2, lvl.h * 2] });
      src = lvl.tex;
      first = 0;
    }
    const last = this.countLevels[this.countLevels.length - 1];
    g.bind(last.fb);
    const px = new Float32Array(last.w * last.h * 4);
    g.gl.readPixels(0, 0, last.w, last.h, g.gl.RGBA, g.gl.FLOAT, px);
    let total = 0;
    for (let i = 0; i < last.w * last.h; i++) total += px[i * 4];
    this.activeCount = Math.round(total);
    return this.activeCount;
  }
}

/** A particle-sized RGBA32F texture (used for the affine field). */
function grid0(g, w, h) { return g.texture(w, h, { internal: 'RGBA32F', filter: 'NEAREST' }); }

/** Sums a 2x2 block; the first level turns "is this slot in use" into a 1 or a 0. */
const COUNT_FS = GLSL_HEAD + `
uniform sampler2D uSrc;
uniform int uFirst;
uniform vec2 uSize;
out vec4 oSum;
float take(ivec2 t) {
  if (float(t.x) >= uSize.x || float(t.y) >= uSize.y) return 0.0;
  vec4 v = texelFetch(uSrc, t, 0);
  return uFirst == 1 ? (v.w > 0.5 ? 1.0 : 0.0) : v.x;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy) * 2;
  oSum = vec4(take(t) + take(t + ivec2(1, 0)) + take(t + ivec2(0, 1)) + take(t + ivec2(1, 1)), 0.0, 0.0, 1.0);
}`;
