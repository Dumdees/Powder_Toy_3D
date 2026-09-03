import test from 'node:test';
import assert from 'node:assert/strict';
import { load, PURE } from './helpers.js';

const M = await load(PURE, [
  'MATERIALS', 'MAT_COUNT', 'MAT_ROWS', 'PHASE', 'PAINTABLE', 'matId', 'packMaterials', 'simDensity', 'swatchOf',
]);

const row = (id, r) => {
  const d = M.packMaterials();
  const o = (id * M.MAT_ROWS + r) * 4;
  return [d[o], d[o + 1], d[o + 2], d[o + 3]];
};

test('ids match the position in the table', () => {
  M.MATERIALS.forEach((m, i) => assert.equal(m.id, i, `${m.name} is out of order`));
});

test('names are unique and every material is fully described', () => {
  const names = new Set();
  for (const m of M.MATERIALS) {
    assert.ok(!names.has(m.name), `duplicate material ${m.name}`);
    names.add(m.name);
    assert.ok(m.density > 0, `${m.name} has no density`);
    assert.equal(m.albedo.length, 3);
    assert.ok(m.roughness >= 0 && m.roughness <= 1, `${m.name} roughness out of range`);
    assert.ok(m.metallic >= 0 && m.metallic <= 1);
    assert.ok(m.transmission >= 0 && m.transmission <= 1);
    assert.ok(m.ior >= 1 && m.ior <= 2.5, `${m.name} ior out of range`);
    assert.ok(Object.values(M.PHASE).includes(m.phase), `${m.name} has no phase`);
  }
});

test('every change of state names a material that exists', () => {
  for (const m of M.MATERIALS) {
    for (const key of ['melt', 'freeze', 'boil', 'burn']) {
      const t = m[key];
      if (!t) continue;
      assert.ok(M.MATERIALS.some((x) => x.name === t.into), `${m.name}.${key} turns into unknown "${t.into}"`);
      assert.equal(typeof t.at, 'number');
    }
    if (m.expires) assert.ok(M.MATERIALS.some((x) => x.name === m.expires), `${m.name} expires into unknown "${m.expires}"`);
    if (m.life) assert.ok(m.expires, `${m.name} has a lifetime but nothing to become`);
  }
});

test('melting and freezing points never coincide, or a speck would flicker', () => {
  for (const m of M.MATERIALS) {
    const up = m.melt ? m.melt.at : null;
    const down = m.freeze ? m.freeze.at : null;
    if (up == null || down == null) continue;
    assert.ok(Math.abs(up - down) >= 0.5, `${m.name} melts and freezes at the same temperature`);
  }
  // The pair either way round needs a gap too: water freezes below ice's melting point.
  const water = M.MATERIALS[M.matId('Water')];
  const ice = M.MATERIALS[M.matId('Ice')];
  assert.ok(ice.melt.at > water.freeze.at, 'water and ice would swap back and forth every step');
  const steam = M.MATERIALS[M.matId('Steam')];
  assert.ok(water.boil.at > steam.freeze.at, 'water and steam would swap back and forth every step');
});

test('the density ratio the solver sees stays inside its stable band', () => {
  for (const m of M.MATERIALS) {
    const d = M.simDensity(m);
    assert.ok(d >= 0.04 && d <= 8, `${m.name} clamps to ${d}`);
  }
  assert.equal(M.simDensity(M.MATERIALS[M.matId('Water')]), 1, 'water is the reference density');
  assert.ok(M.simDensity(M.MATERIALS[M.matId('Oil')]) < 1, 'oil must float on water');
  assert.ok(M.simDensity(M.MATERIALS[M.matId('Mercury')]) > 1, 'mercury must sink');
  assert.ok(M.simDensity(M.MATERIALS[M.matId('Steam')]) < 0.5, 'steam must rise');
});

test('the lookup texture is the size the shaders index into', () => {
  const d = M.packMaterials();
  assert.equal(d.length, M.MAT_ROWS * 4 * M.MAT_COUNT);
  assert.ok(d.every(Number.isFinite), 'the material texture contains a NaN');
});

test('packed rows carry what the shaders expect', () => {
  const water = M.matId('Water');
  assert.deepEqual(row(water, 3), [1, 0, 0, 0], 'water is a liquid');
  assert.deepEqual(row(water, 5).slice(0, 2), [100, M.matId('Steam')], 'water boils into steam at 100C');
  assert.equal(row(water, 4)[2], M.MATERIALS[water].freeze.at);
  assert.equal(row(water, 4)[3], M.matId('Ice'));
  const stone = M.matId('Stone');
  assert.deepEqual(row(stone, 3), [0, 0, 0, 1], 'stone is fixed in place');
  const sand = M.matId('Sand');
  assert.deepEqual(row(sand, 3), [0, 1, 0, 0], 'sand is granular');
  assert.ok(row(sand, 0)[2] > 0.5, 'sand needs friction or it will not pile');
  // Materials with no transition are pushed out of reach rather than left at zero.
  assert.ok(row(sand, 5)[0] > 1e8, 'sand must not boil');
  assert.ok(row(water, 4)[0] > 1e8, 'water must not melt');
  assert.ok(row(M.matId('Ice'), 4)[2] < -1e8, 'ice must not freeze again');
});

test('fire sustains its own temperature; inert materials do not', () => {
  const fire = row(M.matId('Fire'), 8);
  assert.ok(fire[0] > 500 && fire[1] > 0, 'fire should hold its own heat');
  assert.deepEqual(row(M.matId('Sand'), 8), [0, 0, 0, 0]);
});

test('the palette offers every material except the empty slot', () => {
  assert.equal(M.PAINTABLE.length, M.MAT_COUNT - 1);
  assert.ok(!M.PAINTABLE.some((m) => m.id === 0));
  for (const m of M.PAINTABLE) assert.match(M.swatchOf(m), /^(#|rgb\()/);
});
