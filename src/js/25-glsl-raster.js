// The other renderer. Where the tracer marches a ray through the fields for every
// pixel, this draws each speck once, as a little sphere facing the camera, and lets
// the depth buffer decide what is in front. No marching, no shadow rays, no
// refraction - so it costs a tiny fraction of the tracer and looks like what it is:
// a cloud of grains rather than a surface with light going through it.
//
// It is also deliberately small. The tracer is the largest shader here by a distance
// and the one that gave a Windows driver's compiler trouble; there is nothing in
// either of these two that a compiler has to think about.

// The sky and the ground the box stands on, with no marching at all - so no shadows
// and no caustics on the floor, which is the honest price of not tracing anything.
const RASTER_BG_FS = GLSL_HEAD + GLSL_COMMON + `
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform vec2 uRes;
uniform float uFloorY;
out vec4 oColour;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * uv.x + uCamUp * uv.y);
  vec3 col;
  float t = rd.y < -1e-4 ? (uFloorY - uCamPos.y) / rd.y : -1.0;
  if (t > 0.0) {
    vec3 p = uCamPos + rd * t;
    vec2 q = p.xz / uGrid.x;
    float line = smoothstep(0.02, 0.05, min(abs(fract(q.x * 4.0) - 0.5), abs(fract(q.y * 4.0) - 0.5)));
    vec3 albedo = mix(vec3(0.16, 0.155, 0.15), vec3(0.24, 0.235, 0.23), line);
    vec3 lit = albedo * (uSunColour * max(uSunDir.y, 0.0) + skyIrradiance(vec3(0.0, 1.0, 0.0))) / PI;
    // Ground far from the box fades into the horizon rather than running on for ever.
    float r = length(p.xz - uGrid.xz * 0.5) / uGrid.x;
    vec3 haze = skyRadiance(normalize(vec3(rd.x, 0.03, rd.z) + vec3(1e-5)));
    col = mix(lit, haze, smoothstep(2.5, 8.0, r));
  } else {
    col = skyRadiance(rd) + sunRadiance(rd);
  }
  oColour = vec4(col, 1.0);
}`;

// One point per speck, sized so a speck covers about as much of the screen as the
// volume it stands for.
const RASTER_VS = GLSL_HEAD + GLSL_COMMON + GLSL_PARTICLE_HEAD + `
uniform sampler2D uPos, uVel, uAux;
uniform mat4 uViewProj;
uniform float uPointScale;   // pixels per cell at one cell of distance
uniform float uSpeck;        // radius of a speck, in cells
uniform vec3 uCamPos;
flat out vec4 vAlbedo;       // rgb, and glow
flat out vec2 vHeat;         // temperature, whether this is a gas
void main() {
  ivec2 pt = pTexel(gl_VertexID);
  vec4 P = texelFetch(uPos, pt, 0);
  int mid = int(P.w + 0.5);
  if (mid == 0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlbedo = vec4(0.0);
    vHeat = vec2(0.0);
    return;
  }
  vec4 m1 = matRow(mid, 1);
  vec4 m3 = matRow(mid, 3);
  vec4 V = texelFetch(uVel, pt, 0);
  vAlbedo = vec4(m1.rgb, m1.a);
  vHeat = vec2(V.w, m3.z);
  // A gas is loose and mostly empty, so it is drawn larger and fainter than a grain.
  float radius = uSpeck * mix(1.0, 2.2, m3.z);
  gl_Position = uViewProj * vec4(P.xyz, 1.0);
  float dist = max(length(P.xyz - uCamPos), 0.5);
  gl_PointSize = clamp(2.0 * radius * uPointScale / dist, 1.0, 128.0);
}`;

const RASTER_FS = GLSL_HEAD + GLSL_COMMON + `
uniform vec3 uCamRight, uCamUp, uCamFwd;
uniform float uGlowGain;
flat in vec4 vAlbedo;
flat in vec2 vHeat;
out vec4 oColour;
void main() {
  // A sphere drawn as a flat point: throw away the corners, and read the normal off
  // the disc so it lights like a ball rather than a sticker.
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  d.y = -d.y;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  vec3 right = normalize(uCamRight), up = normalize(uCamUp), fwd = normalize(uCamFwd);
  vec3 n = normalize(right * d.x + up * d.y - fwd * sqrt(max(1.0 - r2, 0.0)));

  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 lit = vAlbedo.rgb * (uSunColour * ndl + skyIrradiance(n)) / PI;
  // Anything hot enough glows on its own, which is most of what makes fire and lava
  // read correctly without a single ray being traced.
  lit += blackbody(vHeat.x + T_ZERO_C) * thermalPower(vHeat.x) * vAlbedo.a * uGlowGain;
  // Gas is thin: fade it towards its edges so a cloud of it looks soft.
  float alpha = vHeat.y > 0.5 ? (1.0 - r2) * 0.55 : 1.0;
  oColour = vec4(lit * alpha, alpha);
}`;
