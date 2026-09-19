import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout, importCircuitLayout } from '../src/layout.js';
import { layout } from './helpers.js';

test('layout hash is canonical and geometry/size bounds are enforced', () => {
  const normalized = normalizeLayout(layout);
  assert.equal(normalizeLayout(JSON.parse(normalized.json)).hash, normalized.hash);
  assert.throws(() => normalizeLayout({ ...layout, zones: [...layout.zones, ...layout.zones] }), /identity/);
  assert.throws(() => normalizeLayout({ ...layout, zones: [{ ...layout.zones[0], points: [[1, 2], [1, 2]] }] }), /degenerate/);
  assert.throws(() => normalizeLayout({ ...layout, zones: [{ ...layout.zones[0], points: Array.from({ length: 513 }, (_, i) => [i, i]) }] }), /512/);
  const withCoverage = normalizeLayout({ ...layout, coverage: { points: layout.zones[0].points, radiusM: 150 } });
  assert.equal(normalizeLayout(JSON.parse(withCoverage.json)).hash, withCoverage.hash);
  assert.notEqual(withCoverage.hash, normalized.hash);
  assert.throws(() => normalizeLayout({ ...layout, coverage: { points: layout.zones[0].points, radiusM: 1000 } }), /coverage/);
});
test('Circuit import binds export identity and converts explicit flag track ranges, never timing sectors', () => {
  const base = { layout_id: 'circuit:test', layout_revision: 2, layout_content_hash: 'selected-export-hash', road_width: 14,
    track_points: [{ lat: 37.5, lng: 127.3 }, { lat: 37.501, lng: 127.3 }, { lat: 37.502, lng: 127.3 }], circuit_type: 'open' };
  const overlay = { base_circuit: { layout_id: base.layout_id, layout_content_hash: base.layout_content_hash },
    operational_zones: [{ id: 'z1', kind: 'flag_zone', shape: { kind: 'track_range', from_m: 0, to_m: 150 } },
      { id: 'z2', kind: 'flag_zone' }, { id: 'post', kind: 'marshal_post' }] };
  assert.throws(() => importCircuitLayout(base, overlay), /z2/);
  const imported = importCircuitLayout(base, overlay, ['z1']).layout;
  assert.equal(imported.zones[0].points.length, 3); assert.deepEqual(imported.zones[0].points[0], [375000000, 1273000000]);
  assert.throws(() => importCircuitLayout({ ...base, layout_content_hash: 'wrong' }, overlay), /does not match/);
  assert.throws(() => importCircuitLayout(base, overlay, ['missing']), /unknown/);
});
