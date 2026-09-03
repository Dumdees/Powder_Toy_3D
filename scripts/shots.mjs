// Renders the screenshots used in the README. Steps the physics with the frame
// loop halted (much faster under a software rasteriser), then draws a few frames
// so the temporal accumulation has something to settle into.
//
//   node scripts/shots.mjs [scene ...]
import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SHOT_DIR || path.join(ROOT, 'docs', 'screenshots');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const SHOTS = {
  dam: { steps: 170, chrome: false },
  hourglass: { steps: 380, chrome: false },
  volcano: { steps: 240, chrome: false },
  layers: { steps: 260, chrome: false },
  bonfire: { steps: 200, chrome: false },
  full: { scene: 'dam', steps: 170, chrome: true },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
  args: ['--allow-file-access-from-files', '--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

for (const name of wanted) {
  const shot = SHOTS[name];
  if (!shot) { console.warn(`no such shot: ${name}`); continue; }
  const page = await browser.newPage({ viewport: { width: 1000, height: 660 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(pathToFileURL(path.join(ROOT, 'Powder Toy 3D.html')).href);
  await page.waitForFunction(() => !!window.PowderToy, null, { timeout: 60000 });
  await page.evaluate(({ scene, chrome }) => {
    const P = window.PowderToy;
    P.app.halt = true;
    P.RENDER.scale = 0.6;
    P.RENDER.surfSteps = 160;
    P.RENDER.shadowSteps = 28;
    P.controls.loadScene(scene);
    if (!chrome) for (const sel of ['.topbar', '.palette', '.dock', '.panel']) document.querySelector(sel).hidden = true;
  }, { scene: shot.scene || name, chrome: shot.chrome });

  const t0 = Date.now();
  for (let i = 0; i < shot.steps; i += 20) await page.evaluate((n) => window.PowderToy.advance(n), 20);
  await page.evaluate(() => window.PowderToy.drawOnce(1000 / 660, false));
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.PowderToy.drawOnce(1000 / 660, true));
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, timeout: 120000 });
  console.log(`${name}: ${shot.steps} steps in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${path.relative(ROOT, file)}`);
  await page.close();
}
await browser.close();
