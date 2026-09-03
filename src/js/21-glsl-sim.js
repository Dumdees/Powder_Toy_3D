// The solver, as GPU passes.
//
// One step is: scatter particles onto the grid (P2G) -> normalise and add body
// forces -> diffuse heat and momentum -> surface tension -> make the velocity
// field divergence free with a variable-density pressure solve -> gather back
// onto the particles (G2P) and move them.
//
// That is a FLIP/APIC hybrid: the grid does the parts that need neighbours
// (pressure, diffusion), the particles do the parts that need memory
// (advection, temperature, what each speck is made of).

// ---------------------------------------------------------------- P2G scatter
// gl_VertexID enumerates (particle, corner) pairs: eight corners of the
// trilinear stencil, one point each, additively blended into the grid.
const P2G_VS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uPos, uVel, uAux, uC0, uC1, uC2;
uniform ivec2 uPTex;
uniform float uAffine;

flat out vec4 vMom;    // momentum.xyz, mass
flat out vec4 vHeat;   // rigid mass, mass*temperature, mass*viscosity, mass*sigma
flat out vec4 vGran;   // fill fraction, granular mass, mass*friction, mass*cohesion

void main() {
  int pid = gl_VertexID >> 3;
  int corner = gl_VertexID & 7;
  ivec3 bit = ivec3(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
  ivec2 pt = ivec2(pid - (pid / uPTex.x) * uPTex.x, pid / uPTex.x);
  vec4 P = texelFetch(uPos, pt, 0);
  int mid = int(P.w + 0.5);

  vec3 q = P.xyz - 0.5;
  ivec3 base = ivec3(floor(q));
  vec3 f = q - vec3(base);
  ivec3 c = base + bit;
  vec3 wv = mix(1.0 - f, f, vec3(bit));
  float w = wv.x * wv.y * wv.z;

  if (mid == 0 || !inGrid(c) || w < 1e-5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // clipped away
    gl_PointSize = 0.0;
    vMom = vec4(0.0); vHeat = vec4(0.0); vGran = vec4(0.0);
    return;
  }

  vec4 m0 = matRow(mid, 0);      // density, viscosity, friction, cohesion
  vec4 m3 = matRow(mid, 3);      // liquid, granular, gas, rigid
  vec4 m7 = matRow(mid, 7);      // life, expires, surface tension, start temp
  vec4 V = texelFetch(uVel, pt, 0);
  vec4 A = texelFetch(uAux, pt, 0);
  float vol = max(A.w, 1e-3);
  float mass = m0.x * vol;

  // APIC: carry the local affine velocity field, not just the average. This is
  // what keeps swirls alive instead of smearing them into the grid every step.
  vec3 d = (vec3(c) + 0.5) - P.xyz;
  vec3 r0 = texelFetch(uC0, pt, 0).xyz;
  vec3 r1 = texelFetch(uC1, pt, 0).xyz;
  vec3 r2 = texelFetch(uC2, pt, 0).xyz;
  vec3 affine = vec3(dot(r0, d), dot(r1, d), dot(r2, d));
  vec3 vel = V.xyz + uAffine * affine;

  float wm = w * mass;
  vMom  = vec4(wm * vel, wm);
  vHeat = vec4(wm * m3.w, wm * V.w, wm * m0.y, wm * m7.z);
  vGran = vec4(w * vol, wm * m3.y, wm * m0.z, wm * m0.w);

  vec2 texel = vec2(cellTexel(c)) + 0.5;
  gl_Position = vec4(texel / uAtlas * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const P2G_FS = GLSL_HEAD + `
flat in vec4 vMom;
flat in vec4 vHeat;
flat in vec4 vGran;
layout(location = 0) out vec4 oMom;
layout(location = 1) out vec4 oHeat;
layout(location = 2) out vec4 oGran;
void main() { oMom = vMom; oHeat = vHeat; oGran = vGran; }`;

// ------------------------------------------------- normalise and body forces
const GRID_PREP_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uMom, uHeat, uGran;
uniform float uDt, uGravity, uAmbient, uDrag;
layout(location = 0) out vec4 oVel;     // velocity.xyz, density
layout(location = 1) out vec4 oPre;     // velocity as transferred, fill fraction
layout(location = 2) out vec4 oAux;     // solid, temperature, viscosity, fill
layout(location = 3) out vec4 oProp;    // granular fraction, friction, cohesion, sigma

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oVel = vec4(0.0); oPre = vec4(0.0); oAux = vec4(0.0); oProp = vec4(0.0); return; }

  vec4 M = texelFetch(uMom, t, 0);
  vec4 H = texelFetch(uHeat, t, 0);
  vec4 G = texelFetch(uGran, t, 0);
  float m = max(M.w, 0.0);
  float inv = m > 1e-5 ? 1.0 / m : 0.0;

  vec3 v = M.xyz * inv;
  float temp = m > 1e-5 ? H.y * inv : uAmbient;
  float visc = H.z * inv;
  float sigma = H.w * inv;
  float granular = G.y * inv;
  float mu = G.z * inv;
  float coh = G.w * inv;

  // A cell is solid when it is mostly fixed material, or part of the box itself.
  float solid = (m > 1e-5 && H.x * inv > 0.5) ? 1.0 : 0.0;
  ivec3 n = gridSize();
  if (c.x < 1 || c.y < 1 || c.z < 1 || c.x >= n.x - 1 || c.y >= n.y - 1 || c.z >= n.z - 1) solid = 1.0;

  oPre = vec4(v, G.x);

  if (m > 1e-5 && solid < 0.5) {
    v.y -= uGravity * uDt;                       // weight
    v *= max(0.0, 1.0 - uDrag * uDt);            // a little air resistance
  } else if (solid > 0.5) {
    v = vec3(0.0);
  }

  oVel = vec4(v, m);
  oAux = vec4(solid, temp, visc, G.x);
  oProp = vec4(granular, mu, coh, sigma);
}`;

// -------------------------------------------------------------- heat spreads
const HEAT_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uAux;
uniform float uDt, uDx, uAmbient, uHeatScale, uRadiate;
out vec4 oAux;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oAux = vec4(0.0); return; }
  vec4 A = texelFetch(uAux, t, 0);

  // Conduction over a 2.5m box takes hours in real life, so the diffusivity is
  // multiplied by uHeatScale to bring it onto a human timescale.
  float alpha = 1.4e-5 * uHeatScale;
  float k = clamp(alpha * uDt / (uDx * uDx), 0.0, 1.0 / 6.5);
  float sum = 0.0;
  for (int i = 0; i < 6; i++) {
    ivec3 o = ivec3(i == 0 ? 1 : (i == 1 ? -1 : 0), i == 2 ? 1 : (i == 3 ? -1 : 0), i == 4 ? 1 : (i == 5 ? -1 : 0));
    ivec3 d = c + o;
    sum += inGrid(d) ? texelFetch(uAux, cellTexel(d), 0).y : A.y;
  }
  float temp = A.y + k * (sum - 6.0 * A.y);
  // Anything much hotter than the room sheds heat to it (Newton plus a T^4 term).
  float over = temp - uAmbient;
  temp -= uRadiate * uDt * (over * 0.02 + sign(over) * thermalPower(temp) * 0.05);
  oAux = vec4(A.x, temp, A.z, A.w);
}`;

// ------------------------------------------------------- momentum diffusion
const VISC_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uVel, uAux;
uniform float uDt, uDx, uViscScale;
out vec4 oVel;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oVel = vec4(0.0); return; }
  vec4 V = texelFetch(uVel, t, 0);
  vec4 A = texelFetch(uAux, t, 0);
  if (A.x > 0.5 || V.w < 1e-5) { oVel = V; return; }
  float k = clamp(A.z * uViscScale * uDt / (uDx * uDx), 0.0, 1.0 / 6.5);
  if (k < 1e-6) { oVel = V; return; }
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    ivec3 o = ivec3(i == 0 ? 1 : (i == 1 ? -1 : 0), i == 2 ? 1 : (i == 3 ? -1 : 0), i == 4 ? 1 : (i == 5 ? -1 : 0));
    ivec3 d = c + o;
    vec4 N = fetchCell(uVel, d);
    vec4 NA = fetchCell(uAux, d);
    sum += (inGrid(d) && NA.x < 0.5 && N.w > 1e-5) ? N.xyz : V.xyz;
  }
  oVel = vec4(V.xyz + k * (sum - 6.0 * V.xyz), V.w);
}`;

// --------------------------------------------------------- surface tension
// Continuum surface force: f = sigma * curvature * normal, applied in the thin
// band where the fill fraction changes. This is what beads water into droplets.
const NORMAL_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uAux;
out vec4 oNorm;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oNorm = vec4(0.0); return; }
  float here = texelFetch(uAux, t, 0).w;
  vec3 g;
  g.x = fetchCell(uAux, c + ivec3(1, 0, 0)).w - fetchCell(uAux, c - ivec3(1, 0, 0)).w;
  g.y = fetchCell(uAux, c + ivec3(0, 1, 0)).w - fetchCell(uAux, c - ivec3(0, 1, 0)).w;
  g.z = fetchCell(uAux, c + ivec3(0, 0, 1)).w - fetchCell(uAux, c - ivec3(0, 0, 1)).w;
  g *= 0.5;
  float len = length(g);
  oNorm = vec4(len > 1e-5 ? g / len : vec3(0.0), len);
}`;

const TENSION_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uVel, uAux, uProp, uNorm;
uniform float uDt, uDx, uTension;
out vec4 oVel;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oVel = vec4(0.0); return; }
  vec4 V = texelFetch(uVel, t, 0);
  vec4 A = texelFetch(uAux, t, 0);
  vec4 N = texelFetch(uNorm, t, 0);
  if (A.x > 0.5 || V.w < 1e-5 || N.w < 1e-4) { oVel = V; return; }
  float sigma = texelFetch(uProp, t, 0).w * uTension;
  if (sigma < 1e-6) { oVel = V; return; }
  // curvature = -div(n)
  float div = 0.5 * (
      fetchCell(uNorm, c + ivec3(1, 0, 0)).x - fetchCell(uNorm, c - ivec3(1, 0, 0)).x
    + fetchCell(uNorm, c + ivec3(0, 1, 0)).y - fetchCell(uNorm, c - ivec3(0, 1, 0)).y
    + fetchCell(uNorm, c + ivec3(0, 0, 1)).z - fetchCell(uNorm, c - ivec3(0, 0, 1)).z);
  float kappa = -div / uDx;
  // rho here is relative to water, so dividing by it gives an acceleration.
  vec3 f = sigma * kappa * N.xyz * N.w / uDx;
  vec3 a = f / max(V.w, 0.05) / 998.0;
  oVel = vec4(V.xyz + clamp(a * uDt, vec3(-4.0), vec3(4.0)), V.w);
}`;

// ------------------------------------------------------- granular behaviour
// Dry grains are a Drucker-Prager (Coulomb) material: they carry shear stress up
// to tau_y = mu * pressure + cohesion, and flow once that is exceeded. Below the
// yield they behave as a very stiff fluid, which is what lets a heap stand at its
// angle of repose instead of levelling out like water.
//
// First pass: the deviatoric stress from the strain rate.
const STRESS_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uVel, uAux, uProp, uPress;
uniform float uDx, uGranular, uYieldFloor, uCohesion;
layout(location = 0) out vec4 oT0;   // txx, tyy, tzz, txy
layout(location = 1) out vec4 oT1;   // txz, tyz

vec3 nbVel(ivec3 d, vec3 vc) {
  if (!inGrid(d)) return vec3(0.0);                       // the box itself: static
  if (fetchCell(uAux, d).x > 0.5) return vec3(0.0);       // fixed material: static
  vec4 NV = fetchCell(uVel, d);
  return NV.w < 1e-5 ? vc : NV.xyz;                       // open air: no shear
}

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oT0 = vec4(0.0); oT1 = vec4(0.0); return; }
  vec4 V = texelFetch(uVel, t, 0);
  vec4 A = texelFetch(uAux, t, 0);
  vec4 M = texelFetch(uProp, t, 0);
  if (A.x > 0.5 || V.w < 1e-5 || M.x < 0.02) { oT0 = vec4(0.0); oT1 = vec4(0.0); return; }

  vec3 dvdx = (nbVel(c + ivec3(1, 0, 0), V.xyz) - nbVel(c - ivec3(1, 0, 0), V.xyz)) / (2.0 * uDx);
  vec3 dvdy = (nbVel(c + ivec3(0, 1, 0), V.xyz) - nbVel(c - ivec3(0, 1, 0), V.xyz)) / (2.0 * uDx);
  vec3 dvdz = (nbVel(c + ivec3(0, 0, 1), V.xyz) - nbVel(c - ivec3(0, 0, 1), V.xyz)) / (2.0 * uDx);

  // Rate of strain, with the volume change taken out.
  float dxx = dvdx.x, dyy = dvdy.y, dzz = dvdz.z;
  float dxy = 0.5 * (dvdy.x + dvdx.y);
  float dxz = 0.5 * (dvdz.x + dvdx.z);
  float dyz = 0.5 * (dvdz.y + dvdy.z);
  float tr = (dxx + dyy + dzz) / 3.0;
  dxx -= tr; dyy -= tr; dzz -= tr;
  float mag = sqrt(max(0.5 * (dxx * dxx + dyy * dyy + dzz * dzz) + dxy * dxy + dxz * dxz + dyz * dyz, 0.0));

  float p = max(texelFetch(uPress, t, 0).x, 0.0);
  float yield = (M.y * p + M.z * uCohesion) * uGranular * clamp(M.x, 0.0, 1.0);
  // Bounded by the yield either way, so the explicit update stays stable.
  float k = yield / max(mag, uYieldFloor);
  oT0 = vec4(dxx, dyy, dzz, dxy) * k;
  oT1 = vec4(dxz, dyz, 0.0, 0.0) * k;
}`;

// Second pass: the force that stress exerts, which is its divergence.
const PLASTIC_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uVel, uAux, uT0, uT1;
uniform float uDt, uDx, uMaxAccel;
out vec4 oVel;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oVel = vec4(0.0); return; }
  vec4 V = texelFetch(uVel, t, 0);
  vec4 A = texelFetch(uAux, t, 0);
  if (A.x > 0.5 || V.w < 1e-5) { oVel = V; return; }

  ivec3 ex = ivec3(1, 0, 0), ey = ivec3(0, 1, 0), ez = ivec3(0, 0, 1);
  vec4 t0px = fetchCell(uT0, c + ex), t0mx = fetchCell(uT0, c - ex);
  vec4 t0py = fetchCell(uT0, c + ey), t0my = fetchCell(uT0, c - ey);
  vec4 t0pz = fetchCell(uT0, c + ez), t0mz = fetchCell(uT0, c - ez);
  vec4 t1px = fetchCell(uT1, c + ex), t1mx = fetchCell(uT1, c - ex);
  vec4 t1py = fetchCell(uT1, c + ey), t1my = fetchCell(uT1, c - ey);
  vec4 t1pz = fetchCell(uT1, c + ez), t1mz = fetchCell(uT1, c - ez);
  float h = 1.0 / (2.0 * uDx);

  vec3 f;
  f.x = (t0px.x - t0mx.x) * h + (t0py.w - t0my.w) * h + (t1pz.x - t1mz.x) * h;
  f.y = (t0px.w - t0mx.w) * h + (t0py.y - t0my.y) * h + (t1pz.y - t1mz.y) * h;
  f.z = (t1px.x - t1mx.x) * h + (t1py.y - t1my.y) * h + (t0pz.z - t0mz.z) * h;

  vec3 a = clamp(f / max(V.w, 0.05), vec3(-uMaxAccel), vec3(uMaxAccel));
  oVel = vec4(V.xyz + a * uDt, V.w);
}`;

// ---------------------------------------------------------- pressure solve
const DIV_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uVel, uAux;
uniform float uDx, uPack;
out float oDiv;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oDiv = 0.0; return; }
  vec4 V = texelFetch(uVel, t, 0);
  vec4 A = texelFetch(uAux, t, 0);
  if (A.x > 0.5 || V.w < 1e-5) { oDiv = 0.0; return; }

  // A wall reflects: the face velocity there must be zero, so mirror our own.
  #define FLUX(off, comp) ( (!inGrid(c + (off)) || fetchCell(uAux, c + (off)).x > 0.5) \
      ? -V.comp : fetchCell(uVel, c + (off)).comp )
  float d = 0.5 * (
      FLUX(ivec3( 1, 0, 0), x) - FLUX(ivec3(-1, 0, 0), x)
    + FLUX(ivec3( 0, 1, 0), y) - FLUX(ivec3( 0,-1, 0), y)
    + FLUX(ivec3( 0, 0, 1), z) - FLUX(ivec3( 0, 0,-1), z)) / uDx;
  #undef FLUX
  // Nudge over-packed cells apart. Without this, FLIP slowly loses volume and
  // particles clump into strings.
  // Cap the correction: a cell that has momentarily gone six times over would
  // otherwise be blown apart hard enough to throw the whole heap across the box.
  float excess = min(max(A.w - 1.0, 0.0), 1.0);
  oDiv = d - uPack * excess;
}`;

const PRESSURE_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uPress, uVel, uAux, uDiv;
uniform float uDt, uDx;
uniform int uParity;
out float oPress;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oPress = 0.0; return; }
  float old = texelFetch(uPress, t, 0).x;
  // Red-black Gauss-Seidel: half the cells per pass, so each pass already sees
  // its neighbours' new values. Converges about twice as fast as Jacobi.
  if (((c.x + c.y + c.z) & 1) != uParity) { oPress = old; return; }

  vec4 V = texelFetch(uVel, t, 0);
  vec4 A = texelFetch(uAux, t, 0);
  if (A.x > 0.5 || V.w < 1e-5) { oPress = 0.0; return; }

  float rhoC = max(V.w, 0.04);
  float sum = 0.0, diag = 0.0;
  for (int i = 0; i < 6; i++) {
    ivec3 o = ivec3(i == 0 ? 1 : (i == 1 ? -1 : 0), i == 2 ? 1 : (i == 3 ? -1 : 0), i == 4 ? 1 : (i == 5 ? -1 : 0));
    ivec3 d = c + o;
    if (!inGrid(d)) continue;
    vec4 NA = fetchCell(uAux, d);
    if (NA.x > 0.5) continue;                       // solid: no flux, no term
    vec4 NV = fetchCell(uVel, d);
    float k = 2.0 / (rhoC + max(NV.w, 0.04));       // 1 / density at the face
    diag += k;
    if (NV.w >= 1e-5) sum += k * texelFetch(uPress, cellTexel(d), 0).x;  // else air, p = 0
  }
  if (diag < 1e-6) { oPress = 0.0; return; }
  float p = (sum - texelFetch(uDiv, t, 0).x * uDx * uDx / uDt) / diag;
  // Liquids and grains push but never pull, so pressure stays positive.
  oPress = max(p, 0.0);
}`;

const PROJECT_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uVel, uAux, uPress;
uniform float uDt, uDx;
out vec4 oVel;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oVel = vec4(0.0); return; }
  vec4 V = texelFetch(uVel, t, 0);
  vec4 A = texelFetch(uAux, t, 0);
  if (A.x > 0.5) { oVel = vec4(0.0, 0.0, 0.0, V.w); return; }
  if (V.w < 1e-5) { oVel = V; return; }
  float p = texelFetch(uPress, t, 0).x;
  // A solid neighbour contributes no gradient, which is the no-flux condition.
  #define PR(off) ( (!inGrid(c + (off)) || fetchCell(uAux, c + (off)).x > 0.5) \
      ? p : texelFetch(uPress, cellTexel(c + (off)), 0).x )
  vec3 grad = 0.5 * vec3(
      PR(ivec3( 1, 0, 0)) - PR(ivec3(-1, 0, 0)),
      PR(ivec3( 0, 1, 0)) - PR(ivec3( 0,-1, 0)),
      PR(ivec3( 0, 0, 1)) - PR(ivec3( 0, 0,-1))) / uDx;
  #undef PR
  oVel = vec4(V.xyz - uDt * grad / max(V.w, 0.04), V.w);
}`;

// Empty cells next to fluid get a sensible velocity so that particles skimming
// the surface are not gathered from nothing.
const EXTRAP_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uVel, uAux;
out vec4 oVel;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oVel = vec4(0.0); return; }
  vec4 V = texelFetch(uVel, t, 0);
  if (V.w >= 1e-5) { oVel = V; return; }
  vec3 sum = vec3(0.0);
  float n = 0.0;
  for (int i = 0; i < 6; i++) {
    ivec3 o = ivec3(i == 0 ? 1 : (i == 1 ? -1 : 0), i == 2 ? 1 : (i == 3 ? -1 : 0), i == 4 ? 1 : (i == 5 ? -1 : 0));
    vec4 N = fetchCell(uVel, c + o);
    if (N.w >= 1e-5) { sum += N.xyz; n += 1.0; }
  }
  oVel = vec4(n > 0.5 ? sum / n : V.xyz, V.w);
}`;
