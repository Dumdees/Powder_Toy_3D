// The material table. Everything the solver and the renderer know about a
// substance lives here, in real units where real units are meaningful.
//
// Honest notes about where we depart from reality, and why:
//  * Densities are real (kg/m3) but the pressure solve uses them relative to
//    water and clamped to [0.04, 8]. A true 1660:1 air/water ratio makes the
//    Poisson system far too stiff for the handful of iterations we can afford
//    at 60fps. Buoyancy is still strongly correct in sign and roughly in size.
//  * Lava's kinematic viscosity is really 1e2-1e4 m2/s. At that value it would
//    not move at all on screen, so it is dialled down to something lively.
//  * Conduction is scaled by a global "thermal time scale" (see PHYSICS) because
//    real conduction over a 2.5m box takes hours, not seconds.
// Anything not listed here is exactly the textbook value.

const PHASE = { LIQUID: 0, GRANULAR: 1, GAS: 2, RIGID: 3 };

/** Materials, in palette order. Index in this array IS the id used on the GPU. */
const MATERIALS = [
  {
    id: 0, name: 'Empty', phase: PHASE.GAS, hidden: true,
    density: 1.2, viscosity: 0, friction: 0, cohesion: 0,
    albedo: [0, 0, 0], roughness: 1, metallic: 0, ior: 1, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 2e-5, temp: 20, glow: 0, life: 0,
  },
  {
    id: 1, name: 'Water', swatch: '#2f7fd0', blurb: 'Incompressible, 0.073 N/m surface tension',
    phase: PHASE.LIQUID, density: 998, viscosity: 1.0e-6, friction: 0, cohesion: 0,
    albedo: [0.02, 0.04, 0.05], roughness: 0.02, metallic: 0, ior: 1.333, transmission: 1,
    absorb: [0.45, 0.09, 0.02], surfaceTension: 0.0728, alpha: 1.4e-7, temp: 20, glow: 0, life: 0,
    freeze: { at: -0.5, into: 'Ice' }, boil: { at: 100, into: 'Steam' },
  },
  {
    id: 2, name: 'Oil', swatch: '#8a6a2a', blurb: 'Floats on water, burns at 210 C',
    phase: PHASE.LIQUID, density: 870, viscosity: 8.0e-5, friction: 0, cohesion: 0,
    albedo: [0.10, 0.07, 0.03], roughness: 0.05, metallic: 0, ior: 1.47, transmission: 0.8,
    absorb: [0.30, 0.62, 1.8], surfaceTension: 0.032, alpha: 8e-8, temp: 20, glow: 0, life: 0,
    burn: { at: 210, into: 'Fire' },
  },
  {
    id: 3, name: 'Honey', swatch: '#d79a2b', blurb: 'Very viscous - 7e-3 m2/s',
    phase: PHASE.LIQUID, density: 1420, viscosity: 7.0e-3, friction: 0, cohesion: 0,
    albedo: [0.35, 0.17, 0.03], roughness: 0.06, metallic: 0, ior: 1.49, transmission: 0.7,
    absorb: [0.35, 0.95, 3.0], surfaceTension: 0.06, alpha: 1.0e-7, temp: 20, glow: 0, life: 0,
    burn: { at: 320, into: 'Smoke' },
  },
  {
    id: 4, name: 'Lava', swatch: '#e2521a', blurb: 'Glows by Planck’s law, sets to stone below 700 C',
    phase: PHASE.LIQUID, density: 2800, viscosity: 2.0e-2, friction: 0, cohesion: 0,
    albedo: [0.10, 0.03, 0.015], roughness: 0.55, metallic: 0, ior: 1.6, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0.36, alpha: 6e-7, temp: 1150, glow: 1, life: 0,
    freeze: { at: 700, into: 'Stone' }, sustain: { at: 1150, rate: 0.12 },
  },
  {
    id: 5, name: 'Mercury', swatch: '#c8ccd4', blurb: '13.5x water, a liquid mirror',
    phase: PHASE.LIQUID, density: 13534, viscosity: 1.1e-7, friction: 0, cohesion: 0,
    albedo: [0.78, 0.78, 0.80], roughness: 0.035, metallic: 1, ior: 1.0, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0.486, alpha: 4.4e-6, temp: 20, glow: 0, life: 0,
  },
  {
    id: 6, name: 'Sand', swatch: '#c9a463', blurb: 'Piles at its 34° angle of repose',
    phase: PHASE.GRANULAR, density: 1600, viscosity: 0, friction: 0.675, cohesion: 0.02,
    albedo: [0.72, 0.58, 0.36], roughness: 0.90, metallic: 0, ior: 1.46, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 3e-7, temp: 20, glow: 0, life: 0,
    melt: { at: 1600, into: 'Glass' },
  },
  {
    id: 7, name: 'Snow', swatch: '#e8f1fb', blurb: 'Sticky powder, melts above 0 C',
    phase: PHASE.GRANULAR, density: 300, viscosity: 0, friction: 0.78, cohesion: 0.42,
    albedo: [0.90, 0.93, 0.97], roughness: 0.70, metallic: 0, ior: 1.31, transmission: 0.06,
    absorb: [0.2, 0.1, 0.05], surfaceTension: 0, alpha: 4e-7, temp: -8, glow: 0, life: 0,
    melt: { at: 0.5, into: 'Water' },
  },
  {
    id: 8, name: 'Ash', swatch: '#6b6560', blurb: 'Light, slippery dust',
    phase: PHASE.GRANULAR, density: 700, viscosity: 0, friction: 0.50, cohesion: 0.06,
    albedo: [0.20, 0.185, 0.17], roughness: 0.96, metallic: 0, ior: 1.4, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 2e-7, temp: 60, glow: 0, life: 0,
  },
  {
    id: 9, name: 'Stone', swatch: '#8b8781', blurb: 'Fixed in place until it melts at 1000 C',
    phase: PHASE.RIGID, density: 2650, viscosity: 0, friction: 0.9, cohesion: 1,
    albedo: [0.34, 0.32, 0.30], roughness: 0.85, metallic: 0, ior: 1.5, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 1.2e-6, temp: 20, glow: 0.9, life: 0,
    melt: { at: 1000, into: 'Lava' },
  },
  {
    id: 10, name: 'Ice', swatch: '#a8d6ea', blurb: 'Clear solid, melts above 0 C',
    phase: PHASE.RIGID, density: 917, viscosity: 0, friction: 0.05, cohesion: 1,
    albedo: [0.50, 0.68, 0.78], roughness: 0.10, metallic: 0, ior: 1.31, transmission: 0.78,
    absorb: [0.30, 0.10, 0.05], surfaceTension: 0, alpha: 1.2e-6, temp: -12, glow: 0, life: 0,
    melt: { at: 0.5, into: 'Water' },
  },
  {
    id: 11, name: 'Steel', swatch: '#9aa2ad', blurb: 'Conducts heat fast, melts at 1450 C',
    phase: PHASE.RIGID, density: 7850, viscosity: 0, friction: 0.6, cohesion: 1,
    albedo: [0.56, 0.57, 0.58], roughness: 0.26, metallic: 1, ior: 1.0, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 1.2e-5, temp: 20, glow: 1, life: 0,
    melt: { at: 1450, into: 'Lava' },
  },
  {
    id: 12, name: 'Glass', swatch: '#cfe9ee', blurb: 'What sand becomes at 1600 C',
    phase: PHASE.RIGID, density: 2500, viscosity: 0, friction: 0.4, cohesion: 1,
    albedo: [0.60, 0.72, 0.75], roughness: 0.03, metallic: 0, ior: 1.52, transmission: 0.95,
    absorb: [0.06, 0.04, 0.08], surfaceTension: 0, alpha: 5e-7, temp: 20, glow: 0.8, life: 0,
    melt: { at: 1500, into: 'Lava' },
  },
  {
    id: 13, name: 'Wood', swatch: '#6b4423', blurb: 'Catches fire at 300 C',
    phase: PHASE.RIGID, density: 650, viscosity: 0, friction: 0.7, cohesion: 1,
    albedo: [0.26, 0.16, 0.08], roughness: 0.78, metallic: 0, ior: 1.5, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 1.6e-7, temp: 20, glow: 0, life: 0,
    burn: { at: 300, into: 'Fire' },
  },
  {
    id: 14, name: 'Fire', swatch: '#ff9d2e', blurb: 'Burns for a moment, then smokes',
    phase: PHASE.GAS, density: 0.3, viscosity: 1.5e-5, friction: 0, cohesion: 0,
    albedo: [0.05, 0.03, 0.02], roughness: 1, metallic: 0, ior: 1, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 2e-5, temp: 950, glow: 1, life: 1.4,
    expires: 'Smoke', sustain: { at: 950, rate: 9 },
  },
  {
    id: 15, name: 'Steam', swatch: '#d4dde6', blurb: 'Rises, and turns back to water below 100 C',
    phase: PHASE.GAS, density: 0.6, viscosity: 2.0e-5, friction: 0, cohesion: 0,
    albedo: [0.86, 0.89, 0.92], roughness: 1, metallic: 0, ior: 1, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 2e-5, temp: 130, glow: 0, life: 0,
    freeze: { at: 96, into: 'Water' },
  },
  {
    id: 16, name: 'Smoke', swatch: '#4a4f57', blurb: 'Rises while it is warm, then fades',
    phase: PHASE.GAS, density: 1.0, viscosity: 1.8e-5, friction: 0, cohesion: 0,
    albedo: [0.06, 0.06, 0.07], roughness: 1, metallic: 0, ior: 1, transmission: 0,
    absorb: [0, 0, 0], surfaceTension: 0, alpha: 2e-5, temp: 220, glow: 0, life: 7,
    expires: 'Empty',
  },
];

const MAT_COUNT = MATERIALS.length;
const MAT_ROWS = 9;                       // vec4 rows per material in the lookup texture
const MAT_BY_NAME = new Map(MATERIALS.map((m) => [m.name, m]));
const matId = (name) => (MAT_BY_NAME.get(name) || MATERIALS[0]).id;
/** Materials the palette offers, i.e. everything except the "nothing here" slot. */
const PAINTABLE = MATERIALS.filter((m) => !m.hidden);

/** Density relative to water, clamped so the Poisson solve stays well conditioned. */
function simDensity(m) { return clamp(m.density / 998, 0.04, 8); }

/** sRGB swatch colour for the palette; falls back to the linear albedo. */
function swatchOf(m) {
  if (m.swatch) return m.swatch;
  const enc = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  return `rgb(${enc(m.albedo[0])},${enc(m.albedo[1])},${enc(m.albedo[2])})`;
}

/**
 * Flatten the table into the RGBA32F lookup texture the shaders read with
 * texelFetch(uMat, ivec2(row, id), 0). Width MAT_ROWS, height MAT_COUNT.
 *
 *  row 0  density(rel)   viscosity      friction        cohesion
 *  row 1  albedo.rgb                                    glow gain
 *  row 2  roughness      metallic       ior             transmission
 *  row 3  isLiquid       isGranular     isGas           isRigid
 *  row 4  meltAt         meltInto       freezeAt        freezeInto
 *  row 5  boilAt         boilInto       burnAt          burnInto
 *  row 6  absorb.rgb                                    thermal diffusivity
 *  row 7  lifetime       expiresInto    surfaceTension  start temperature
 *  row 8  sustain temp   sustain rate   -               -
 */
function packMaterials() {
  const data = new Float32Array(MAT_ROWS * 4 * MAT_COUNT);
  const put = (m, row, a, b, c, d) => {
    const o = (m.id * MAT_ROWS + row) * 4;
    data[o] = a; data[o + 1] = b; data[o + 2] = c; data[o + 3] = d;
  };
  const change = (t) => (t ? [t.at, matId(t.into)] : [1e9, 0]);
  const changeDown = (t) => (t ? [t.at, matId(t.into)] : [-1e9, 0]);
  for (const m of MATERIALS) {
    put(m, 0, simDensity(m), m.viscosity, m.friction, m.cohesion);
    put(m, 1, m.albedo[0], m.albedo[1], m.albedo[2], m.glow || 0);
    put(m, 2, m.roughness, m.metallic, m.ior, m.transmission);
    put(m, 3, m.phase === PHASE.LIQUID ? 1 : 0, m.phase === PHASE.GRANULAR ? 1 : 0,
      m.phase === PHASE.GAS ? 1 : 0, m.phase === PHASE.RIGID ? 1 : 0);
    const [meltAt, meltInto] = change(m.melt);
    const [freezeAt, freezeInto] = changeDown(m.freeze);
    put(m, 4, meltAt, meltInto, freezeAt, freezeInto);
    const [boilAt, boilInto] = change(m.boil);
    const [burnAt, burnInto] = change(m.burn);
    put(m, 5, boilAt, boilInto, burnAt, burnInto);
    put(m, 6, m.absorb[0], m.absorb[1], m.absorb[2], m.alpha);
    put(m, 7, m.life || 0, m.expires ? matId(m.expires) : 0, m.surfaceTension, m.temp);
    put(m, 8, m.sustain ? m.sustain.at : 0, m.sustain ? m.sustain.rate : 0, 0, 0);
  }
  return data;
}
