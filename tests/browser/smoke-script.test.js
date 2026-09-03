// The Windows program proves itself by running a snippet of JavaScript inside the packaged
// page (MainForm.cs, StatusScript) and reading what comes back. That snippet reaches deep
// into the app's window.PowderToy hatch, so it silently rots the moment the hatch changes -
// and the only place it would otherwise show up is a five-minute Windows build.
//
// So: pull the real script out of the C# and run it against the real built file here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openApp, ROOT } from './helpers.js';

const MINUTES = 60_000;

/** The verbatim contents of the StatusScript constant in MainForm.cs. */
async function statusScriptFromHost() {
  const cs = await readFile(path.join(ROOT, 'installer', 'host', 'MainForm.cs'), 'utf8');
  const m = cs.match(/private const string StatusScript = @"([\s\S]*?)";\r?\n/);
  assert.ok(m, 'could not find StatusScript in MainForm.cs');
  // C# verbatim strings escape a double quote by doubling it.
  return m[1].replace(/""/g, '"');
}

test('the status script the Windows program runs still works on the real page', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const script = await statusScriptFromHost();

  // Let the app get going, exactly as it would after the host navigates to the file.
  await app.advance(2);
  await app.read(() => window.PowderToy.drawOnce(4 / 3, false));

  let status = 'waiting';
  for (let i = 0; i < 20 && !/^(ready|fail:)/.test(status); i++) {
    status = await app.page.evaluate(script);
    if (!/^(ready|fail:)/.test(status)) await app.page.waitForTimeout(500);
  }

  assert.ok(status.startsWith('ready'), `the Windows smoke test would fail with: ${status}`);
  // The numbers it reports are what a human reads off the build log, so they must be real.
  const fields = Object.fromEntries([...status.matchAll(/(\w+)=([^\s]+)/g)].map((m) => [m[1], m[2]]));
  assert.ok(Number(fields.programs) >= 25, `only ${fields.programs} shaders compiled`);
  assert.ok(Number(fields.frames) > 0, 'no frame was ever drawn');
  assert.ok(Number(fields.grid) >= 48, `grid reported as ${fields.grid}`);
  assert.equal(Number(fields.glerror), 0, `WebGL reported error ${fields.glerror}`);
  assert.ok(fields.gpu && fields.gpu !== 'undefined', 'the renderer name came back empty');
  assert.deepEqual(app.errors, []);
});
