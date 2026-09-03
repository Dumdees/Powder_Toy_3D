// Opens the BUILT single file over file://, exactly as someone double-clicking
// it would, and drives the app through the hatch it exposes on window.
import { chromium } from 'playwright';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PREINSTALLED = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const APP_FILE = path.join(ROOT, 'Powder Toy 3D.html');

export async function openApp({ width = 480, height = 360, quality = 'low' } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {}),
    args: ['--allow-file-access-from-files', '--use-gl=angle', '--use-angle=swiftshader',
           '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(APP_FILE).href);
  await page.waitForFunction(() => !!window.PowderToy, null, { timeout: 60000 });
  // Software rendering: keep the picture tiny and stop the loop hogging the GPU.
  await page.evaluate((q) => {
    const P = window.PowderToy;
    P.app.halt = true;
    P.controls.setQuality(q);
    P.RENDER.scale = 0.3;
    P.RENDER.surfSteps = 70;
    P.RENDER.shadowSteps = 10;
    P.RENDER.photons = 64;
  }, quality);
  return {
    page, errors, browser,
    /** Run the physics without drawing; much faster under a software rasteriser. */
    advance: (n) => page.evaluate((k) => window.PowderToy.advance(k), n),
    read: (fn, arg) => page.evaluate(fn, arg),
    close: () => browser.close(),
  };
}

/** Everything still in play, as {x, y, z, mat} records. */
export const PARTICLES = () => {
  const sim = window.PowderToy.sim, gl = sim.gfx.gl, t = sim.pPos[sim.pi];
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
  const px = new Float32Array(t.w * t.h * 4);
  gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, px);
  gl.deleteFramebuffer(fb);
  const byMat = {};
  let n = 0, sumY = 0;
  for (let i = 0; i < px.length; i += 4) {
    const m = Math.round(px[i + 3]);
    if (m === 0) continue;
    n++;
    sumY += px[i + 1];
    byMat[m] = (byMat[m] || 0) + 1;
  }
  return { count: n, meanY: n ? sumY / n : 0, byMat };
};
