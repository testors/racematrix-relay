import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store } from '../src/store.js';
import { Relay } from '../src/server.js';
import { signature, crc8, WS_PROTOCOL, TOKEN_PREFIX } from '../src/protocol.js';

export const layout = { schemaVersion: 1, layoutId: 'test-track', revision: 1,
  zones: [{ id: 'zone-1', kind: 'path', widthM: 14, points: [[375000000, 1273000000], [375001000, 1273010000]] }] };
export async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rm-relay-test-'));
  const store = new Store(directory);
  const hash = store.putCircuit(1, 'Test circuit', layout);
  store.putCircuit(2, 'Other circuit', { ...layout, layoutId: 'other' });
  const device = store.provisionDevice({ hardwareUid: 'esp32:aabbccddeeff', circuitId: 1, number: '7' });
  const gateway = store.provisionGateway(1, 'Test gateway', true);
  let now = Date.now();
  const relay = new Relay({ store, host: '127.0.0.1', port: 0, udpHost: '127.0.0.1', udpPort: 0, now: () => now });
  const ports = await relay.start();
  t.after(async () => { await relay.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, relay, hash, device, gateway, directory, ...ports,
    baseUrl: `http://127.0.0.1:${ports.httpPort}`, now: () => now, advance: ms => { now += ms; relay.tick(); } };
}
export function signed(credential, now, extra = {}) {
  const device = !!credential.hardware_uid;
  const payload = { credential_uid: credential.credential_uid, nonce: randomBytes(16).toString('hex'),
    timestamp: new Date(now).toISOString(), ...(device ? { hardware_uid: credential.hardware_uid, source_type: 'esp32' } : { circuit_id: credential.circuit_id }), ...extra };
  payload.signature = signature(credential.source_secret ?? credential.credential_secret, payload);
  return payload;
}
export async function session(f, credential, extra = {}) {
  const response = await fetch(`${f.baseUrl}${credential.hardware_uid ? '/api/v1/telemetry/session' : '/v1/gateway/session'}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed(credential, f.now(), extra)) });
  return { status: response.status, ...await response.json() };
}
export async function connect(f, token) {
  const ws = new WebSocket(f.baseUrl.replace('http', 'ws') + '/v1/stream', [WS_PROTOCOL, TOKEN_PREFIX + token]);
  const messages = []; let firstType;
  ws.on('message', bytes => { const message = JSON.parse(bytes); firstType ??= message.type; messages.push(message); });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const take = async predicate => {
    for (let i = 0; i < 200; i++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`message timeout: ${messages.map(m => m.type).join(',')}`);
  };
  const hello = await take(m => m.type === 'hello');
  return { ws, hello, firstType, messages, take, send: message => ws.send(JSON.stringify(message)) };
}
export function packet(session, timeUs, sequence, valid = 7, { latitudeE7 = 375001000, longitudeE7 = 1273001000 } = {}) {
  const data = Buffer.alloc(52), plain = Buffer.alloc(21), nonce = Buffer.alloc(16);
  data.set([0xbb, 0x42, 0x22, 0]); data.writeUInt32LE(sequence, 4); data[8] = 1; data[9] = 2; data.writeUInt32LE(session.session_id, 10);
  nonce.writeUInt32LE(session.session_id); nonce.writeUInt32LE(sequence, 4); nonce[8] = 2; nonce[9] = 2;
  plain.writeBigUInt64LE(BigInt(timeUs)); plain.writeInt32LE(longitudeE7, 8); plain.writeInt32LE(latitudeE7, 12);
  plain.writeUInt16LE(12345, 16); plain.writeUInt16LE(1852, 18); plain[20] = valid;
  const key = Buffer.from(session.session_key, 'base64');
  const cipher = createCipheriv('aes-128-ctr', key, nonce);
  Buffer.concat([cipher.update(plain), cipher.final()]).copy(data, 14);
  createHmac('sha256', key).update(data.subarray(0, 35)).digest().copy(data, 35, 0, 16);
  data[51] = crc8(data.subarray(0, 51));
  return data;
}
