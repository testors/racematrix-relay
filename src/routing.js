// Coverage chooses a venue; flag-zone geometry still chooses the driving zone
// on the device. Never choose the nearest circuit when multiple venues match.
function inPath(points, radius, lat, lon, polygon = false) {
  const cos = Math.cos(lat * Math.PI / 1800000000), scale = .0111194926644559;
  let inside = false;
  for (let i = 0; i < points.length - (polygon ? 0 : 1); i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    const ax = (p[1] - lon) * scale * cos, ay = (p[0] - lat) * scale;
    const bx = (q[1] - lon) * scale * cos, by = (q[0] - lat) * scale;
    if (polygon && (ay > 0) !== (by > 0) && 0 < ax + (bx - ax) * -ay / (by - ay)) inside = !inside;
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
    if ((ax + t * dx) ** 2 + (ay + t * dy) ** 2 <= radius ** 2) return true;
  }
  return inside;
}

export function covers(layout, sample) {
  const { latitudeE7: lat, longitudeE7: lon } = sample;
  if (!Number.isInteger(lat) || !Number.isInteger(lon)) return false;
  if (layout.coverage) return inPath(layout.coverage.points, layout.coverage.radiusM, lat, lon);
  return layout.zones.some(z => inPath(z.points, z.kind === 'path' ? 150 : 0, lat, lon, z.kind === 'polygon'));
}

export class CircuitRouter {
  constructor() { this.layouts = new Map(); this.devices = new Map(); }
  observe(uid, sample, now) {
    let state = this.devices.get(uid);
    if (!state) { state = { circuitId: 0, candidate: 0, count: 0, since: 0, lastTimestamp: 0 }; this.devices.set(uid, state); }
    const fresh = sample && now - sample.timestampUs / 1000 <= 2000 && sample.timestampUs / 1000 - now <= 2000 &&
      (!Number.isFinite(sample.receivedAtMs) || now - sample.receivedAtMs <= 2000);
    const matches = fresh ? [...this.layouts].filter(([, entry]) => entry.until > now && covers(entry.layout, sample)).map(([id]) => id) : [];
    if (matches.length !== 1) {
      state.circuitId = state.candidate = state.count = 0;
      if (fresh) state.lastTimestamp = Math.max(state.lastTimestamp, sample.timestampUs);
      return 0;
    }
    const selected = matches[0];
    if (state.circuitId === selected) { state.lastTimestamp = Math.max(state.lastTimestamp, sample.timestampUs); return selected; }
    // Invalidate the old venue immediately; require three distinct fixes over
    // at least 400 ms before enabling flags from a different venue.
    state.circuitId = 0;
    // Permit 1 Hz mobile GPS with scheduling jitter, still bounded by the
    // same 2 s freshness contract and three distinct sensor timestamps.
    if (state.candidate !== selected || sample.timestampUs - state.lastTimestamp > 2000000) {
      state.candidate = selected; state.count = 0; state.since = sample.timestampUs;
    }
    if (sample.timestampUs > state.lastTimestamp) { state.count++; state.lastTimestamp = sample.timestampUs; }
    if (state.count >= 3 && sample.timestampUs - state.since >= 400000) state.circuitId = selected;
    return state.circuitId;
  }
  circuit(uid) { return this.devices.get(uid)?.circuitId ?? 0; }
}
