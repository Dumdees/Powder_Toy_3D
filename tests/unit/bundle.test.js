import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { bundle, readChunks, squeeze, ROOT, OUT_FILE, SRC_DIR } from '../../build.mjs';

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
