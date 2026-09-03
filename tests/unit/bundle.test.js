import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { bundle, readChunks, squeeze, ROOT, OUT_FILE, SRC_DIR } from '../../build.mjs';

const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

const html = await bundle();
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

test('the bundle is valid JavaScript', () => {
  // Compiles without running: catches the sort of thing a stray backtick inside
  // a GLSL template literal would cause.
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'bundle.js' }));
});

test('the page has everything it needs and nothing it cannot reach', () => {
  assert.match(html, /<canvas id="view"/);
  assert.ok(!/<script[^>]+src=/i.test(html), 'the page must not load anything over the network');
  assert.ok(!/<link[^>]+href="http/i.test(html), 'the page must not load anything over the network');
  assert.match(html, /#version 300 es/, 'the shaders should be inlined');
  for (const id of ['palette', 'tools', 'scenes', 'readout', 'panel', 'help', 'boot',
                    'page-physics', 'page-light', 'page-quality', 'brush-size', 'brush-rate']) {
    assert.ok(html.includes(`id="${id}"`), `the page is missing #${id}`);
  }
});

test('no GLSL template literal contains a backtick or an interpolation', async () => {
  for (const { name, code } of await readChunks()) {
    // Walk the file tracking whether we are inside a template literal.
    let inTemplate = false;
    code.split('\n').forEach((line, i) => {
      const ticks = (line.match(/(^|[^\\])`/g) || []).length;
      if (inTemplate) {
        assert.ok(!line.includes('${'), `${name}:${i + 1} interpolates inside a shader`);
        assert.ok(ticks === 0 || (ticks === 1 && line.trimEnd().endsWith('`;')) || line.trimEnd().endsWith('`'),
          `${name}:${i + 1} has a stray backtick inside a shader`);
      }
      if (ticks % 2) inTemplate = !inTemplate;
    });
    assert.ok(!inTemplate, `${name} leaves a template literal open`);
  }
});

const SHADER_NAMES = [
  'VS_FULLSCREEN', 'P2G_VS', 'P2G_FS', 'GRID_PREP_FS', 'HEAT_FS', 'VISC_FS', 'STRESS_FS', 'PLASTIC_FS',
  'NORMAL_FS', 'TENSION_FS', 'DIV_FS', 'PRESSURE_FS', 'PROJECT_FS', 'EXTRAP_FS', 'G2P_FS', 'G2P_C_FS',
  'EMIT_VS', 'EMIT_FS', 'EMIT_ZERO_FS', 'RSPLAT_VS', 'RSPLAT_FS', 'RBLUR_FS', 'COARSE_FS', 'TRACE_FS',
  'PHOTON_FS', 'PHOTON_SPLAT_VS', 'PHOTON_SPLAT_FS', 'CAUSTIC_BLUR_FS', 'COUNT_FS', 'PICK_FS',
  'ACCUM_FS', 'BRIGHT_FS', 'BLOOM_BLUR_FS', 'COMPOSITE_FS',
];

/** Load only the chunks that declare shaders; the rest want a browser. */
async function shaders() {
  const wanted = /^(10|2\d|30|40)-/;
  let src = '';
  for (const { name, code } of await readChunks()) if (wanted.test(name)) src += code + '\n';
  return new Function(`${src}\nreturn { ${SHADER_NAMES.join(', ')} };`)();
}

test('every shader declares its version once and balances its braces', async () => {
  const api = await shaders();
  assert.equal(Object.keys(api).length, SHADER_NAMES.length);
  for (const [name, glsl] of Object.entries(api)) {
    assert.equal(typeof glsl, 'string', `${name} is not a shader`);
    const versions = glsl.match(/#version/g) || [];
    assert.equal(versions.length, 1, `${name} declares #version ${versions.length} times`);
    assert.ok(glsl.startsWith('#version 300 es'), `${name} does not start with #version 300 es`);
    let depth = 0;
    for (const ch of glsl) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      assert.ok(depth >= 0, `${name} closes a brace it never opened`);
    }
    assert.equal(depth, 0, `${name} leaves ${depth} braces open`);
    assert.match(glsl, /void main\(\)/, `${name} has no entry point`);
  }
});

test('squeeze leaves shader source alone but strips comments around it', () => {
  const code = ['// gone', 'const A = 1;', '', 'const S = `', '// kept: this is GLSL', 'void main() {}', '`;'].join('\n');
  const out = squeeze(code);
  assert.ok(!out.includes('// gone'));
  assert.ok(out.includes('// kept: this is GLSL'));
  assert.ok(out.includes('const A = 1;'));
});

test('chunks are numbered so they concatenate in a defined order', async () => {
  const names = (await readdir(path.join(SRC_DIR, 'js'))).filter((n) => n.endsWith('.js'));
  for (const n of names) assert.match(n, /^\d\d-/, `${n} has no order prefix`);
  assert.equal(new Set(names.map((n) => n.slice(0, 2))).size, names.length, 'two chunks share a prefix');
});

test('the committed single-file build is up to date', async () => {
  const onDisk = await readFile(OUT_FILE, 'utf8').catch(() => null);
  assert.ok(onDisk !== null, `${path.relative(ROOT, OUT_FILE)} has not been built`);
  assert.equal(onDisk, html, 'run "npm run build" and commit the result');
});

// ---------------------------------------------------------------------------
// The tracer's loop limits are compile-time constants, so a slider that offers
// more than one of them promises detail the shader will silently decline to
// produce. They also cost real money: a driver's shader compiler reasons about
// the whole loop body, and the surface march appears again inside the caustics
// pass, four times over. Keeping the two in step is the point of these.
test('no quality slider offers more than the shader will actually do', async () => {
  const render = await read('src/js/23-glsl-render.js');
  const ui = await read('src/js/70-ui.js');

  // Pull the number out of the slider row rather than building a regex around the
  // key, which is fiddly to escape and easy to get subtly wrong.
  const sliderMax = (key) => {
    const at = ui.indexOf(`slider(RENDER, '${key}',`);
    assert.ok(at > 0, `no ${key} slider`);
    const row = ui.slice(at, ui.indexOf('\n', at));
    return Number(row.match(/max: (\d+)/)[1]);
  };
  // The loop bound is the number in the `for` that stands immediately above the line
  // where the uniform stops it early.
  const capBefore = (guard) => {
    const at = render.indexOf(guard);
    assert.ok(at > 0, `could not find ${guard}`);
    return Number(render.slice(0, at).match(/for \(int i = 0; i < (\d+); i\+\+\) \{\s*$/m)[1]);
  };
  const surfCap = capBefore('if (i >= uSurfSteps');
  const shadowCap = capBefore('if (i >= uShadowSteps');

  assert.ok(sliderMax('surfSteps') <= surfCap,
    `the panel offers ${sliderMax('surfSteps')} ray steps but the tracer stops at ${surfCap}`);
  assert.ok(sliderMax('shadowSteps') <= shadowCap,
    `the panel offers ${sliderMax('shadowSteps')} shadow steps but the tracer stops at ${shadowCap}`);

  // And the ladder the sandbox climbs by itself must stay inside the same limits.
  const main = await read('src/js/90-main.js');
  const ladder = main.slice(main.indexOf('const DETAIL = ['), main.indexOf('];', main.indexOf('const DETAIL = [')));
  for (const [, surf, shadow] of ladder.matchAll(/surfSteps: (\d+),\s*shadowSteps: (\d+)/g)) {
    assert.ok(Number(surf) <= surfCap, `a DETAIL rung asks for ${surf} ray steps, past the tracer's ${surfCap}`);
    assert.ok(Number(shadow) <= shadowCap, `a DETAIL rung asks for ${shadow} shadow steps, past the tracer's ${shadowCap}`);
  }
});

test('nothing samples a grid with an implicit level of detail', async () => {
  // texture() works out its level from derivatives, which GLSL ES leaves undefined in
  // non-uniform control flow - and every grid sample happens inside a ray-marching
  // loop full of break and continue. It costs gradient maths per sample as well.
  for (const f of ['20-glsl-common.js', '21-glsl-sim.js', '22-glsl-particles.js', '23-glsl-render.js']) {
    const src = await read(`src/js/${f}`);
    const bare = [...src.matchAll(/[^a-zA-Z_]texture\(/g)];
    assert.equal(bare.length, 0,
      `${f} samples with texture(); inside a march it must be textureLod(..., 0.0)`);
  }
});

test('the ladder only ever goes up, and every preset can reach a rung', async () => {
  const main = await read('src/js/90-main.js');
  const sim = await read('src/js/30-sim.js');
  const ladder = main.slice(main.indexOf('const DETAIL = ['), main.indexOf('];', main.indexOf('const DETAIL = [')));
  const rungs = [...ladder.matchAll(/\{ scale: ([\d.]+),[^}]*\}/g)].map((m) => Number(m[1]));
  assert.ok(rungs.length >= 4, 'too few rungs to adapt with');
  for (let i = 1; i < rungs.length; i++) {
    assert.ok(rungs[i] > rungs[i - 1], `rung ${i} does not ask for more than rung ${i - 1}`);
  }
  assert.ok(rungs[0] <= 0.35, 'the first frame is drawn too large to be a safe opening bid');
  const presets = sim.slice(sim.indexOf('const QUALITY = {'), sim.indexOf('};', sim.indexOf('const QUALITY = {')));
  const ceilings = [...presets.matchAll(/detail: (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(ceilings.length, 4, 'every preset needs a detail ceiling');
  for (const c of ceilings) assert.ok(c >= 0 && c < rungs.length, `ceiling ${c} is not a rung`);
});
