// The renderer. Rays are marched through the fields the simulation just splatted:
// the surface is where the fill fraction crosses 0.5, shading is Cook-Torrance
// GGX over a metallic-roughness description of the material, and light that
// leaves a surface is followed - reflected, refracted, or towards the sun for a
// shadow - by marching the very same fields again.

// A coarse "is there anything in this block" volume, so empty space costs almost
// nothing to cross. Dilated by a cell so a nearest lookup is always safe.
const COARSE_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uSrc;
uniform vec3 uCGrid;
uniform vec2 uCTiles;
uniform float uScale;
out vec4 oMax;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 g = ivec3(uCGrid + 0.5);
  int tx = int(uCTiles.x + 0.5);
  ivec2 tile = ivec2(t.x / g.x, t.y / g.y);
  ivec3 c = ivec3(t.x - tile.x * g.x, t.y - tile.y * g.y, tile.y * tx + tile.x);
  if (c.z >= g.z) { oMax = vec4(0.0); return; }
  int s = int(uScale + 0.5);
  ivec3 lo = c * s - 1;
  float best = 0.0;
  for (int z = 0; z < 8; z++) {
    if (z > s + 1) break;
    for (int y = 0; y < 8; y++) {
      if (y > s + 1) break;
      for (int x = 0; x < 8; x++) {
        if (x > s + 1) break;
        vec4 v = fetchCell(uSrc, lo + ivec3(x, y, z));
        best = max(best, max(v.x, v.z));   // condensed or gas
      }
    }
  }
  oMax = vec4(best);
}`;

// ---------------------------------------------------------------- ray library
const RAY_LIB = `
uniform sampler2D uFA, uFB, uFC, uFD;    // albedo/fill, surface, absorption, phases
uniform sampler2D uCoarse, uCaustic;
uniform vec3 uCGrid;
uniform vec2 uCTiles, uCAtlas;
uniform float uCoarseScale;
uniform float uIso, uDx, uClarity, uShadowSigma, uGasSigma, uGlowGain, uFloorY;
uniform int uDoShadows, uDoReflect, uDoRefract, uDoCaustics, uDoGas;
uniform int uSurfSteps, uShadowSteps;
uniform float uSurfStep;
uniform uint uFrameSeed;

struct Surf {
  vec3 albedo; float rough; float metal; float trans; float ior;
  vec3 absorb; float glow; float temp;
};

float fillAt(vec3 p) { return sampleGrid(uFD, p).x; }
float gasAt(vec3 p) { return sampleGrid(uFD, p).z; }

float coarseMax(vec3 p) {
  ivec3 g = ivec3(uCGrid + 0.5);
  ivec3 c = ivec3(floor(p / uCoarseScale));
  // Outside the box there is nothing, and saying so keeps a shadow the shape of
  // what casts it rather than the shape of the box.
  if (any(lessThan(c, ivec3(0))) || any(greaterThanEqual(c, g))) return 0.0;
  int tx = int(uCTiles.x + 0.5);
  return texelFetch(uCoarse, ivec2((c.z - (c.z / tx) * tx) * g.x + c.x, (c.z / tx) * g.y + c.y), 0).x;
}

/** How far until the ray leaves the coarse block it is standing in. */
float blockExit(vec3 p, vec3 rd) {
  float C = uCoarseScale;
  vec3 cell = floor(p / C) * C;
  vec3 d = mix(p - cell, cell + C - p, step(0.0, rd)) / max(abs(rd), vec3(1e-6));
  return max(min(d.x, min(d.y, d.z)), 0.0) + 1e-3;
}

vec2 boxRange(vec3 ro, vec3 rd, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / (rd + vec3(equal(rd, vec3(0.0))) * 1e-9);
  vec3 a = (lo - ro) * inv;
  vec3 b = (hi - ro) * inv;
  vec3 tmin = min(a, b), tmax = max(a, b);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// The floor of the box is opaque, so nothing is ever traced below it.
vec3 boxLo() { return vec3(0.75, uFloorY, 0.75); }
vec3 boxHi() { return uGrid - 0.75; }

Surf surfAt(vec3 p) {
  vec4 A = sampleGrid(uFA, p);
  vec4 B = sampleGrid(uFB, p);
  vec4 C = sampleGrid(uFC, p);
  vec4 D = sampleGrid(uFD, p);
  float w = max(A.w, 1e-4);
  float cd = max(D.x, 1e-4);
  Surf s;
  s.albedo = clamp(A.rgb / w, 0.0, 1.0);
  s.rough = clamp(B.x / cd, 0.045, 1.0);
  s.metal = clamp(B.y / cd, 0.0, 1.0);
  s.trans = clamp(B.z / cd, 0.0, 1.0);
  s.ior = clamp(B.w / cd, 1.0, 2.5);
  s.absorb = max(C.rgb / cd, vec3(0.0));
  s.glow = max(C.w / w, 0.0);
  s.temp = D.w / w;
  return s;
}

/** Outward normal from the gradient of the fill fraction (tetrahedron taps). */
vec3 normalAt(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  float h = 0.75;
  vec3 g = k.xyy * fillAt(p + k.xyy * h) + k.yyx * fillAt(p + k.yyx * h)
         + k.yxy * fillAt(p + k.yxy * h) + k.xxx * fillAt(p + k.xxx * h);
  float l = length(g);
  return l > 1e-6 ? -g / l : vec3(0.0, 1.0, 0.0);
}

struct Hit { bool hit; float t; };

/** Walk until the fill fraction crosses the surface, then bisect onto it. */
Hit marchSurface(vec3 ro, vec3 rd, float t0, float t1) {
  Hit h;
  h.hit = false;
  h.t = t1;
  float t = t0;
  for (int i = 0; i < 512; i++) {
    if (i >= uSurfSteps || t >= t1) break;
    vec3 p = ro + rd * t;
    if (coarseMax(p) < uIso) { t += blockExit(p, rd); continue; }
    float nt = min(t + uSurfStep, t1);
    if (fillAt(ro + rd * nt) >= uIso) {
      float a = t, b = nt;
      for (int k = 0; k < 6; k++) {
        float m = 0.5 * (a + b);
        if (fillAt(ro + rd * m) >= uIso) b = m; else a = m;
      }
      h.hit = true;
      h.t = b;
      return h;
    }
    t = nt;
  }
  return h;
}

/**
 * How much sunlight survives the journey from p up to the sky, per colour.
 * Opaque material simply blocks; clear material absorbs by Beer-Lambert over the
 * distance actually travelled, which is why the floor under water is lit blue-green
 * rather than being in pitch darkness.
 */
vec3 sunVisibility(vec3 p) {
  if (uDoShadows == 0) return vec3(1.0);
  vec3 rd = uSunDir;
  // Skip straight to where the ray meets the box; a point on the floor well
  // outside it would otherwise spend its whole step budget crossing open ground.
  vec2 br = boxRange(p, rd, boxLo(), boxHi());
  float t1 = br.y;
  float t = max(br.x, 0.9);
  if (t1 <= t) return vec3(1.0);
  vec3 trans = vec3(1.0);
  float dt = 0.85;
  for (int i = 0; i < 192; i++) {
    if (i >= uShadowSteps || t >= t1) break;
    vec3 q = p + rd * t;
    if (coarseMax(q) < uIso * 0.4) { t += blockExit(q, rd); continue; }
    vec4 D = sampleGrid(uFD, q);
    if (D.x + D.z > 1e-3) {
      float cd = max(D.x, 1e-4);
      float clear = clamp(sampleGrid(uFB, q).z / cd, 0.0, 1.0);
      vec3 absorb = max(sampleGrid(uFC, q).rgb / cd, vec3(0.0));
      float blocked = D.x * (1.0 - clear) * uShadowSigma + D.z * uGasSigma * 0.5;
      vec3 soaked = absorb * D.x * clear * uDx * uClarity;
      trans *= exp(-(vec3(blocked) + soaked) * dt);
      if (max(trans.r, max(trans.g, trans.b)) < 0.01) return vec3(0.0);
    }
    t += dt;
  }
  return trans;
}

/** Extra sunlight focused onto this point by the water above it. */
float causticAt(vec3 p) {
  if (uDoCaustics == 0) return 0.0;
  return max(sampleGrid(uCaustic, p).x, 0.0);
}

/** Light emitted because the material is hot, straight from Planck's law. */
vec3 emissionOf(Surf s) {
  if (s.glow < 1e-3 || s.temp < 420.0) return vec3(0.0);
  float k = smoothstep(420.0, 700.0, s.temp);
  return blackbody(s.temp + T_ZERO_C) * thermalPower(s.temp) * s.glow * k * uGlowGain;
}

vec3 fresnel0(Surf s) {
  float f = (s.ior - 1.0) / (s.ior + 1.0);
  return mix(vec3(f * f), s.albedo, s.metal);
}

/** Cook-Torrance for one light, plus the sky as an ambient dome. */
vec3 shadeDirect(Surf s, vec3 n, vec3 v, vec3 vis, float caustic) {
  vec3 f0 = fresnel0(s);
  vec3 diffuseCol = s.albedo * (1.0 - s.metal);
  vec3 l = uSunDir;
  float NoL = max(dot(n, l), 0.0);
  float NoV = max(dot(n, v), 1e-4);
  vec3 col = vec3(0.0);
  if (NoL > 0.0 && max(vis.r, max(vis.g, vis.b)) > 0.0) {
    vec3 h = normalize(l + v);
    float a = s.rough * s.rough;
    // The sun is a disc about half a degree across, not a point. Widening the
    // lobe to at least that (and taking the energy back out) is what stops a
    // near-mirror surface from turning into a field of white sparks.
    const float SUN_A = 0.0047;
    float aw = min(a + SUN_A, 1.0);
    float energy = (a / aw) * (a / aw);
    float spec = D_GGX(max(dot(n, h), 0.0), aw) * V_SmithGGX(NoV, NoL, aw) * energy;
    vec3 F = F_Schlick(f0, max(dot(h, v), 0.0));
    vec3 sun = uSunColour * NoL * vis * (1.0 + caustic);
    col += sun * (diffuseCol * INV_PI * (1.0 - F) + F * min(spec, 30.0));
  }
  col += diffuseCol * skyIrradiance(n) * INV_PI;
  return col;
}

vec3 environment(vec3 ro, vec3 rd);

/** A one-bounce shade for rays that are already secondary - no more recursion. */
vec3 shadeCheap(vec3 p, vec3 n, vec3 rd) {
  Surf s = surfAt(p);
  vec3 vis = sunVisibility(p + n * 0.9);
  vec3 col = shadeDirect(s, n, -rd, vis, causticAt(p));
  col += emissionOf(s);
  // Clear material seen by a secondary ray still has to let the world behind it
  // through, or water hidden behind water comes out black.
  if (s.trans > 0.05) {
    float F = fresnelDielectric(max(dot(n, -rd), 0.0), 1.0 / s.ior);
    vec3 behind = environment(p + rd * 2.0, rd);
    col = mix(mix(behind, col, F), col, 1.0 - s.trans);
  }
  return col;
}

vec3 floorColour(vec3 p, vec3 rd) {
  vec2 q = p.xz / uGrid.x;
  float grid = smoothstep(0.02, 0.05, min(abs(fract(q.x * 4.0) - 0.5), abs(fract(q.y * 4.0) - 0.5)));
  vec3 albedo = mix(vec3(0.16, 0.155, 0.15), vec3(0.24, 0.235, 0.23), grid);
  vec3 n = vec3(0.0, 1.0, 0.0);
  Surf s;
  s.albedo = albedo; s.rough = 0.55; s.metal = 0.0; s.trans = 0.0; s.ior = 1.5;
  s.absorb = vec3(0.0); s.glow = 0.0; s.temp = 20.0;
  vec3 vis = sunVisibility(p + n * 0.6);
  return shadeDirect(s, n, -rd, vis, causticAt(p));
}

/** Sky, sun, and the ground plane the box stands on. */
vec3 environment(vec3 ro, vec3 rd) {
  // A ray that has slipped under the floor (refraction through a shallow pool
  // does this constantly) still sees the floor, not the dark underside of the sky.
  if (ro.y <= uFloorY + 1e-3) {
    return floorColour(vec3(ro.x, uFloorY, ro.z), vec3(rd.x, -abs(rd.y) - 0.2, rd.z));
  }
  if (rd.y < -1e-4) {
    float t = (uFloorY - ro.y) / rd.y;
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      float r = length(p.xz - uGrid.xz * 0.5) / uGrid.x;
      // Far ground fades into the colour of the sky at the horizon rather than
      // into the dim underside of it, which is what makes a haze read as haze.
      vec3 haze = skyRadiance(normalize(vec3(rd.x, 0.03, rd.z) + vec3(1e-5)));
      if (r < 9.0) return mix(floorColour(p, rd), haze, smoothstep(2.5, 8.0, r));
      return haze;
    }
  }
  return skyRadiance(rd) + sunRadiance(rd);
}

/** Follow a secondary ray: another surface if it meets one, otherwise the sky. */
vec3 traceSecondary(vec3 ro, vec3 rd) {
  vec2 br = boxRange(ro, rd, boxLo(), boxHi());
  float t0 = max(br.x, 0.0);
  if (br.y > t0) {
    Hit h = marchSurface(ro, rd, t0, br.y);
    if (h.hit) {
      vec3 p = ro + rd * h.t;
      return shadeCheap(p, normalAt(p), rd);
    }
  }
  return environment(ro, rd);
}

/**
 * Refraction. Snell's law in and out again, Beer-Lambert absorption over the
 * distance actually travelled through the liquid, and total internal reflection
 * handled properly - which is where most of water's character comes from.
 */
vec3 traceRefraction(vec3 p, vec3 n, vec3 rd, Surf s) {
  vec3 dir = refract(rd, n, 1.0 / s.ior);
  if (dot(dir, dir) < 1e-6) dir = reflect(rd, n);
  vec3 pos = p + dir * 0.6;
  vec3 atten = vec3(1.0);
  for (int bounce = 0; bounce < 3; bounce++) {
    float far = boxRange(pos, dir, boxLo(), boxHi()).y;
    float d = 0.0;
    bool left = false;
    for (int i = 0; i < 128; i++) {
      if (d >= far) break;
      d += 0.75;
      if (fillAt(pos + dir * d) < uIso) { left = true; break; }
    }
    atten *= exp(-s.absorb * d * uDx * uClarity);
    if (max(atten.r, max(atten.g, atten.b)) < 0.01) return vec3(0.0);
    if (!left) return atten * environment(pos + dir * d, dir);
    vec3 ep = pos + dir * d;
    vec3 nOut = normalAt(ep);
    vec3 outDir = refract(dir, -nOut, s.ior);
    if (dot(outDir, outDir) < 1e-6) {          // total internal reflection
      dir = reflect(dir, nOut);
      pos = ep - nOut * 0.6;
      continue;
    }
    return atten * traceSecondary(ep + outDir * 0.7, outDir);
  }
  return atten * environment(pos, dir);
}

/** Steam, smoke and flame, gathered along the ray as participating media. */
vec4 gatherGas(vec3 ro, vec3 rd, float t0, float t1) {
  if (uDoGas == 0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float dt = 1.25;
  float t = t0;
  // Sunlight through smoke changes slowly along a ray, so it is traced once every
  // few samples rather than at every one; the alternative is thousands of shadow
  // marches for a single pixel.
  vec3 vis = vec3(1.0);
  int stale = 99;
  // Start each pixel at a different offset along the ray. Marching a volume on a
  // fixed lattice draws the lattice; dithering turns that into noise, which the
  // temporal accumulation then averages away.
  t += dt * hash1(uint(gl_FragCoord.x) * 73856093u + uint(gl_FragCoord.y) * 19349663u + uFrameSeed);
  for (int i = 0; i < 128; i++) {
    if (t >= t1 || trans < 0.01) break;
    vec3 q = ro + rd * t;
    if (coarseMax(q) < 0.02) { t += blockExit(q, rd); continue; }
    vec4 D = sampleGrid(uFD, q);
    float g = D.z;
    if (g > 1e-3) {
      if (stale >= 5) { vis = sunVisibility(q); stale = 0; }
      stale++;
      vec4 A = sampleGrid(uFA, q);
      vec4 C = sampleGrid(uFC, q);
      float w = max(A.w, 1e-4);
      vec3 albedo = clamp(A.rgb / w, 0.0, 1.0);
      float temp = D.w / w;
      float glow = max(C.w / w, 0.0);
      float sigma = g * uGasSigma;
      float a = 1.0 - exp(-sigma * dt);
      vec3 lit = albedo * (uSunColour * vis * 0.5 + skyIrradiance(vec3(0.0, 1.0, 0.0)) * INV_PI);
      if (glow > 1e-3 && temp > 420.0) {
        lit += blackbody(temp + T_ZERO_C) * thermalPower(temp) * glow * uGlowGain
             * smoothstep(420.0, 700.0, temp);
      }
      acc += trans * a * lit;
      trans *= 1.0 - a;
    }
    t += dt;
  }
  return vec4(acc, trans);
}
`;

// ------------------------------------------------------------- primary trace
const TRACE_FS = GLSL_HEAD + GLSL_COMMON + RAY_LIB + `
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform vec2 uRes, uJitter;
uniform float uReflectGain;
uniform sampler2D uGVel, uGAux, uPress;
uniform int uView;
out vec4 oColour;

/** False-colour ramp for the inspection views. */
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(1.6 * t - 0.3, 1.4 * sin(3.1416 * t), 1.5 - 2.2 * t), 0.0, 1.0);
}

/** What the solver is thinking, rather than what the scene looks like. */
vec3 inspect(vec3 ro, vec3 rd, float t0, float t1, bool hit, float tHit, vec3 p, vec3 n) {
  if (uView == 2) return hit ? n * 0.5 + 0.5 : vec3(0.05);
  if (uView == 1) return hit ? surfAt(p).albedo : vec3(0.05);
  if (uView == 5) return hit ? sunVisibility(p + n * 0.9) : vec3(0.05);
  if (uView == 6) return hit ? ramp(causticAt(p) * 0.5) : vec3(0.02);
  // Volume readouts: take the largest value seen along the ray.
  float best = 0.0;
  float t = t0;
  for (int i = 0; i < 256; i++) {
    if (t >= min(t1, hit ? tHit + 1.0 : t1)) break;
    vec3 q = ro + rd * t;
    if (coarseMax(q) < 0.02) { t += blockExit(q, rd); continue; }
    vec4 D = sampleGrid(uFD, q);
    float w = max(sampleGrid(uFA, q).w, 1e-4);
    if (D.x + D.z > 0.05) {
      if (uView == 3) best = max(best, (D.w / w + 60.0) / 1300.0);
      else if (uView == 4) best = max(best, length(sampleGrid(uGVel, q).xyz) / 8.0);
      else if (uView == 7) best = max(best, sampleGrid(uPress, q).x * 0.02);
      else if (uView == 8) best = max(best, D.x);
    }
    t += 0.7;
  }
  return ramp(best);
}

void main() {
  vec2 uv = (gl_FragCoord.xy + uJitter) / uRes * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + uCamRight * uv.x + uCamUp * uv.y);

  vec2 br = boxRange(ro, rd, boxLo(), boxHi());
  float tEnter = max(br.x, 0.0);
  float tLeave = br.y;

  vec3 colour;
  float depth = 1e9;
  if (tLeave <= tEnter) {
    colour = environment(ro, rd);
  } else {
    Hit h = marchSurface(ro, rd, tEnter, tLeave);
    if (h.hit) {
      depth = h.t;
      vec3 p = ro + rd * h.t;
      vec3 n = normalAt(p);
      if (dot(n, rd) > 0.0) n = -n;
      Surf s = surfAt(p);
      vec3 vis = sunVisibility(p + n * 0.9);
      colour = shadeDirect(s, n, -rd, vis, causticAt(p));

      float cosI = max(dot(n, -rd), 0.0);
      float F = fresnelDielectric(cosI, 1.0 / s.ior);
      vec3 Fspec = mix(vec3(F), F_Schlick(s.albedo, cosI), s.metal);

      if (uDoReflect == 1) {
        // Rough surfaces scatter their reflection; smooth ones mirror it.
        vec3 refl = normalize(mix(reflect(rd, n), n, s.rough * s.rough * 0.85));
        vec3 rc = traceSecondary(p + n * 0.8, refl);
        colour = mix(colour, rc, clamp(Fspec.g * uReflectGain, 0.0, 1.0) * (1.0 - s.rough * 0.6));
        colour += rc * Fspec * s.metal * 0.65;
      }
      if (uDoRefract == 1 && s.trans > 0.05 && s.metal < 0.5) {
        vec3 through = traceRefraction(p, n, rd, s);
        colour = mix(colour, mix(through, colour, F), s.trans);
      }
      colour += emissionOf(s);
    } else {
      colour = environment(ro, rd);
      vec2 fr = boxRange(ro, rd, boxLo(), boxHi());
      depth = min(fr.y, 1e9);
    }
  }

  if (uView > 0) {
    bool hit = depth < 1e8;
    vec3 hp = ro + rd * depth;
    vec3 hn = hit ? normalAt(hp) : vec3(0.0);
    if (hit && dot(hn, rd) > 0.0) hn = -hn;
    oColour = vec4(inspect(ro, rd, tEnter, tLeave, hit, depth, hp, hn), depth);
    return;
  }

  vec4 gas = gatherGas(ro, rd, tEnter, min(depth, tLeave));
  colour = colour * gas.w + gas.rgb;
  oColour = vec4(max(colour, vec3(0.0)), depth);
}`;

// ------------------------------------------------------------------ caustics
// Photons leave the sun on a lattice, bend through every water surface they meet
// and are dropped where they land. The volume that builds up is real focused
// light, not a painted-on pattern.
const PHOTON_FS = GLSL_HEAD + GLSL_COMMON + RAY_LIB + `
uniform vec2 uPhotonRes;
uniform uint uSeed;
out vec4 oDrop;
void main() {
  vec2 id = gl_FragCoord.xy;
  uint h = hashU(uint(id.y * uPhotonRes.x + id.x) + uSeed * 9781u);
  vec2 jitter = vec2(hash1(h), hash1(h + 3u));
  vec2 uv = (id + jitter) / uPhotonRes;

  // Build a square of starting points facing the sun, outside the box.
  vec3 centre = uGrid * 0.5;
  vec3 up = abs(uSunDir.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 ex = normalize(cross(up, uSunDir));
  vec3 ey = normalize(cross(uSunDir, ex));
  float span = length(uGrid) * 0.62;
  vec3 ro = centre + uSunDir * span + (uv.x - 0.5) * 2.0 * span * ex + (uv.y - 0.5) * 2.0 * span * ey;
  vec3 rd = -uSunDir;

  vec2 br = boxRange(ro, rd, boxLo(), boxHi());
  if (br.y <= max(br.x, 0.0)) { oDrop = vec4(0.0); return; }
  float t = max(br.x, 0.0);
  vec3 energy = vec3(1.0);

  for (int seg = 0; seg < 4; seg++) {
    Hit hit = marchSurface(ro, rd, t + 0.01, br.y);
    if (!hit.hit) { oDrop = vec4(0.0); return; }
    vec3 p = ro + rd * hit.t;
    vec3 n = normalAt(p);
    if (dot(n, rd) > 0.0) n = -n;
    Surf s = surfAt(p);
    if (s.trans < 0.35 || s.metal > 0.5) {
      // Opaque: this is where the focused light lands.
      oDrop = vec4(p, max(energy.g, 0.0));
      return;
    }
    float F = fresnelDielectric(max(dot(n, -rd), 0.0), 1.0 / s.ior);
    energy *= (1.0 - F);
    vec3 dir = refract(rd, n, 1.0 / s.ior);
    if (dot(dir, dir) < 1e-6) { oDrop = vec4(0.0); return; }
    // Cross the medium and refract out again.
    float d = 0.0;
    bool left = false;
    for (int i = 0; i < 96; i++) {
      if (d > length(uGrid)) break;
      d += 0.8;
      if (fillAt(p + dir * d) < uIso) { left = true; break; }
    }
    if (!left) { oDrop = vec4(0.0); return; }
    energy *= exp(-s.absorb * d * uDx * uClarity);
    vec3 ep = p + dir * d;
    vec3 nOut = normalAt(ep);
    vec3 outDir = refract(dir, -nOut, s.ior);
    if (dot(outDir, outDir) < 1e-6) { oDrop = vec4(0.0); return; }
    ro = ep + outDir * 0.4;
    rd = outDir;
    br = boxRange(ro, rd, boxLo(), boxHi());
    t = 0.0;
    if (br.y <= 0.0) { oDrop = vec4(0.0); return; }
  }
  oDrop = vec4(0.0);
}`;

const PHOTON_SPLAT_VS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uDrops;
uniform ivec2 uPhotonSize;
uniform float uPhotonGain;
flat out float vEnergy;
void main() {
  ivec2 t = ivec2(gl_VertexID - (gl_VertexID / uPhotonSize.x) * uPhotonSize.x, gl_VertexID / uPhotonSize.x);
  vec4 d = texelFetch(uDrops, t, 0);
  ivec3 c = ivec3(floor(d.xyz));
  if (d.w <= 1e-4 || !inGrid(c)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vEnergy = 0.0;
    return;
  }
  vEnergy = d.w * uPhotonGain;
  vec2 texel = vec2(cellTexel(c)) + 0.5;
  gl_Position = vec4(texel / uAtlas * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const PHOTON_SPLAT_FS = GLSL_HEAD + `
flat in float vEnergy;
out vec4 oE;
void main() { oE = vec4(vEnergy, 0.0, 0.0, 0.0); }`;

/** Blur and fade the caustic volume - photons are noisy, light is not. */
const CAUSTIC_BLUR_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uSrc, uPrev;
uniform ivec3 uStep;
uniform float uBlend;
out vec4 oE;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = texelCell(t);
  if (c.z >= gridSize().z) { oE = vec4(0.0); return; }
  float v = 0.25 * (fetchCell(uSrc, c - uStep).x + 2.0 * texelFetch(uSrc, t, 0).x + fetchCell(uSrc, c + uStep).x);
  if (uBlend > 0.0) v = mix(texelFetch(uPrev, t, 0).x, v, uBlend);
  oE = vec4(v);
}`;
