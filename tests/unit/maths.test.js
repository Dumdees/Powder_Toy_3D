import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.js';

const M = await load(['01-math.js'], [
  'clamp', 'lerp', 'smoothstep', 'v3add', 'v3sub', 'v3scale', 'v3dot', 'v3cross', 'v3len', 'v3norm',
  'mat4Identity', 'mat4Mul', 'mat4Perspective', 'mat4LookAt', 'mat4Invert', 'mat4Project',
  'rayBox', 'halton', 'tileLayout',
]);

test('clamp, lerp and smoothstep behave', () => {
  assert.equal(M.clamp(5, 0, 1), 1);
  assert.equal(M.clamp(-5, 0, 1), 0);
  assert.equal(M.lerp(2, 4, 0.5), 3);
  assert.equal(M.smoothstep(0, 1, 0.5), 0.5);
  assert.equal(M.smoothstep(0, 1, -3), 0);
  assert.equal(M.smoothstep(0, 1, 3), 1);
});

test('vector helpers', () => {
  assert.deepEqual(M.v3add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  assert.deepEqual(M.v3sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
  assert.deepEqual(M.v3scale([1, 2, 3], 2), [2, 4, 6]);
  assert.equal(M.v3dot([1, 2, 3], [4, 5, 6]), 32);
  assert.deepEqual(M.v3cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.equal(M.v3len([3, 4, 0]), 5);
  assert.deepEqual(M.v3norm([0, 0, 0]), [0, 0, 0], 'a zero vector normalises to zero, not NaN');
  const n = M.v3norm([3, 4, 0]);
  assert.ok(Math.abs(M.v3len(n) - 1) < 1e-9);
});

test('a view-projection matrix inverts back to the same point', () => {
  const vp = M.mat4Mul(M.mat4Perspective(Math.PI / 3, 1.6, 0.1, 100), M.mat4LookAt([2, 3, 8], [0, 0, 0], [0, 1, 0]));
  const inv = M.mat4Invert(vp);
  for (const p of [[0, 0, 0], [1, -2, 3], [-4, 1, 2]]) {
    const back = M.mat4Project(inv, M.mat4Project(vp, p));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - p[i]) < 1e-3, `${back} vs ${p}`);
  }
});

test('a singular matrix inverts to the identity rather than to NaN', () => {
  assert.deepEqual([...M.mat4Invert(new Float32Array(16))], [...M.mat4Identity()]);
});

test('ray against box, hit and miss', () => {
  const hit = M.rayBox([0, 0, -5], [0, 0, 1], [-1, -1, -1], [1, 1, 1]);
  assert.equal(hit.tNear, 4);
  assert.equal(hit.tFar, 6);
  const miss = M.rayBox([0, 5, -5], [0, 0, 1], [-1, -1, -1], [1, 1, 1]);
  assert.ok(miss.tFar < miss.tNear, 'a miss reports an empty range');
  // A ray running exactly along an axis outside the slab must still miss.
  const parallel = M.rayBox([9, 0, 0], [0, 0, 1], [-1, -1, -1], [1, 1, 1]);
  assert.ok(parallel.tFar < parallel.tNear);
  // Starting inside gives a negative near and a positive far.
  const inside = M.rayBox([0, 0, 0], [1, 0, 0], [-1, -1, -1], [1, 1, 1]);
  assert.ok(inside.tNear < 0 && inside.tFar === 1);
});

test('halton stays inside the unit interval and does not repeat early', () => {
  const seen = new Set();
  for (let i = 1; i < 64; i++) {
    const v = M.halton(i, 2);
    assert.ok(v >= 0 && v < 1);
    assert.ok(!seen.has(v), 'halton repeated a value');
    seen.add(v);
  }
});

test('tile layout covers every slice', () => {
  for (const nz of [1, 8, 48, 64, 80, 96, 128]) {
    const { tx, ty } = M.tileLayout(nz);
    assert.ok(tx * ty >= nz, `${nz} slices do not fit in ${tx}x${ty}`);
    assert.ok((tx - 1) * ty < nz + tx, 'layout wastes a whole column');
  }
});
