import { createHash } from 'node:crypto';
import { canonicalJson, ID } from './protocol.js';

export function normalizeLayout(value) {
  if (value?.schemaVersion !== 1 || typeof value.layoutId !== 'string' || value.layoutId.length > 160 ||
      !value.layoutId || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Array.isArray(value.zones) || value.zones.length < 1 || value.zones.length > 48) throw new Error('invalid layout identity or zones');
  const ids = new Set(); let count = 0;
  const zones = value.zones.map(zone => {
    if (typeof zone.id !== 'string' || !ID.test(zone.id) || ids.has(zone.id) || !['path', 'polygon'].includes(zone.kind)) throw new Error('invalid zone identity');
    ids.add(zone.id);
    if (!Array.isArray(zone.points) || zone.points.length < (zone.kind === 'path' ? 2 : 3)) throw new Error('invalid zone geometry');
    count += zone.points.length;
    const points = zone.points.map(p => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isSafeInteger) || Math.abs(p[0]) > 900000000 || Math.abs(p[1]) > 1800000000) throw new Error('points must be [latitudeE7, longitudeE7]');
      return [...p];
    });
    if (new Set(points.map(p => p.join(','))).size < (zone.kind === 'path' ? 2 : 3)) throw new Error('degenerate zone geometry');
    if (zone.kind === 'polygon') {
      const [lat, lon] = points[0];
      const area = points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + (p[0] - lat) * (q[1] - lon) - (q[0] - lat) * (p[1] - lon);
      }, 0);
      if (!area) throw new Error('degenerate polygon');
    }
    const widthM = zone.kind === 'path' ? zone.widthM : 0;
    if (!Number.isFinite(widthM) || (zone.kind === 'path' && (widthM < 2 || widthM > 100))) throw new Error('path widthM must be 2..100');
    return { id: zone.id, kind: zone.kind, points, widthM };
  });
  if (count > 512) throw new Error('layout exceeds 512 points');
  const layout = { schemaVersion: 1, layoutId: value.layoutId, revision: value.revision, zones };
  if (value.coverage !== undefined) {
    const c = value.coverage;
    if (!c || !Number.isFinite(c.radiusM) || c.radiusM < 25 || c.radiusM > 500 ||
        !Array.isArray(c.points) || c.points.length < 2 || c.points.length > 512 ||
        c.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isSafeInteger) ||
          Math.abs(p[0]) > 900000000 || Math.abs(p[1]) > 1800000000)) throw new Error('invalid circuit coverage');
    layout.coverage = { points: c.points.map(p => [...p]), radiusM: c.radiusM };
  }
  const json = canonicalJson(layout);
  if (Buffer.byteLength(json) > 32768) throw new Error('layout exceeds 32 KiB');
  return { layout, json, hash: createHash('sha256').update(json).digest('hex') };
}

// Preserve flag-zone identity from the operations overlay; timing sectors are
// deliberately not guessed to be flag zones. Input files are explicitly chosen.
export function importCircuitLayout(base, overlay, selectedIds = null) {
  if (!base?.layout_id || !base.layout_content_hash || overlay?.base_circuit?.layout_id !== base.layout_id ||
      overlay.base_circuit.layout_content_hash !== base.layout_content_hash) throw new Error('overlay does not match the base layout');
  const available = (overlay.operational_zones ?? []).filter(z => z.kind === 'flag_zone');
  if (selectedIds && selectedIds.some(id => !available.some(z => z.id === id))) throw new Error('unknown selected flag zone');
  const zones = available.filter(z => !selectedIds || selectedIds.includes(z.id)).map(z => {
    const shape = z.shape;
    const points = shape?.kind === 'track_range' ? trackRange(base, shape.from_m, shape.to_m) : shape?.points;
    const kind = ['polyline', 'path', 'track_range'].includes(shape?.kind) ? 'path' : shape?.kind === 'polygon' ? 'polygon' : null;
    if (!kind || !Array.isArray(points)) throw new Error(`zone ${z.id} has no supported geometry; select explicit --zone-ids or provide its geometry`);
    return { id: z.id, kind, widthM: shape.width_m ?? base.road_width ?? 20,
      points: points.map(p => {
        // RaceMatrix Circuit exports use explicit latitude/longitude objects.
        const lat = p.lat, lng = p.lng;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('invalid overlay coordinates');
        return [Math.round(lat * 1e7), Math.round(lng * 1e7)];
      }) };
  });
  return normalizeLayout({ schemaVersion: 1, layoutId: base.layout_id, revision: base.layout_revision, zones });
}

function trackRange(base, from, to) {
  const points = base.track_points?.map(p => ({ lat: p.lat, lng: p.lng }));
  if (!points || points.length < 2 || points.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) ||
      !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) throw new Error('invalid track range');
  if (base.circuit_type === 'closed' && JSON.stringify(points[0]) !== JSON.stringify(points.at(-1))) points.push(points[0]);
  const rad = Math.PI / 180, distances = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
    distances.push(distances.at(-1) + 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h))));
  }
  if (to > distances.at(-1) + 1 || from >= distances.at(-1)) throw new Error('track range exceeds centerline');
  const at = distance => {
    for (let i = 1; i < points.length; i++) if (distances[i] >= distance && distances[i] > distances[i - 1]) {
      const t = (distance - distances[i - 1]) / (distances[i] - distances[i - 1]), a = points[i - 1], b = points[i];
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    return points.at(-1);
  };
  return [at(from), ...points.filter((_, i) => distances[i] > from && distances[i] < to), at(to)];
}
