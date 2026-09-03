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
test('no ray march has a step count the shader compiler can see', async () => {
  // This is the one that matters most. On Windows every browser reaches the GPU through
  // ANGLE, which translates this GLSL into HLSL and hands it to Direct3D's compiler -
  // and that compiler unrolls loops whose trip count it can work out. Unrolling a
  // 256-step march whose body holds texture fetches and another loop produces something
  // enormous, and the surface march is called again inside the caustics pass four times
  // over. Written with the limit in a uniform it cannot be unrolled at all.
  //
  // Small fixed loops are fine and worth unrolling; the rule is that anything long
  // enough to be a march must get its length at draw time.
  const render = await read('src/js/23-glsl-render.js');
  const bad = [];
  for (const m of render.matchAll(/for \((?:int|float) \w+ = 0; \w+ [<!]=? ([0-9]+)\s*;/g)) {
    const bound = Number(m[1]);
    if (bound > 8) {
      const line = render.slice(0, m.index).split('\n').length;
      bad.push(`line ${line}: a loop bounded by the constant ${bound}`);
    }
  }
  assert.deepEqual(bad, [],
    `these can be unrolled, and on a real Windows driver that is what crashes it:\n  ${bad.join('\n  ')}`);

  // ...and the marches really are driven by uniforms, not merely short.
  for (const u of ['uSurfSteps', 'uShadowSteps', 'uVolSteps']) {
    assert.ok(render.includes(`for (int i = 0; i < ${u}; i++)`),
      `no loop takes its length from ${u}, so something is still bounded by a constant`);
    assert.match(render, new RegExp(`uniform int[^;]*\\b${u}\\b`), `${u} is never declared`);
  }
  // Every one of them has to be given a value, or the loop runs zero times and the
  // screen is black - which is far harder to work out than a shader that fails to link.
  const renderer = await read('src/js/40-render.js');
  for (const u of ['uSurfSteps', 'uShadowSteps', 'uVolSteps']) {
    assert.match(renderer, new RegExp(`${u}: RENDER\\.\\w+`), `${u} is declared but never set`);
  }
  const main = await read('src/js/90-main.js');
  for (const k of ['surfSteps', 'volSteps', 'shadowSteps']) {
    assert.match(main, new RegExp(`RENDER\\.${k} = d\\.${k};`), `the ladder never sets ${k}`);
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
  const presetCount = (presets.match(/grid:/g) || []).length;
  assert.equal(ceilings.length, presetCount, 'every preset needs a detail ceiling');
  assert.ok(presetCount >= 4, 'the presets have gone missing');
  for (const c of ceilings) assert.ok(c >= 0 && c < rungs.length, `ceiling ${c} is not a rung`);
});

test('shaders are queued and collected, not built one blocking at a time', async () => {
  // Asking for LINK_STATUS is what makes a driver stop and finish compiling, so doing it
  // straight after each link serialises all twenty-nine shaders onto one thread and gives
  // the window nothing to show meanwhile. They are queued instead and collected together,
  // which lets a driver use every thread it has and lets the page stay alive.
  const gl = await read('src/js/10-gl.js');
  const body = gl.slice(gl.indexOf('  program(name, fs'), gl.indexOf('finishPrograms('));
  assert.ok(!body.includes('LINK_STATUS'),
    'program() waits for the link, which serialises every shader in the app');
  assert.match(gl, /finishPrograms\(onProgress\)/, 'nothing collects the queued programs');
  assert.match(gl, /KHR_parallel_shader_compile/,
    'without this the driver cannot be asked whether a shader is done except by waiting');
  const main = await read('src/js/90-main.js');
  assert.match(main, /await settlePrograms\(\)/, 'the boot never waits for the queued shaders');
  assert.match(main, /finishBuild\(\)/, 'the queued shaders are never collected');
});
