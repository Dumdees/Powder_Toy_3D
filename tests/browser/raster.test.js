// The second renderer, and whether small amounts of material can be seen at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openApp } from './helpers.js';

const MINUTES = 60_000;

/** Average brightness of the drawn frame, and how much of it is not background. */
const LOOK = () => {
  const P = window.PowderToy, gl = P.sim.gfx.gl, r = P.renderer;
  const w = r.width, h = r.height;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, r.hdr.tex, 0);
  const px = new Float32Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
  gl.deleteFramebuffer(fb);
  let sum = 0, max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] + px[i + 1] + px[i + 2];
    sum += l;
    if (l > max) max = l;
  }
  return { mean: sum / (w * h), max, w, h };
};

test('the speck renderer draws a picture, and a different one from the tracer',
  { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  await app.read(() => {
    const P = window.PowderToy;
    P.controls.loadScene('dam');
    P.RENDER.mode = 'rays';
    P.drawOnce(1.4, false);
  });
  const traced = await app.read(LOOK);
  const raster = await app.read(() => {
    const P = window.PowderToy;
    P.RENDER.mode = 'raster';
    P.drawOnce(1.4, false);
    return null;
  }).then(() => app.read(LOOK));

  assert.ok(traced.mean > 1e-4, `the tracer drew nothing (mean ${traced.mean})`);
  assert.ok(raster.mean > 1e-4, `the speck renderer drew nothing (mean ${raster.mean})`);
  // Both are pictures of the same scene, so neither should be black or blown out, but
  // they are made completely differently and must not be pixel-identical.
  assert.ok(Math.abs(raster.mean - traced.mean) > 1e-6, 'the two renderers produced the same image');
  assert.ok(Number.isFinite(raster.max) && raster.max > 0, 'the speck picture has no light in it');
  assert.deepEqual(app.errors, []);
});

test('the speck renderer costs less than tracing', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const times = await app.read(() => {
    const P = window.PowderToy, gl = P.sim.gfx.gl;
    P.controls.loadScene('dam');
    const px = new Uint8Array(4);
    const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    const time = (mode) => {
      P.RENDER.mode = mode;
      P.drawOnce(1.4, false); sync();          // warm
      const a = performance.now();
      P.drawOnce(1.4, false); sync();
      return performance.now() - a;
    };
    return { rays: time('rays'), raster: time('raster') };
  });
  assert.ok(times.raster < times.rays,
    `specks took ${times.raster.toFixed(0)} ms against the tracer's ${times.rays.toFixed(0)} ms; `
    + 'the whole point of it is being cheaper');
  assert.deepEqual(app.errors, []);
});

test('a small amount of material is visible, not just a large one',
  { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  // A handful of specks is what a first dab of the brush puts down. Blurred over the
  // render fields it never reaches half fill anywhere, so at the old fixed threshold
  // of 0.5 it was drawn as nothing at all.
  const seen = await app.read(() => {
    const P = window.PowderToy;
    P.RENDER.mode = 'rays';
    P.controls.loadScene('empty');
    const n = P.sim.n.nx;
    P.sim.spawn({ mat: 1, pos: [n / 2, n * 0.5, n / 2], radius: 1.2, count: 40, jitter: 0 });
    P.sim.buildRenderFields();
    // The peak fill anywhere in the box, which is what the threshold is compared against.
    const gl = P.sim.gfx.gl, tex = P.sim.rF[P.sim.ri][3];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
    const px = new Float32Array(tex.w * tex.h * 4);
    gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fb);
    let peak = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > peak) peak = px[i];
    return { peak, iso: P.RENDER.iso };
  });
  assert.ok(seen.peak > 0, 'the specks left no trace in the fields at all');
  // A margin, not a bare inequality. The first version of this passed at 0.277 against a
  // threshold of 0.28 and failed on the next run: three thousandths is not a setting
  // anyone chose, it is a coin toss.
  assert.ok(seen.peak > seen.iso * 1.25,
    `a dab of 40 specks peaks at ${seen.peak.toFixed(3)} fill against a threshold of `
    + `${seen.iso} - too close to the edge to count as visible`);
  assert.deepEqual(app.errors, []);
});
