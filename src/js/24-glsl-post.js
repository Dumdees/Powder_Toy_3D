// What happens between the ray tracer and the screen: temporal accumulation to
// settle the noise, a bloom chain for anything genuinely bright, then exposure,
// the ACES filmic curve and sRGB encoding.

/** Blend this frame into the running average. Still scenes converge; moving ones do not smear. */
const ACCUM_FS = GLSL_HEAD + `
uniform sampler2D uNew, uHistory;
uniform float uBlend;
out vec4 oColour;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 n = texelFetch(uNew, t, 0);
  vec4 h = texelFetch(uHistory, t, 0);
  oColour = vec4(mix(h.rgb, n.rgb, uBlend), n.a);
}`;

const BRIGHT_FS = GLSL_HEAD + `
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform float uThreshold, uExposure;
out vec4 oColour;
void main() {
  vec2 uv = gl_FragCoord.xy * 2.0 / uSrcSize;
  vec3 c = vec3(0.0);
  c += texture(uSrc, (uv + vec2(-0.5, -0.5) / uSrcSize)).rgb;
  c += texture(uSrc, (uv + vec2( 0.5, -0.5) / uSrcSize)).rgb;
  c += texture(uSrc, (uv + vec2(-0.5,  0.5) / uSrcSize)).rgb;
  c += texture(uSrc, (uv + vec2( 0.5,  0.5) / uSrcSize)).rgb;
  c *= 0.25 * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  oColour = vec4(c * max(l - uThreshold, 0.0) / max(l, 1e-4), 1.0);
}`;

const BLOOM_BLUR_FS = GLSL_HEAD + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 oColour;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  // Nine-tap Gaussian, separable, run once per axis.
  vec3 c = texture(uSrc, uv).rgb * 0.227027;
  c += (texture(uSrc, uv + uTexel * 1.3846) + texture(uSrc, uv - uTexel * 1.3846)).rgb * 0.3162162;
  c += (texture(uSrc, uv + uTexel * 3.2307) + texture(uSrc, uv - uTexel * 3.2307)).rgb * 0.0702702;
  oColour = vec4(c, 1.0);
}`;

const COMPOSITE_FS = GLSL_HEAD + GLSL_COMMON + `
uniform sampler2D uHDR, uBloom, uBloomWide;
uniform vec2 uRes;
uniform float uExposure, uBloomGain, uVignette;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform vec3 uBrushPos;
uniform float uBrushRadius;
uniform int uBrushShow;
uniform vec3 uBrushTint;
out vec4 oColour;

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 hdr = texture(uHDR, uv);
  vec3 c = hdr.rgb * uExposure;
  c += (texture(uBloom, uv).rgb + texture(uBloomWide, uv).rgb) * uBloomGain * 0.5;

  // The brush, drawn as a sphere in the scene rather than a flat circle.
  if (uBrushShow == 1) {
    vec3 rd = normalize(uCamFwd + uCamRight * (uv.x * 2.0 - 1.0) + uCamUp * (uv.y * 2.0 - 1.0));
    vec3 oc = uBrushPos - uCamPos;
    float tc = dot(oc, rd);
    float d = length(oc - rd * tc);
    float aa = max(fwidth(d), 1e-4);
    float ring = smoothstep(1.6 * aa, 0.0, abs(d - uBrushRadius));
    float front = step(0.0, tc);
    float inside = smoothstep(uBrushRadius, uBrushRadius * 0.7, d);
    float near = step(tc - uBrushRadius, hdr.a);
    c = mix(c, c + uBrushTint * 0.06, inside * front * near);
    c += uBrushTint * ring * front * 0.55;
  }

  c = acesFilm(c);
  c *= 1.0 - uVignette * dot(uv - 0.5, uv - 0.5) * 1.9;
  oColour = vec4(toSRGB(max(c, vec3(0.0))), 1.0);
}`;
