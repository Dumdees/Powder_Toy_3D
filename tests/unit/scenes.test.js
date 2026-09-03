import test from 'node:test';
import assert from 'node:assert/strict';
import { load, PURE } from './helpers.js';

const M = await load(PURE, ['SCENES', 'buildParticles', 'MATERIALS', 'matId', 'PHASE']);

const GRID = 64;
const CAP = 1 << 17;

test('every scene has an id, a name and a camera', () => {
  const ids = new Set();
  for (const s of M.SCENES) {
    assert.ok(s.id && !ids.has(s.id), `duplicate or missing scene id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name && s.blurb, `${s.id} needs a name and a description`);
    assert.equal(typeof s.build, 'function');
    if (s.camera) {
      assert.ok(s.camera.dist > 0.5 && s.camera.dist < 8, `${s.id} camera distance looks wrong`);
      assert.ok(Math.abs(s.camera.pitch) < 1.5, `${s.id} camera pitch is past vertical`);
    }
  }
});

test('scenes build inside the pool and inside the box', () => {
  for (const s of M.SCENES) {
    const b = M.buildParticles(s, GRID, GRID, GRID, CAP, () => 0.5);
    assert.ok(b.count <= CAP, `${s.id} asks for ${b.count} of ${CAP}`);
    assert.ok(b.count * 0.25 < CAP, `${s.id} leaves no room to paint anything in`);
    assert.equal(b.pos.length, b.count * 4);
    assert.equal(b.vel.length, b.count * 4);
    assert.equal(b.aux.length, b.count * 4);
    for (let i = 0; i < b.count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = b.pos[i * 4 + a];
        assert.ok(v >= 0 && v <= GRID, `${s.id} put a speck at ${v}, outside the box`);
      }
      const mat = b.pos[i * 4 + 3];
      assert.ok(Number.isInteger(mat) && mat > 0 && mat < M.MATERIALS.length, `${s.id} used material ${mat}`);
      assert.ok(b.aux[i * 4 + 3] > 0 && b.aux[i * 4 + 3] <= 1, `${s.id} speck has volume ${b.aux[i * 4 + 3]}`);
    }
  }
});

test('every speck carries its material starting temperature', () => {
  for (const s of M.SCENES) {
    const b = M.buildParticles(s, GRID, GRID, GRID, CAP, () => 0.5);
    for (let i = 0; i < Math.min(b.count, 4000); i++) {
      const m = M.MATERIALS[b.pos[i * 4 + 3]];
      const t = b.vel[i * 4 + 3];
      assert.ok(Number.isFinite(t), `${s.id} has a speck with no temperature`);
      // Either the material default, or an override the scene asked for.
      assert.ok(t === m.temp || t > m.temp, `${s.id}: ${m.name} started at ${t}, expected ${m.temp}`);
    }
  }
});

test('emitters name real materials and sit inside the box', () => {
  for (const s of M.SCENES) {
    const b = M.buildParticles(s, GRID, GRID, GRID, CAP, () => 0.5);
    for (const e of b.emitters) {
      assert.ok(M.MATERIALS.some((m) => m.name === e.mat), `${s.id} emits unknown "${e.mat}"`);
      for (const c of e.at) assert.ok(c > 0 && c < 1, `${s.id} emitter is outside the box`);
      assert.ok(e.radius > 0 && e.radius < GRID / 2);
      assert.ok(e.rate > 0 && e.rate <= 20000, `${s.id} emitter rate ${e.rate} would fill the pool instantly`);
    }
  }
});

test('fixed scenery is packed sparsely; it never moves', () => {
  const s = M.SCENES.find((x) => x.id === 'hourglass');
  const b = M.buildParticles(s, GRID, GRID, GRID, CAP, () => 0.5);
  const perCell = new Map();
  for (let i = 0; i < b.count; i++) {
    const m = M.MATERIALS[b.pos[i * 4 + 3]];
    if (m.phase !== M.PHASE.RIGID) continue;
    perCell.set(m.name, Math.round(1 / b.aux[i * 4 + 3]));
  }
  for (const [name, n] of perCell) assert.ok(n <= 2, `${name} uses ${n} specks per cell`);
});

test('an empty scene produces nothing but still reports a packing', () => {
  const b = M.buildParticles(M.SCENES.find((s) => s.id === 'empty'), GRID, GRID, GRID, CAP);
  assert.equal(b.count, 0);
  assert.ok(b.perCell >= 1);
});

test('a tiny pool degrades gracefully instead of overflowing', () => {
  for (const s of M.SCENES) {
    const b = M.buildParticles(s, 32, 32, 32, 512, () => 0.5);
    assert.ok(b.count <= 512, `${s.id} overflowed a small pool`);
  }
});

test('fixed scenery is written first, so the pool never recycles it', () => {
  for (const s of M.SCENES) {
    const b = M.buildParticles(s, GRID, GRID, GRID, CAP, () => 0.5);
    assert.ok(b.rigidCount <= b.count);
    for (let i = 0; i < b.count; i++) {
      const rigid = M.MATERIALS[b.pos[i * 4 + 3]].phase === M.PHASE.RIGID;
      assert.equal(rigid, i < b.rigidCount, `${s.id}: speck ${i} is out of order`);
    }
  }
});
