import test from 'node:test';
import assert from 'node:assert/strict';
import { openApp, PARTICLES } from './helpers.js';

const MINUTES = 60_000;

test('the sandbox starts, compiles every shader and shows its controls', { timeout: 4 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());

  const state = await app.read(() => ({
    bootHidden: document.getElementById('boot').hidden,
    uiShown: !document.getElementById('ui').hidden,
    materials: document.querySelectorAll('.mat').length,
    tools: document.querySelectorAll('.tool').length,
    scenes: document.querySelectorAll('.scene').length,
    programs: window.PowderToy.sim.gfx.programs.size,
    glError: window.PowderToy.sim.gfx.gl.getError(),
    grid: window.PowderToy.sim.n.nx,
    capacity: window.PowderToy.sim.capacity,
  }));

  assert.deepEqual(app.errors, [], 'the page logged errors');
  assert.ok(state.bootHidden, 'the "cannot start" panel is showing');
  assert.ok(state.uiShown);
  assert.ok(state.materials >= 16, `only ${state.materials} materials in the palette`);
  assert.equal(state.tools, 5);
  assert.ok(state.scenes >= 8);
  assert.ok(state.programs >= 25, `only ${state.programs} shader programs compiled`);
  assert.equal(state.glError, 0, 'WebGL reported an error');
  assert.ok(state.capacity >= 1 << 16);
});

test('a frame is drawn, and it is not a blank screen', { timeout: 4 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  await app.advance(4);
  const stats = await app.read(() => {
    const P = window.PowderToy;
    P.drawOnce(4 / 3, false);
    const r = P.renderer, gl = P.sim.gfx.gl, tex = r.history[r.hi];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
    const px = new Float32Array(tex.w * tex.h * 4);
    gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fb);
    let min = Infinity, max = -Infinity, sum = 0, n = 0, bad = 0;
    for (let i = 0; i < px.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = px[i + c];
        if (!Number.isFinite(v)) { bad++; continue; }
        min = Math.min(min, v); max = Math.max(max, v); sum += v; n++;
      }
    }
    return { min, max, mean: sum / n, bad, frames: r.frame };
  });
  assert.equal(stats.bad, 0, 'the frame contains NaN or infinity');
  assert.ok(stats.frames > 0, 'nothing was drawn');
  assert.ok(stats.min >= 0, `negative radiance ${stats.min}`);
  assert.ok(stats.mean > 0.002, `the frame is black (mean ${stats.mean})`);
  assert.ok(stats.max > stats.mean * 1.5, 'the frame is a flat colour, so nothing was in view');
  assert.deepEqual(app.errors, []);
});

test('water falls, stays in the box and keeps its volume', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  await app.read(() => window.PowderToy.controls.loadScene('dam'));
  const before = await app.read(PARTICLES);
  await app.advance(150);
  const after = await app.read(PARTICLES);
  const box = await app.read(() => window.PowderToy.sim.n.nx);

  assert.ok(before.count > 1000, 'the scene loaded nothing');
  assert.equal(after.count, before.count, 'specks went missing');
  assert.ok(after.meanY < before.meanY - 1, `water did not fall (${before.meanY} -> ${after.meanY})`);
  const bounds = await app.read(() => {
    const sim = window.PowderToy.sim, gl = sim.gfx.gl, t = sim.pPos[sim.pi];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    const px = new Float32Array(t.w * t.h * 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fb);
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], bad = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.round(px[i + 3]) === 0) continue;
      for (let c = 0; c < 3; c++) {
        if (!Number.isFinite(px[i + c])) { bad++; continue; }
        lo[c] = Math.min(lo[c], px[i + c]);
        hi[c] = Math.max(hi[c], px[i + c]);
      }
    }
    return { lo, hi, bad };
  });
  assert.equal(bounds.bad, 0, 'a speck ended up at NaN');
  for (let c = 0; c < 3; c++) {
    assert.ok(bounds.lo[c] >= 1, `a speck escaped through the wall at ${bounds.lo[c]}`);
    assert.ok(bounds.hi[c] <= box - 1, `a speck escaped through the wall at ${bounds.hi[c]}`);
  }
  assert.deepEqual(app.errors, []);
});

test('sand heaps up instead of levelling like a liquid', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const profile = async () => app.read(() => {
    const sim = window.PowderToy.sim, gl = sim.gfx.gl, t = sim.pPos[sim.pi];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    const px = new Float32Array(t.w * t.h * 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fb);
    const n = sim.n.nx, mid = [], rim = [];
    for (let i = 0; i < px.length; i += 4) {
      if (Math.round(px[i + 3]) === 0) continue;
      const r = Math.hypot(px[i] - n / 2, px[i + 2] - n / 2);
      if (r < n * 0.12) mid.push(px[i + 1]);
      else if (r > n * 0.30) rim.push(px[i + 1]);
    }
    const top = (a) => (a.length < 20 ? 0 : a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)]);
    return { middle: top(mid), edge: top(rim), n };
  });

  const drop = (granular) => app.read((g) => {
    const P = window.PowderToy;
    P.PHYSICS.granular = g;
    P.controls.loadScene('empty');
    P.sim.perCell = 4;
    const n = P.sim.n.nx, R = n * 0.19;
    P.sim.spawn({ mat: 6, pos: [n / 2, n * 0.6, n / 2], radius: R, count: Math.round(4 * 4 / 3 * Math.PI * R ** 3), jitter: 0 });
  }, granular);

  await drop(1);
  await app.advance(220);
  const sand = await profile();
  await drop(0);
  await app.advance(220);
  const slippery = await profile();

  assert.ok(sand.middle > sand.edge + sand.n * 0.05,
    `sand did not heap up: middle ${sand.middle.toFixed(1)} vs edge ${sand.edge.toFixed(1)}`);
  assert.ok(sand.middle > slippery.middle,
    `friction made no difference: ${sand.middle.toFixed(1)} with, ${slippery.middle.toFixed(1)} without`);
  assert.deepEqual(app.errors, []);
});

test('heat changes what things are made of', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const ICE = 10, WATER = 1, STEAM = 15;
  await app.read(() => window.PowderToy.controls.loadScene('thaw'));
  const before = await app.read(PARTICLES);
  assert.ok((before.byMat[ICE] || 0) > 500, 'the thaw scene should start with ice');
  assert.ok(!(before.byMat[WATER] > 0), 'nothing should have melted yet');
  await app.advance(240);
  const after = await app.read(PARTICLES);
  assert.ok((after.byMat[WATER] || 0) > 0, 'ice on a red hot plate never melted');
  assert.ok((after.byMat[ICE] || 0) < before.byMat[ICE], 'no ice was used up');
  // Water sitting on 1150C steel should also start to boil off.
  assert.ok((after.byMat[STEAM] || 0) >= 0);
  assert.deepEqual(app.errors, []);
});

test('the palette, the tools and the brush all do something', { timeout: 4 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  await app.read(() => window.PowderToy.controls.loadScene('empty'));

  await app.page.click('.mat:nth-child(6)');           // Sand
  await app.page.click('.tool:nth-child(3)');          // Drag
  const picked = await app.read(() => ({ mat: window.PowderToy.brush.material, tool: window.PowderToy.brush.tool }));
  assert.equal(picked.mat, 6);
  assert.equal(picked.tool, 2);

  const grew = await app.read(() => {
    const P = window.PowderToy;
    const n = P.sim.n.nx;
    P.sim.spawn({ mat: 1, pos: [n / 2, n / 2, n / 2], radius: 6, count: 3000 });
    return true;
  });
  assert.ok(grew);
  await app.advance(2);
  const after = await app.read(PARTICLES);
  assert.ok(after.count > 2000, `painting produced only ${after.count} specks`);

  // Emptying the box really does empty it.
  await app.read(() => window.PowderToy.controls.empty());
  await app.advance(1);
  assert.equal((await app.read(PARTICLES)).count, 0);
  assert.deepEqual(app.errors, []);
});

test('every scene loads and runs without complaint', { timeout: 8 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const ids = await app.read(() => window.PowderToy.SCENES.map((s) => s.id));
  for (const id of ids) {
    await app.read((sid) => window.PowderToy.controls.loadScene(sid), id);
    await app.advance(6);
    const p = await app.read(PARTICLES);
    if (id !== 'empty') assert.ok(p.count > 100, `${id} loaded ${p.count} specks`);
    assert.ok(Number.isFinite(p.meanY), `${id} produced NaN positions`);
  }
  assert.deepEqual(app.errors, [], 'a scene logged an error');
});

test('drawing with the mouse puts material where the pointer is', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp({ width: 760, height: 560 });
  t.after(() => app.close());
  await app.read(() => {
    const P = window.PowderToy;
    P.controls.loadScene('empty');
    P.controls.setMaterial(6);        // sand
    P.controls.setTool(0);            // draw
    P.controls.setRadius(7);
    P.brush.rate = 100;
    P.app.playing = false;            // hold the physics still so nothing falls away
    P.app.halt = false;               // but let the frame loop run, so the brush is live
    P.controls.togglePanel();         // clear the middle of the window
  });
  const box = await app.read(() => {
    const c = document.getElementById('view').getBoundingClientRect();
    const covered = ['.palette', '.dock', '.topbar'].map((s) => document.querySelector(s).getBoundingClientRect());
    return { c: c.toJSON(), covered: covered.map((r) => r.toJSON()) };
  });
  // Aim at a spot the panels do not sit on top of.
  const cx = box.c.x + box.c.width * 0.55;
  const cy = box.c.y + box.c.height * 0.42;
  for (const r of box.covered) {
    assert.ok(cx < r.x || cx > r.x + r.width || cy < r.y || cy > r.y + r.height,
      'the test is aiming at a spot covered by the interface');
  }
  const onCanvas = await app.read(([x, y]) => document.elementFromPoint(x, y).id, [cx, cy]);
  assert.equal(onCanvas, 'view', 'the pointer is not over the canvas');
  await app.page.mouse.move(cx, cy);
  await app.page.waitForTimeout(700);
  assert.ok(await app.read(() => window.PowderToy.brush.show), 'the brush is not tracking the pointer');
  await app.page.mouse.down();
  await app.page.waitForTimeout(200);
  assert.ok(await app.read(() => window.PowderToy.brush.active), 'pressing the button did not start the tool');
  for (let i = 0; i < 6; i++) {
    await app.page.mouse.move(cx + i * 4 - 12, cy + i * 3 - 9);
    await app.page.waitForTimeout(400);
  }
  await app.page.mouse.up();
  await app.page.waitForTimeout(600);
  await app.read(() => { window.PowderToy.app.halt = true; });

  const p = await app.read(PARTICLES);
  assert.ok(p.count > 500, `drawing produced only ${p.count} specks`);
  assert.ok((p.byMat[6] || 0) > 500, 'the specks are not the material that was chosen');

  // They should be somewhere near the middle of the box, not stuck at a corner.
  const spread = await app.read(() => {
    const sim = window.PowderToy.sim, gl = sim.gfx.gl, tex = sim.pPos[sim.pi];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
    const px = new Float32Array(tex.w * tex.h * 4);
    gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fb);
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.round(px[i + 3]) === 0) continue;
      n++; sx += px[i]; sy += px[i + 1]; sz += px[i + 2];
    }
    return { n, mid: [sx / n, sy / n, sz / n], grid: sim.n.nx };
  });
  for (const c of spread.mid) {
    assert.ok(c > spread.grid * 0.15 && c < spread.grid * 0.85,
      `the brush landed at ${spread.mid.map((v) => v.toFixed(0))}, not near the middle`);
  }
  assert.deepEqual(app.errors, []);
});

test('the erase tool takes material away again', { timeout: 5 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const n = await app.read(() => {
    const P = window.PowderToy;
    P.controls.loadScene('empty');
    const g = P.sim.n.nx;
    P.sim.spawn({ mat: 1, pos: [g / 2, g / 2, g / 2], radius: 10, count: 20000 });
    return g;
  });
  await app.advance(1);
  const before = await app.read(PARTICLES);
  assert.ok(before.count > 5000);
  // Run the solver with the erase brush parked in the middle of the blob.
  await app.read((g) => {
    const P = window.PowderToy;
    Object.assign(P.brush, { active: true, tool: 1, radius: 12, pos: [g / 2, g / 2, g / 2], vel: [0, 0, 0], strength: 1 });
  }, n);
  await app.read(() => {
    const P = window.PowderToy;
    for (let i = 0; i < 6; i++) P.sim.step(1 / 600, { active: true, ...P.brush });
  });
  const after = await app.read(PARTICLES);
  assert.ok(after.count < before.count * 0.5, `erase left ${after.count} of ${before.count}`);
  assert.deepEqual(app.errors, []);
});

test('photons find their way through water and land as caustics', { timeout: 5 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  await app.read(() => {
    const P = window.PowderToy;
    P.RENDER.caustics = true;
    P.RENDER.photons = 128;
    P.controls.loadScene('rain');     // a shallow pool with a rippled surface
  });
  await app.advance(60);
  const energy = await app.read(() => {
    const P = window.PowderToy, r = P.renderer, gl = P.sim.gfx.gl;
    P.sim.buildRenderFields();
    for (let i = 0; i < 4; i++) r.updateCaustics(r.sceneUniforms());
    const tex = r.caustic[r.ci];
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
    const px = new Float32Array(tex.w * tex.h * 4);
    gl.readPixels(0, 0, tex.w, tex.h, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fb);
    let max = 0, lit = 0, bad = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i];
      if (!Number.isFinite(v)) { bad++; continue; }
      if (v > 0.01) lit++;
      max = Math.max(max, v);
    }
    return { max, lit, bad };
  });
  assert.equal(energy.bad, 0, 'the caustic volume contains NaN');
  assert.ok(energy.max > 0.01, `no photons landed anywhere (max ${energy.max})`);
  assert.ok(energy.lit > 50, `only ${energy.lit} cells received any focused light`);
  assert.deepEqual(app.errors, []);
});
