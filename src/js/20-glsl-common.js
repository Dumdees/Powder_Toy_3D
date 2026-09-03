// GLSL shared by every shader in the app: the 3D-grid-in-a-2D-texture indexing,
// the material lookup, and the small library of physical helpers (Planck's law,
// Fresnel, GGX, ACES). Prepended to each fragment shader.

const GLSL_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const GLSL_COMMON = `
const float PI = 3.141592653589793;
const float INV_PI = 0.3183098861837907;
const float T_ZERO_C = 273.15;

// ---------------------------------------------------------------- grid atlas
// A grid of nx*ny*nz cells is stored as nz slices of nx*ny, tiled tx across and
// ty down one 2D texture. Cell (i,j,k) has its centre at (i+0.5, j+0.5, k+0.5).
uniform vec3 uGrid;    // nx, ny, nz
uniform vec2 uTiles;   // tx, ty
uniform vec2 uAtlas;   // texture size

ivec3 gridSize() { return ivec3(uGrid + 0.5); }

ivec2 cellTexel(ivec3 c) {
  int tx = int(uTiles.x + 0.5);
  ivec3 n = gridSize();
  return ivec2((c.z - (c.z / tx) * tx) * n.x + c.x, (c.z / tx) * n.y + c.y);
}

/** Inverse of cellTexel; z may land past the end when the atlas has spare tiles. */
ivec3 texelCell(ivec2 t) {
  ivec3 n = gridSize();
  int tx = int(uTiles.x + 0.5);
  ivec2 tile = ivec2(t.x / n.x, t.y / n.y);
  return ivec3(t.x - tile.x * n.x, t.y - tile.y * n.y, tile.y * tx + tile.x);
}

bool inGrid(ivec3 c) {
  ivec3 n = gridSize();
  return c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < n.x && c.y < n.y && c.z < n.z;
}

vec4 fetchCell(sampler2D s, ivec3 c) {
  if (!inGrid(c)) return vec4(0.0);
  return texelFetch(s, cellTexel(c), 0);
}

/** uv of a point inside one z-slice, clamped so bilinear taps never cross tiles. */
vec2 sliceUV(vec2 xy, int z) {
  int tx = int(uTiles.x + 0.5);
  vec2 org = vec2(float(z - (z / tx) * tx) * uGrid.x, float(z / tx) * uGrid.y);
  return (org + clamp(xy, vec2(0.5), uGrid.xy - 0.5)) / uAtlas;
}

/** Trilinear sample. p is in cell units - hardware does x and y, we do z. */
vec2 sliceUVOf(vec2 xy, int z, vec3 g, vec2 tiles, vec2 atlas) {
  int tx = int(tiles.x + 0.5);
  vec2 org = vec2(float(z - (z / tx) * tx) * g.x, float(z / tx) * g.y);
  return (org + clamp(xy, vec2(0.5), g.xy - 0.5)) / atlas;
}

/** Trilinear sample of a field with its own resolution (the coarse skip volume). */
vec4 sampleAt(sampler2D s, vec3 p, vec3 g, vec2 tiles, vec2 atlas) {
  float zc = clamp(p.z - 0.5, 0.0, g.z - 1.0);
  int z0 = int(zc);
  int z1 = min(z0 + 1, int(g.z) - 1);
  return mix(texture(s, sliceUVOf(p.xy, z0, g, tiles, atlas)),
             texture(s, sliceUVOf(p.xy, z1, g, tiles, atlas)), zc - float(z0));
}

vec4 sampleGrid(sampler2D s, vec3 p) { return sampleAt(s, p, uGrid, uTiles, uAtlas); }

// ------------------------------------------------------------ material table
uniform sampler2D uMat;
vec4 matRow(int id, int row) { return texelFetch(uMat, ivec2(row, id), 0); }
// row 0 density(rel) viscosity friction cohesion   | row 1 albedo.rgb glow
// row 2 roughness metallic ior transmission        | row 3 liquid granular gas rigid
// row 4 meltAt meltInto freezeAt freezeInto        | row 5 boilAt boilInto burnAt burnInto
// row 6 absorb.rgb thermalDiffusivity              | row 7 life expiresInto surfaceTension startTemp

// ------------------------------------------------------------------- hashing
uint hashU(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float hash1(uint n) { return float(hashU(n) & 0x00ffffffu) / 16777216.0; }
vec3 hash3(uint n) { return vec3(hash1(n), hash1(n + 1u), hash1(n + 2u)); }
/** Uniform point on the sphere from two [0,1) numbers. */
vec3 sphereDir(vec2 u) {
  float z = 1.0 - 2.0 * u.x;
  float r = sqrt(max(0.0, 1.0 - z * z));
  float a = 2.0 * PI * u.y;
  return vec3(r * cos(a), r * sin(a), z);
}
/** Cosine-weighted hemisphere sample around n - the correct density for Lambert. */
vec3 cosineDir(vec3 n, vec2 u) {
  vec3 d = sphereDir(u);
  return normalize(n + d * 0.9999);
}

// ------------------------------------------------------- colour and radiance
/** Planck's law along the Planckian locus, in linear sRGB, peak normalised to 1. */
vec3 blackbody(float tempK) {
  float t = clamp(tempK, 1000.0, 20000.0);
  float u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t)
          / (1.0 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  float v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t)
          / (1.0 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  float d = 2.0 * u - 8.0 * v + 4.0;
  float x = 3.0 * u / d;
  float y = 2.0 * v / d;
  vec3 XYZ = vec3(x / y, 1.0, (1.0 - x - y) / y);
  mat3 toRGB = mat3( 3.2404542, -0.9692660,  0.0556434,
                    -1.5371385,  1.8760108, -0.2040259,
                    -0.4985314,  0.0415560,  1.0572252);
  return max(toRGB * XYZ, vec3(0.0));
}

/** Stefan-Boltzmann: emitted radiance rises with the fourth power of temperature. */
float thermalPower(float tempC) {
  float k = max(tempC + T_ZERO_C, 0.0) / 1000.0;
  return k * k * k * k;
}

vec3 acesFilm(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// -------------------------------------------------------------- microfacets
/** Trowbridge-Reitz (GGX) normal distribution. */
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-7);
}
/** Height-correlated Smith visibility, already divided by 4 NoL NoV. */
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-7);
}
vec3 F_Schlick(vec3 f0, float u) {
  float f = pow(1.0 - u, 5.0);
  return f0 + (1.0 - f0) * f;
}
/** Exact unpolarised Fresnel for a dielectric - what water actually does. */
float fresnelDielectric(float cosI, float eta) {
  float s2 = eta * eta * (1.0 - cosI * cosI);
  if (s2 > 1.0) return 1.0;                       // total internal reflection
  float cosT = sqrt(1.0 - s2);
  float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  float rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return clamp(0.5 * (rs * rs + rp * rp), 0.0, 1.0);
}

// ----------------------------------------------------------------------- sky
uniform vec3 uSunDir;         // points towards the sun
uniform vec3 uSunColour;      // radiance of the disc
uniform float uSkyGain;
uniform float uTurbidity;

/** Cheap single-scattering sky: Rayleigh plus Mie against a ground bounce. */
vec3 skyRadiance(vec3 dir) {
  vec3 rayleigh = vec3(5.802, 13.558, 33.1) * 1e-3;
  float up = clamp(dir.y, -1.0, 1.0);
  float mu = clamp(dot(dir, uSunDir), -1.0, 1.0);
  // Optical depth grows sharply towards the horizon.
  float h = max(up, 0.0);
  float depth = 1.0 / (h + 0.12);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.76 * clamp(uTurbidity, 0.0, 1.0);
  float g2 = g * g;
  float phaseM = (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  vec3 col = rayleigh * depth * 60.0 * phaseR
           + vec3(0.9, 0.92, 0.95) * depth * phaseM * (0.9 * uTurbidity + 0.06);
  // Below the horizon we see the ground: a dim, desaturated bounce.
  vec3 ground = vec3(0.13, 0.12, 0.11) * (0.35 + 0.65 * max(uSunDir.y, 0.0));
  col = mix(ground, col, smoothstep(-0.06, 0.06, up));
  col *= max(uSunDir.y * 0.85 + 0.15, 0.03);
  return col * uSkyGain;
}

/** The sun disc itself, ~0.53 degrees across. */
vec3 sunRadiance(vec3 dir) {
  float c = dot(dir, uSunDir);
  return uSunColour * smoothstep(0.99987, 0.99995, c) * 40.0;
}

/**
 * Irradiance arriving on a surface facing n, from the sky dome plus the ground
 * bounce. Two samples stand in for the hemisphere integral, so the constant is
 * fitted rather than derived - it lands close to a proper cosine-weighted sum.
 */
vec3 skyIrradiance(vec3 n) {
  vec3 up = skyRadiance(normalize(vec3(0.0, 1.0, 0.0) + n * 0.35));
  vec3 side = skyRadiance(normalize(vec3(n.x, 0.18, n.z) + vec3(1e-4)));
  return mix(side, up, clamp(n.y * 0.5 + 0.5, 0.0, 1.0)) * PI * 0.95;
}
`;
