// The size of the sandbox, and whether it has walls at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openApp, PARTICLES } from './helpers.js';

const MINUTES = 60_000;

test('the sandbox can be made bigger without rebuilding anything', { timeout: 4 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  const before = await app.read(() => ({
    dx: window.PowderToy.sim.dx,
    across: window.PowderToy.sim.boxMetres,
    cells: window.PowderToy.sim.n.nx,
  }));
  const after = await app.read(() => {
    const P = window.PowderToy;
    P.PHYSICS.boxMetres = 10;
    P.controls.worldResized();
    return { dx: P.sim.dx, across: P.sim.boxMetres, cells: P.sim.n.nx };
  });
  assert.equal(after.cells, before.cells, 'changing the size should not change the number of cells');
  assert.ok(after.dx > before.dx * 3, 'the cells did not grow with the world');
  assert.equal(after.across, 10);
  // And it still runs afterwards, which is the point of doing it live.
  await app.advance(20);
  assert.deepEqual(app.errors, []);
});

test('with the sides open, material leaves instead of piling against a wall',
  { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());

  /** Pour a slab of water that is already moving sideways, and see what survives. */
  const pour = (walls) => app.read((w) => {
    const P = window.PowderToy;
    P.PHYSICS.walls = w;
    P.controls.loadScene('empty');
    const n = P.sim.n.nx;
    P.sim.spawn({ mat: 1, pos: [n / 2, n * 0.55, n / 2], radius: n * 0.16,
                  count: 12000, jitter: 0, vel: [22, 0, 0] });
  }, walls);

  await pour('closed');
  await app.advance(140);
  const closed = await app.read(PARTICLES);

  await pour('open');
  await app.advance(140);
  const open = await app.read(PARTICLES);

  assert.ok(closed.count > 8000, `the closed box lost material it should have kept (${closed.count})`);
  assert.ok(open.count < closed.count * 0.6,
    `open sides kept ${open.count} of ${closed.count}; water thrown sideways should have left`);
  assert.deepEqual(app.errors, []);
});

test('with no box at all, everything falls out of the bottom', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  await app.read(() => {
    const P = window.PowderToy;
    P.PHYSICS.walls = 'endless';
    P.controls.loadScene('empty');
    const n = P.sim.n.nx;
    P.sim.spawn({ mat: 1, pos: [n / 2, n * 0.7, n / 2], radius: n * 0.14, count: 9000, jitter: 0 });
  });
  const start = await app.read(PARTICLES);
  assert.ok(start.count > 5000, 'nothing was poured in the first place');
  await app.advance(220);
  const end = await app.read(PARTICLES);
  assert.ok(end.count < start.count * 0.25,
    `${end.count} of ${start.count} specks are still there; with no floor they should have fallen away`);
  assert.deepEqual(app.errors, []);
});

test('the floor still holds when only the sides are open', { timeout: 6 * MINUTES }, async (t) => {
  const app = await openApp();
  t.after(() => app.close());
  await app.read(() => {
    const P = window.PowderToy;
    P.PHYSICS.walls = 'open';
    P.controls.loadScene('empty');
    const n = P.sim.n.nx;
    // Dropped straight down in the middle, so it should settle rather than run off.
    P.sim.spawn({ mat: 6, pos: [n / 2, n * 0.5, n / 2], radius: n * 0.12, count: 7000, jitter: 0 });
  });
  const start = await app.read(PARTICLES);
  await app.advance(200);
  const end = await app.read(PARTICLES);
  assert.ok(end.count > start.count * 0.5,
    `only ${end.count} of ${start.count} grains survived; a heap dropped in the middle should stay`);
  assert.ok(end.meanY < start.meanY, 'the heap never fell');
  assert.deepEqual(app.errors, []);
});
