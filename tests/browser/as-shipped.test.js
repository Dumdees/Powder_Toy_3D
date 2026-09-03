// The app as someone actually gets it: no overrides, no shrinking, no halted loop.
//
// Every other browser test halts the loop and turns everything down before it does
// anything, because a software rasteriser is slow. That is exactly the hole a crash
// fell through once: the shipped defaults asked an unknown graphics card for a
// full-detail frame straight away, it took long enough for Windows to decide the
// driver had hung, and the reset took the whole page with it. Nothing here had ever
// run the defaults, so nothing noticed.
//
// These tests open the built file untouched and check the two properties that
// protect against it: the first frame is cheap, and the sandbox backs off when
// frames are slow rather than asking for the same thing again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.js';

const PREINSTALLED = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const APP_FILE = path.join(ROOT, 'Powder Toy 3D.html');

/** Open the built file with nothing changed, at a realistic window size. */
async function openAsShipped() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {}),
    args: ['--allow-file-access-from-files', '--use-gl=angle', '--use-angle=swiftshader',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(pathToFileURL(APP_FILE).href);
  await page.waitForFunction(() => !!window.PowderToy, null, { timeout: 120000 });
  return { page, errors, close: () => browser.close() };
}

test('the first frame is a cheap one, whatever the preset says', async () => {
  const app = await openAsShipped();
  try {
    const first = await app.page.evaluate(() => {
      const P = window.PowderToy;
      const d = P.DETAIL[P.controls.openedAtRung];
      return { rung: P.controls.openedAtRung, scale: d.scale, surf: d.surfSteps,
               substeps: d.substeps, quality: P.app.quality };
    });
    // Whatever preset it opens on, the work it commits to before it has seen a single
    // frame go by must be the bottom of the ladder. This is the whole protection.
    assert.equal(first.rung, 0, 'the sandbox starts at full effort instead of climbing to it');
    assert.ok(first.scale <= 0.35, `first frame renders at ${first.scale}, too large to risk`);
    assert.ok(first.surf <= 56, `first frame marches ${first.surf} steps, too many to risk`);
    assert.equal(first.substeps, 1, 'the first frame runs more than one physics substep');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('slow frames cost detail, and a stalled one costs it immediately', async () => {
  const app = await openAsShipped();
  try {
    const seen = await app.page.evaluate(async () => {
      const P = window.PowderToy;
      P.app.halt = true;                    // drive the governor by hand, not the clock
      // By now the governor has very likely already bottomed out and dropped the
      // preset, because a software rasteriser is genuinely that slow - which is it
      // working. Put it back on a preset with room above and below before testing
      // which way it moves, so this does not depend on how the run was scheduled.
      P.controls.setQuality('high');
      P.controls.setAutoDetail(true);
      const gov = P.controls;
      P.controls.setDetailRung(3);
      const start = gov.detailRung;
      P.controls.feedFrameTime(1200);       // one frame that nearly hung the driver
      const afterStall = gov.detailRung;
      for (let i = 0; i < 4; i++) P.controls.feedFrameTime(150);
      const afterSlow = gov.detailRung;
      for (let i = 0; i < 60; i++) P.controls.feedFrameTime(8);
      const afterFast = gov.detailRung;
      return { start, afterStall, afterSlow, afterFast, ceiling: gov.detailCeiling };
    });
    assert.equal(seen.start, 3);
    assert.ok(seen.afterStall <= seen.start - 2,
      `a 1.2 s frame only cost ${seen.start - seen.afterStall} rungs; that is not backing off fast enough`);
    assert.ok(seen.afterSlow < seen.afterStall || seen.afterStall === 0,
      'a run of slow frames did not cost any detail');
    assert.ok(seen.afterFast > seen.afterSlow, 'quick frames never earn detail back');
    assert.ok(seen.afterFast <= seen.ceiling, 'the governor climbed past what the preset allows');
  } finally { await app.close(); }
});

test('a preset is a ceiling on effort, not a promise of it', async () => {
  const app = await openAsShipped();
  try {
    const r = await app.page.evaluate(async () => {
      const P = window.PowderToy;
      P.app.halt = true;
      P.controls.setQuality('low');
      const lowCeiling = P.controls.detailCeiling;
      for (let i = 0; i < 300; i++) P.controls.feedFrameTime(6);
      return { lowCeiling, reached: P.controls.detailRung, scale: P.RENDER.scale };
    });
    assert.ok(r.reached <= r.lowCeiling,
      `on the low preset the sandbox climbed to rung ${r.reached}, past its ceiling of ${r.lowCeiling}`);
    assert.ok(r.scale <= 0.55, 'the low preset ended up rendering at full resolution');
  } finally { await app.close(); }
});

test('a lost context is survivable, not a dead end', async () => {
  const app = await openAsShipped();
  try {
    const r = await app.page.evaluate(async () => {
      const canvas = document.getElementById('view');
      const ext = window.PowderToy.sim.gfx.gl.getExtension('WEBGL_lose_context');
      if (!ext) return { skipped: true };
      ext.loseContext();
      await new Promise((s) => setTimeout(s, 200));
      const halted = window.PowderToy.app.halt;
      const banner = document.getElementById('boot').textContent;
      ext.restoreContext();
      // Coming back means recompiling every shader, which a software rasteriser is
      // in no hurry about, so wait for it rather than guessing at a delay.
      for (let i = 0; i < 120 && window.PowderToy.app.halt; i++) await new Promise((s) => setTimeout(s, 500));
      return { halted, banner, running: !window.PowderToy.app.halt,
               quality: window.PowderToy.app.quality, safe: window.PowderToy.app.safe };
    });
    if (r.skipped) return;
    assert.ok(r.halted, 'the loop kept running against a context that had gone');
    assert.match(r.banner, /reset/i, 'nothing explained what happened');
    assert.doesNotMatch(r.banner, /cannot start/i, 'a recoverable reset was reported as a dead end');
    assert.doesNotMatch(r.banner, /\bnull\b/, 'the message has a stray "null" in it');
    assert.ok(r.running, 'the sandbox never came back after the context returned');
    assert.equal(r.quality, 'low', 'it came back asking for just as much as before');
    assert.ok(r.safe, 'it did not remember that this machine had trouble');
  } finally { await app.close(); }
});
