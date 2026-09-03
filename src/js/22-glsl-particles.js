// Particle passes: gather from the grid, move, exchange heat, change state -
// plus the brush, the emitters, and the splat that builds the fields the
// renderer marches through.

const TOOL = { DRAW: 0, ERASE: 1, DRAG: 2, PUSH: 3, HEAT: 4 };

const GLSL_PARTICLE_HEAD = `
uniform ivec2 uPTex;
ivec2 pTexel(int i) { return ivec2(i - (i / uPTex.x) * uPTex.x, i / uPTex.x); }
int pIndex(ivec2 t) { return t.y * uPTex.x + t.x; }
`;

// ------------------------------------------------------------ grid -> particle
const G2P_FS = GLSL_HEAD + GLSL_COMMON + GLSL_PARTICLE_HEAD + `
uniform sampler2D uPos, uVel, uAux;
uniform sampler2D uGVel, uGPre, uGAux, uGPress;
uniform float uDt, uDx, uGravity, uAmbient, uFlip, uBuoyancy, uLatent, uHeatCouple;
uniform float uRestitution, uWallFriction, uPackLimit, uSeparate;
uniform float uGranular, uPressFloor, uFricCap, uCohesionAccel;
uniform vec3 uBrushPos, uBrushVel;
uniform float uBrushRadius, uBrushStrength;
uniform int uBrushTool, uBrushOn;
uniform uint uSeed;

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oAux;

/** Solid fraction (x) and how full the cell is (w), sampled smoothly. */
vec2 fieldAt(vec3 p) { vec4 g = sampleGrid(uGAux, p); return vec2(g.x, g.w); }

void main() {
  ivec2 pt = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, pt, 0);
  vec4 V = texelFetch(uVel, pt, 0);
  vec4 A = texelFetch(uAux, pt, 0);
  int mid = int(P.w + 0.5);
  if (mid == 0) { oPos = vec4(P.xyz, 0.0); oVel = V; oAux = A; return; }

  vec4 m0 = matRow(mid, 0);
  vec4 m3 = matRow(mid, 3);
  vec4 m4 = matRow(mid, 4);
  vec4 m5 = matRow(mid, 5);
  vec4 m7 = matRow(mid, 7);
  vec4 m8 = matRow(mid, 8);
  bool rigid = m3.w > 0.5;
  bool gas = m3.z > 0.5;

  vec3 p = P.xyz;
  // Anything fixed stays put, and forgets whatever it was doing before it set.
  vec3 v = rigid ? vec3(0.0) : V.xyz;
  float temp = V.w;

  // ---- heat: swap with the cell we sit in, then hold or shed our own
  float gridT = sampleGrid(uGAux, p).y;
  temp = mix(temp, gridT, clamp(uHeatCouple * uDt, 0.0, 1.0));
  if (m8.y > 0.0) temp = mix(temp, m8.x, clamp(m8.y * uDt, 0.0, 1.0));

  if (!rigid) {
    // ---- gather velocity: FLIP keeps the detail, PIC keeps it stable
    vec3 vPic = sampleGrid(uGVel, p).xyz;
    vec3 vPre = sampleGrid(uGPre, p).xyz;
    vec3 vFlip = v + (vPic - vPre);
    // Thick liquids lean towards PIC, which is where their damping comes from.
    float flip = uFlip * exp(-m0.y * 400.0);
    v = mix(vPic, vFlip, clamp(flip, 0.0, 1.0));

    // ---- buoyancy (Boussinesq). Gases expand far more than liquids do.
    float beta = gas ? 1.0 / (uAmbient + T_ZERO_C) : 2.1e-4;
    v.y += uBuoyancy * uGravity * beta * (temp - uAmbient) * uDt;

    // ---- Coulomb friction for grains.
    // A grain is held by friction proportional to the weight pressing on it, so
    // deep grains lock solid while the ones on the surface are free to run. The
    // small floor term is the grain's own weight, which is what stops a slope
    // steeper than atan(mu) from creeping away one speck at a time.
    if (m3.y > 0.5 && uGranular > 0.0) {
      // Coulomb friction needs a normal force, and the honest measure of it is how
      // much of gravity the grid just cancelled for this grain: something in free
      // fall keeps the whole of g and is held by nothing, something resting on a
      // heap keeps none of it and is gripped hard. On a slope it lands in between,
      // which is exactly why a heap stops at its angle of repose.
      float supported = clamp(1.0 - (V.y - v.y) / max(uGravity * uDt, 1e-6), 0.0, 1.0);
      float press = max(sampleGrid(uGPress, p).x, 0.0);
      float stop = (m0.z * (press + uPressFloor * supported) / (max(m0.x, 0.05) * uDx) * uGranular
                 + m0.w * uCohesionAccel * (0.25 + 0.75 * supported)) * supported;
      float drop = min(stop, uFricCap) * uDt;
      float sp = length(v);
      if (sp > 1e-5) v *= max(0.0, 1.0 - drop / sp);
    }
  }

  // ---- the brush
  if (uBrushOn == 1) {
    float d = length(p - uBrushPos);
    float fall = 1.0 - smoothstep(uBrushRadius * 0.25, uBrushRadius, d);
    if (fall > 0.0) {
      if (uBrushTool == 1 && d < uBrushRadius) { mid = 0; }
      else if (uBrushTool == 2 && !rigid) v += (uBrushVel - v) * min(1.0, fall * uBrushStrength * uDt * 26.0);
      else if (uBrushTool == 3 && !rigid) {
        vec3 dir = d > 1e-4 ? (p - uBrushPos) / d : vec3(0.0, 1.0, 0.0);
        v += dir * fall * uBrushStrength * uDt * 90.0;
      } else if (uBrushTool == 4) temp += uBrushStrength * fall * uDt * 1400.0;
    }
  }
  if (mid == 0) { oPos = vec4(p, 0.0); oVel = vec4(0.0); oAux = A; return; }

  if (!rigid) {
    // ---- move (midpoint rule, so a particle curving round an obstacle keeps up)
    vec3 mid1 = p + v * (0.5 * uDt / uDx);
    vec3 k2 = sampleGrid(uGVel, clamp(mid1, vec3(0.5), uGrid - 0.5)).xyz;
    vec3 step = mix(v, k2, 0.5) * (uDt / uDx);
    // Never cross more than one cell per step: that is the CFL condition.
    float sl = length(step);
    if (sl > 1.0) step *= 1.0 / sl;
    vec3 prev = p;
    p += step;

    // ---- the walls of the box. The margin keeps a speck's whole splat stencil
    // inside the fluid cells; any closer and half its mass lands in the wall and
    // is thrown away, which the solver reads as the box being emptier than it is.
    vec3 lo = vec3(1.55), hi = uGrid - 1.55;
    if (p.x < lo.x) { p.x = lo.x; v.x = max(v.x, -v.x * uRestitution); v *= uWallFriction; }
    if (p.x > hi.x) { p.x = hi.x; v.x = min(v.x, -v.x * uRestitution); v *= uWallFriction; }
    if (p.y < lo.y) { p.y = lo.y; v.y = max(v.y, -v.y * uRestitution); v *= uWallFriction; }
    if (p.y > hi.y) { p.y = hi.y; v.y = min(v.y, -v.y * uRestitution); v *= uWallFriction; }
    if (p.z < lo.z) { p.z = lo.z; v.z = max(v.z, -v.z * uRestitution); v *= uWallFriction; }
    if (p.z > hi.z) { p.z = hi.z; v.z = min(v.z, -v.z * uRestitution); v *= uWallFriction; }

    // ---- anything fixed in the way, and anywhere too many specks have piled up
    vec2 here = fieldAt(p);
    vec2 px = fieldAt(p + vec3(1.0, 0.0, 0.0)), mx = fieldAt(p - vec3(1.0, 0.0, 0.0));
    vec2 py = fieldAt(p + vec3(0.0, 1.0, 0.0)), my = fieldAt(p - vec3(0.0, 1.0, 0.0));
    vec2 pz = fieldAt(p + vec3(0.0, 0.0, 1.0)), mz = fieldAt(p - vec3(0.0, 0.0, 1.0));
    if (here.x > 0.35) {
      vec3 g = vec3(px.x - mx.x, py.x - my.x, pz.x - mz.x);
      float gl = length(g);
      vec3 n = gl > 1e-4 ? -g / gl : normalize(prev - p + vec3(0.0, 1e-3, 0.0));
      p += n * (here.x - 0.3) * 1.2;
      float vn = dot(v, n);
      if (vn < 0.0) {
        vec3 vt = v - n * vn;
        v = vt * uWallFriction - n * vn * uRestitution;
      }
    }
    // A direct nudge down the density gradient. The pressure solve alone cannot
    // undo the crowding that happens in a single violent step, and crowded cells
    // make the anti-clumping term overreact.
    float over = here.y - uPackLimit;
    if (over > 0.0) {
      vec3 gd = vec3(px.y - mx.y, py.y - my.y, pz.y - mz.y);
      float gl = length(gd);
      // A gentle drift, measured per second: any faster and it churns a settled
      // heap instead of quietly relieving the crowding.
      if (gl > 1e-4) p -= (gd / gl) * min(over, 1.0) * uSeparate * uDt;
    }
    p = clamp(p, vec3(1.55), uGrid - 1.55);
  }

  // ---- change of state, held back by a dwell time that stands in for latent heat
  int target = -1;
  if (temp > m5.z) target = int(m5.w + 0.5);
  else if (temp > m5.x) target = int(m5.y + 0.5);
  else if (temp > m4.x) target = int(m4.y + 0.5);
  else if (temp < m4.z) target = int(m4.w + 0.5);
  float rate = uDt / max(uLatent, 0.02);
  float prog = target >= 0 ? A.z + rate : max(0.0, A.z - rate * 0.7);
  if (target >= 0 && prog >= 1.0) {
    mid = target;
    prog = 0.0;
    A.x = matRow(mid, 7).x;
  }

  // ---- things that only last so long
  vec4 life = matRow(mid, 7);
  if (life.x > 0.0) {
    A.x -= uDt;
    if (A.x <= 0.0) { mid = int(life.y + 0.5); A.x = matRow(mid, 7).x; }
  }

  oPos = vec4(p, float(mid));
  oVel = vec4(v, temp);
  oAux = vec4(A.x, A.y, prog, A.w);
}`;

// The affine velocity field each particle carries, measured across one cell.
const G2P_C_FS = GLSL_HEAD + GLSL_COMMON + GLSL_PARTICLE_HEAD + `
uniform sampler2D uPos, uGVel;
uniform float uCClamp;
layout(location = 0) out vec4 oC0;
layout(location = 1) out vec4 oC1;
layout(location = 2) out vec4 oC2;
void main() {
  ivec2 pt = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, pt, 0);
  if (int(P.w + 0.5) == 0) { oC0 = vec4(0.0); oC1 = vec4(0.0); oC2 = vec4(0.0); return; }
  vec3 p = clamp(P.xyz, vec3(0.6), uGrid - 0.6);
  vec3 dvdx = sampleGrid(uGVel, p + vec3(0.5, 0.0, 0.0)).xyz - sampleGrid(uGVel, p - vec3(0.5, 0.0, 0.0)).xyz;
  vec3 dvdy = sampleGrid(uGVel, p + vec3(0.0, 0.5, 0.0)).xyz - sampleGrid(uGVel, p - vec3(0.0, 0.5, 0.0)).xyz;
  vec3 dvdz = sampleGrid(uGVel, p + vec3(0.0, 0.0, 0.5)).xyz - sampleGrid(uGVel, p - vec3(0.0, 0.0, 0.5)).xyz;
  vec3 r0 = vec3(dvdx.x, dvdy.x, dvdz.x);
  vec3 r1 = vec3(dvdx.y, dvdy.y, dvdz.y);
  vec3 r2 = vec3(dvdx.z, dvdy.z, dvdz.z);
  oC0 = vec4(clamp(r0, -uCClamp, uCClamp), 0.0);
  oC1 = vec4(clamp(r1, -uCClamp, uCClamp), 0.0);
  oC2 = vec4(clamp(r2, -uCClamp, uCClamp), 0.0);
}`;

// -------------------------------------------------------------- new particles
const EMIT_VS = GLSL_HEAD + GLSL_COMMON + GLSL_PARTICLE_HEAD + `
uniform int uBase, uRingStart, uRingSize;
uniform vec3 uSpawnPos, uSpawnVel;
uniform float uSpawnRadius, uSpawnTemp, uSpawnVolume, uJitter;
uniform int uSpawnMat;
uniform uint uSeed;
flat out vec4 vPos;
flat out vec4 vVel;
flat out vec4 vAux;
void main() {
  // Wrap inside the ring only: the slots below uRingStart hold fixed scenery.
  int size = max(uRingSize, 1);
  int rel = (uBase - uRingStart) + gl_VertexID;
  int slot = uRingStart + (rel - (rel / size) * size);
  uint h = hashU(uint(gl_VertexID) * 2654435761u + uSeed);
  vec3 r = hash3(h);
  // Cube-root of a uniform number spreads points evenly through the ball.
  vec3 dir = sphereDir(r.xy);
  float rad = uSpawnRadius * pow(max(hash1(h + 91u), 1e-4), 0.3333333);
  vec3 p = uSpawnPos + dir * rad;
  if (any(lessThan(p, vec3(1.1))) || any(greaterThan(p, uGrid - 1.1))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vPos = vec4(0.0); vVel = vec4(0.0); vAux = vec4(0.0);
    return;
  }
  vPos = vec4(p, float(uSpawnMat));
  vVel = vec4(uSpawnVel + (hash3(h + 41u) - 0.5) * uJitter, uSpawnTemp);
  vAux = vec4(matRow(uSpawnMat, 7).x, hash1(h + 17u), 0.0, uSpawnVolume);
  vec2 texel = vec2(pTexel(slot)) + 0.5;
  gl_Position = vec4(texel / vec2(uPTex) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const EMIT_FS = GLSL_HEAD + `
flat in vec4 vPos;
flat in vec4 vVel;
flat in vec4 vAux;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oAux;
void main() { oPos = vPos; oVel = vVel; oAux = vAux; }`;

/** New particles start with no affine field of their own. */
const EMIT_ZERO_FS = GLSL_HEAD + `
flat in vec4 vPos;
flat in vec4 vVel;
flat in vec4 vAux;
layout(location = 0) out vec4 oC0;
layout(location = 1) out vec4 oC1;
layout(location = 2) out vec4 oC2;
void main() { oC0 = vec4(0.0); oC1 = vec4(0.0); oC2 = vec4(0.0); }`;

// ------------------------------------------------------- fields for the eye
// Weighted by volume rather than mass, so a drop of mercury does not out-vote
// the water around it when deciding what a cell looks like.
const RSPLAT_VS = GLSL_HEAD + GLSL_COMMON + GLSL_PARTICLE_HEAD + `
uniform sampler2D uPos, uVel, uAux;
flat out vec4 vA;   // albedo.rgb * w, w
flat out vec4 vB;   // roughness, metallic, transmission, ior  (condensed only)
flat out vec4 vC;   // absorb.rgb, glow
flat out vec4 vD;   // condensed fill, granular fill, gas fill, temperature * w
void main() {
  int pid = gl_VertexID >> 3;
  int corner = gl_VertexID & 7;
  ivec3 bit = ivec3(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
  ivec2 pt = pTexel(pid);
  vec4 P = texelFetch(uPos, pt, 0);
  int mid = int(P.w + 0.5);
  vec3 q = P.xyz - 0.5;
  ivec3 base = ivec3(floor(q));
  vec3 f = q - vec3(base);
  ivec3 c = base + bit;
  vec3 wv = mix(1.0 - f, f, vec3(bit));
  float w = wv.x * wv.y * wv.z;
  if (mid == 0 || !inGrid(c) || w < 1e-5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = vec4(0.0); vB = vec4(0.0); vC = vec4(0.0); vD = vec4(0.0);
    return;
  }
  vec4 m1 = matRow(mid, 1);
  vec4 m2 = matRow(mid, 2);
  vec4 m3 = matRow(mid, 3);
  vec4 m6 = matRow(mid, 6);
  vec4 V = texelFetch(uVel, pt, 0);
  vec4 A = texelFetch(uAux, pt, 0);
  float vol = w * max(A.w, 1e-3);
  float cond = vol * (1.0 - m3.z);          // everything that is not a gas

  vA = vec4(m1.rgb * vol, vol);
  vB = vec4(m2.x, m2.y, m2.w, m2.z) * cond;
  vC = vec4(m6.rgb * cond, m1.a * vol);
  vD = vec4(cond, m3.y * vol, m3.z * vol, V.w * vol);

  vec2 texel = vec2(cellTexel(c)) + 0.5;
  gl_Position = vec4(texel / uAtlas * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const RSPLAT_FS = GLSL_HEAD + `
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
layout(location = 3) out vec4 oD;
void main() { oA = vA; oB = vB; oC = vC; oD = vD; }`;

/** One axis of a [1 2 1] blur, run three times to soften the fields into a surface. */
const RBLUR_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uA, uB, uC, uD;
uniform ivec3 uStep;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
layout(location = 3) out vec4 oD;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oA = vec4(0.0); oB = vec4(0.0); oC = vec4(0.0); oD = vec4(0.0); return; }
  ivec3 lo = c - uStep, hi = c + uStep;
  oA = 0.25 * (fetchCell(uA, lo) + 2.0 * texelFetch(uA, t, 0) + fetchCell(uA, hi));
  oB = 0.25 * (fetchCell(uB, lo) + 2.0 * texelFetch(uB, t, 0) + fetchCell(uB, hi));
  oC = 0.25 * (fetchCell(uC, lo) + 2.0 * texelFetch(uC, t, 0) + fetchCell(uC, hi));
  oD = 0.25 * (fetchCell(uD, lo) + 2.0 * texelFetch(uD, t, 0) + fetchCell(uD, hi));
}`;
