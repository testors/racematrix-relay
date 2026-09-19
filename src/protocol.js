import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';

export const VERSION = 1;
export const WS_PROTOCOL = 'racematrix-relay-v1';
export const TOKEN_PREFIX = 'racematrix-relay-bearer.';
export const MAX_AGE_MS = 2000;
export const LEASE_MS = 3000;
// Canonical daemon flag names; unknown vendor codes never become green.
export const FLAGS = new Set(['clear', 'green', 'yellow', 'double_yellow', 'red', 'blue', 'white',
  'black', 'slippery', 'safety_car', 'full_course_yellow', 'pit_entry_right', 'personal_blue',
  'personal_mechanical', 'personal_behavior', 'personal_black', 'checkered', 'slow_zone',
  'rain', 'fim_slippery', 'fim_yellow_slippery', 'vsc', 'code60', 'unknown']);
export const ID = /^[A-Za-z0-9_:.-]{1,64}$/;
export const HASH = /^[a-f0-9]{64}$/;
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function signature(secret, payload) {
  const unsigned = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'signature'));
  return createHmac('sha256', secret).update(canonicalJson(unsigned)).digest('base64');
}
export function verifySignature(secret, payload) {
  if (typeof payload.signature !== 'string') return false;
  const expected = Buffer.from(signature(secret, payload));
  const actual = Buffer.from(payload.signature);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 128) ? 7 : 0)) & 255;
  }
  return crc;
}

// Circuit-compatible v2/type 2 GPS envelope. No JSON coercion on the UDP wire.
export function decodeGps(data, session, now = Date.now()) {
  if (data.length !== 52 || data[0] !== 0xbb || data[1] !== 0x42 || data[2] !== 0x22 ||
      data[3] !== 0 || data[8] !== 1 || data[9] !== 2 || data[51] !== crc8(data.subarray(0, 51))) return null;
  if (!session || data.readUInt32LE(10) !== session.id) return null;
  const mac = createHmac('sha256', session.key).update(data.subarray(0, 35)).digest().subarray(0, 16);
  if (!timingSafeEqual(mac, data.subarray(35, 51))) return null;
  const sequence = data.readUInt32LE(4);
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(session.id, 0); nonce.writeUInt32LE(sequence, 4); nonce[8] = 2; nonce[9] = 2;
  const cipher = createDecipheriv('aes-128-ctr', session.key, nonce);
  const plain = Buffer.concat([cipher.update(data.subarray(14, 35)), cipher.final()]);
  const time = plain.readBigUInt64LE(0);
  if (time > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const timestampUs = Number(time), age = now - timestampUs / 1000;
  const longitudeE7 = plain.readInt32LE(8), latitudeE7 = plain.readInt32LE(12);
  const headingCdeg = plain.readUInt16LE(16), speedCkph = plain.readUInt16LE(18), valid = plain[20];
  if (age > MAX_AGE_MS || age < -MAX_AGE_MS || (valid & ~7) || (!(valid & 1) && valid !== 0) ||
      ((valid & 1) && (Math.abs(latitudeE7) > 900000000 || Math.abs(longitudeE7) > 1800000000)) ||
      ((valid & 4) && headingCdeg >= 36000)) return null;
  return { type: 'gps', schemaVersion: VERSION, sequence, timestampUs,
    latitudeE7: valid & 1 ? latitudeE7 : null, longitudeE7: valid & 1 ? longitudeE7 : null,
    speedCkph: valid & 2 ? speedCkph : null, headingCdeg: valid & 4 ? headingCdeg : null };
}

export function validateFlags(value, layout) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid flags');
  const flag = token => { if (token !== null && !FLAGS.has(token)) throw new Error('invalid flag'); return token; };
  const ids = new Set(layout.zones.map(z => z.id));
  if (!Array.isArray(value.zones) || value.zones.length > 48 || !Array.isArray(value.personal) || value.personal.length > 128) throw new Error('invalid flag scopes');
  const seen = new Set();
  const zones = value.zones.map(z => {
    if (!ids.has(z.id) || seen.has(z.id)) throw new Error('unknown or duplicate zone');
    seen.add(z.id); return { id: z.id, flag: flag(z.flag) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const targets = new Set();
  const personal = value.personal.map(p => {
    if (typeof p.number !== 'string' || !/^[A-Za-z0-9-]{1,16}$/.test(p.number) || (p.zoneId !== null && !ids.has(p.zoneId))) throw new Error('invalid personal flag');
    const key = `${p.zoneId}:${p.number}`;
    if (targets.has(key)) throw new Error('duplicate personal target');
    targets.add(key);
    return { number: p.number, zoneId: p.zoneId, flag: flag(p.flag) };
  }).sort((a, b) => `${a.zoneId}:${a.number}`.localeCompare(`${b.zoneId}:${b.number}`));
  return { fullCourse: flag(value.fullCourse), zones, personal };
}
