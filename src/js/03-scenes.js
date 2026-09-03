// Starting arrangements. A scene paints regions of the box with materials and
// may register continuous emitters (a spout, a volcano vent, rainfall).
//
// All coordinates are normalised to the box: 0..1 on each axis, y up.

/** Collects regions, then turns them into particles packed cell by cell. */
function makeSceneBuilder() {
  const regions = [];
  const emitters = [];
  return {
    regions, emitters,
    box(mat, lo, hi, opt) { regions.push({ mat, kind: 'box', lo, hi, ...opt }); return this; },
    sphere(mat, c, r, opt) { regions.push({ mat, kind: 'sphere', c, r, ...opt }); return this; },
    shape(mat, fn, opt) { regions.push({ mat, kind: 'fn', fn, ...opt }); return this; },
    /** at: normalised centre, radius: cells, vel: m/s, rate: particles per second. */
    emit(mat, at, radius, vel, rate) { emitters.push({ mat, at, radius, vel, rate }); return this; },
  };
}

function regionHit(r, x, y, z) {
  if (r.kind === 'box') {
    return x >= r.lo[0] && x <= r.hi[0] && y >= r.lo[1] && y <= r.hi[1] && z >= r.lo[2] && z <= r.hi[2];
  }
  if (r.kind === 'sphere') return Math.hypot(x - r.c[0], y - r.c[1], z - r.c[2]) <= r.r;
  return r.fn(x, y, z);
}

/**
 * Turn a scene into particle data ready to upload.
 * `pos` is xyz in cell units with the material id in w; `vel` is xyz m/s with
 * the temperature in w; `aux` is (life left, random seed, phase progress, volume).
 *
 * Volume is measured in whole cells, so a cell packed with four particles gives
 * each of them 0.25. Carrying it per particle means the rest density of a cell is
 * simply the material density however finely (or coarsely) it happens to be filled.
 */
function buildParticles(scene, nx, ny, nz, capacity, rand = Math.random) {
  const b = makeSceneBuilder();
  scene.build(b);
  const regions = b.regions;
  const cells = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) / nx, y = (j + 0.5) / ny, z = (k + 0.5) / nz;
        for (let r = regions.length - 1; r >= 0; r--) {
          if (regionHit(regions[r], x, y, z)) { cells.push(i, j, k, r); break; }
        }
      }
    }
  }
  const cellCount = cells.length / 4;
  // Leave a third of the pool free so there is room to paint more in.
  const budget = Math.max(1, Math.floor(capacity * 0.66));
  const perCell = cellCount ? clamp(Math.floor(budget / cellCount), 1, 8) : 4;
  const count = Math.min(capacity, cellCount * perCell);
  const pos = new Float32Array(count * 4);
  const vel = new Float32Array(count * 4);
  const aux = new Float32Array(count * 4);
  // Stratified 2x2x2 offsets so particles start evenly spread inside each cell.
  const off = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  let n = 0;
  // Two passes: fixed scenery first, so it lands in the low slots the pool never
  // recycles. Walls you built should not vanish because a spout has been running.
  let rigidCount = 0;
  for (const wantRigid of [true, false]) {
    for (let c = 0; c < cellCount && n < count; c++) {
      const i = cells[c * 4], j = cells[c * 4 + 1], k = cells[c * 4 + 2];
      const region = regions[cells[c * 4 + 3]];
      const m = MATERIALS[matId(region.mat)];
      if ((m.phase === PHASE.RIGID) !== wantRigid) continue;
      const temp = region.temp != null ? region.temp : m.temp;
      // Fixed scenery never moves, so it needs far fewer particles than a fluid does.
      const here = m.phase === PHASE.RIGID ? Math.min(perCell, 2) : perCell;
      for (let p = 0; p < here && n < count; p++, n++) {
        const o = off[p % 8];
        pos[n * 4] = i + (o[0] + rand()) * 0.5;
        pos[n * 4 + 1] = j + (o[1] + rand()) * 0.5;
        pos[n * 4 + 2] = k + (o[2] + rand()) * 0.5;
        pos[n * 4 + 3] = m.id;
        vel[n * 4 + 3] = temp;
        aux[n * 4] = m.life || 0;
        aux[n * 4 + 1] = rand();
        aux[n * 4 + 3] = 1 / here;
      }
    }
    if (wantRigid) rigidCount = n;
  }
  // Fixed scenery uses fewer specks per cell than the estimate assumed, so the
  // arrays are trimmed to what was actually written - callers count on that.
  return {
    pos: n === count ? pos : pos.subarray(0, n * 4),
    vel: n === count ? vel : vel.subarray(0, n * 4),
    aux: n === count ? aux : aux.subarray(0, n * 4),
    count: n, rigidCount, perCell, emitters: b.emitters, cellCount,
  };
}

const SCENES = [
  {
    id: 'dam', name: 'Dam break', blurb: 'A wall of water let go all at once',
    camera: { yaw: -0.62, pitch: 0.30, dist: 2.5 },
    build: (s) => {
      s.box('Water', [0.02, 0.02, 0.10], [0.30, 0.66, 0.90]);
      s.box('Stone', [0.60, 0.02, 0.34], [0.70, 0.26, 0.66]);
    },
  },
  {
    id: 'waterfall', name: 'Waterfall', blurb: 'A spout onto stone steps',
    camera: { yaw: -0.72, pitch: 0.26, dist: 2.6 },
    build: (s) => {
      s.box('Stone', [0.34, 0.34, 0.14], [0.96, 0.40, 0.56]);
      s.box('Stone', [0.06, 0.14, 0.44], [0.60, 0.20, 0.94]);
      s.box('Water', [0.02, 0.02, 0.02], [0.98, 0.07, 0.98]);
      s.emit('Water', [0.84, 0.80, 0.34], 2.6, [-0.7, -1.4, 0.15], 5200);
    },
  },
  {
    id: 'hourglass', name: 'Hourglass', blurb: 'Sand through a stone funnel',
    camera: { yaw: -0.35, pitch: 0.14, dist: 2.5 },
    build: (s) => {
      const mouth = (y) => 0.05 + (y - 0.34) * 1.05;
      s.shape('Stone', (x, y, z) => {
        if (y < 0.34 || y > 0.70) return false;
        const d = Math.hypot(x - 0.5, z - 0.5);
        return d > mouth(y) && d < mouth(y) + 0.055;
      });
      s.shape('Sand', (x, y, z) => {
        if (y < 0.40 || y > 0.86) return false;
        return Math.hypot(x - 0.5, z - 0.5) < mouth(y);
      });
    },
  },
  {
    id: 'volcano', name: 'Volcano', blurb: 'Lava into a cold lake - expect steam',
    camera: { yaw: -0.55, pitch: 0.22, dist: 2.7 },
    build: (s) => {
      s.shape('Stone', (x, y, z) => {
        const d = Math.hypot(x - 0.5, z - 0.5);
        return y < 0.58 && d < 0.40 - y * 0.44 && d > 0.06;
      });
      s.box('Water', [0.02, 0.02, 0.02], [0.98, 0.16, 0.98]);
      s.emit('Lava', [0.5, 0.56, 0.5], 2.4, [0, 2.8, 0], 3000);
    },
  },
  {
    id: 'layers', name: 'Density tower', blurb: 'Oil rises, mercury plunges, water stays put',
    camera: { yaw: -0.30, pitch: 0.14, dist: 2.3 },
    build: (s) => {
      // Oil trapped underneath has to climb through the water; mercury dropped in
      // from above has to fall through all of it. The water is clear, so you can
      // watch both happen.
      s.box('Oil', [0.10, 0.04, 0.10], [0.90, 0.13, 0.90]);
      s.box('Water', [0.08, 0.14, 0.08], [0.92, 0.52, 0.92]);
      s.sphere('Mercury', [0.5, 0.78, 0.5], 0.10);
    },
  },
  {
    id: 'thaw', name: 'Thaw', blurb: 'An ice block on a red hot steel plate',
    camera: { yaw: -0.48, pitch: 0.24, dist: 2.4 },
    build: (s) => {
      s.box('Stone', [0.02, 0.02, 0.02], [0.98, 0.05, 0.98]);
      s.box('Steel', [0.12, 0.05, 0.12], [0.88, 0.10, 0.88], { temp: 1150 });
      s.box('Ice', [0.30, 0.11, 0.30], [0.70, 0.46, 0.70]);
    },
  },
  {
    id: 'snow', name: 'Snowfall', blurb: 'Powder settling on a rocky ridge',
    camera: { yaw: -0.6, pitch: 0.28, dist: 2.6 },
    build: (s) => {
      s.shape('Stone', (x, y, z) => y < 0.14 + 0.13 * Math.sin(x * 5.4) * Math.cos(z * 4.1));
      s.emit('Snow', [0.5, 0.95, 0.5], 21.0, [0, -0.4, 0], 3200);
    },
  },
  {
    id: 'bonfire', name: 'Bonfire', blurb: 'Oil-soaked logs and a lit match',
    camera: { yaw: -0.55, pitch: 0.22, dist: 2.5 },
    build: (s) => {
      s.box('Stone', [0.02, 0.02, 0.02], [0.98, 0.06, 0.98]);
      for (let i = 0; i < 4; i++) {
        const odd = i % 2;
        const lo = odd ? [0.26, 0.07 + i * 0.05, 0.34] : [0.34, 0.07 + i * 0.05, 0.26];
        const hi = odd ? [0.74, 0.105 + i * 0.05, 0.66] : [0.66, 0.105 + i * 0.05, 0.74];
        s.box('Wood', lo, hi);
      }
      s.box('Oil', [0.34, 0.27, 0.34], [0.66, 0.32, 0.66]);
      s.sphere('Lava', [0.5, 0.36, 0.5], 0.05);
    },
  },
  {
    id: 'rain', name: 'Rain', blurb: 'A downpour into a rocky basin',
    camera: { yaw: -0.42, pitch: 0.28, dist: 2.6 },
    build: (s) => {
      s.shape('Stone', (x, y, z) => {
        const d = Math.hypot(x - 0.5, z - 0.5);
        return y < 0.26 && (d > 0.42 || y < 0.05);
      });
      s.box('Water', [0.10, 0.05, 0.10], [0.90, 0.12, 0.90]);
      s.emit('Water', [0.5, 0.96, 0.5], 23.0, [0, -1.4, 0], 2600);
    },
  },
  {
    id: 'empty', name: 'Empty box', blurb: 'Nothing at all - build your own',
    camera: { yaw: -0.45, pitch: 0.26, dist: 2.5 },
    build: () => {},
  },
];
