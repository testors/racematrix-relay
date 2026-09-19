import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { once } from 'node:events';
import dgram from 'node:dgram';
import { WebSocket } from 'ws';
import { Store } from '../src/store.js';
import { LatestSocket } from '../src/server.js';
import { decodeGps, signature } from '../src/protocol.js';
import { fixture, signed, session, connect, packet, layout } from './helpers.js';

test('ESP32 golden packet and session signature interoperate; corruption and stale data fail', () => {
  const v = JSON.parse(readFileSync(new URL('fixtures/gps-v2-vector.json', import.meta.url)));
  const bytes = Buffer.from(v.packet_hex, 'hex'), key = Buffer.from(v.key_hex, 'hex');
  const decoded = decodeGps(bytes, { id: v.session_id, key }, v.time_us / 1000);
  assert.equal(decoded.latitudeE7, v.latitude_e7); assert.equal(decoded.speedCkph, v.speed_ckph);
  assert.equal(signature(v.source_secret, v.session_request), v.session_signature);
  assert.equal(decodeGps(bytes, { id: v.session_id, key }, v.time_us / 1000 + 2001), null);
  bytes[20] ^= 1; assert.equal(decodeGps(bytes, { id: v.session_id, key }, v.time_us / 1000), null);
});

test('provisioning persists private credentials, stable identity and explicit scope/revocation', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.store.provisionDevice({ hardwareUid: f.device.hardware_uid, circuitId: 1 }), f.device);
  assert.throws(() => f.store.provisionDevice({ hardwareUid: f.device.hardware_uid, circuitId: 2 }), /belongs/);
  assert.notEqual(f.store.credential(f.device.credential_uid).secret, f.device.source_secret);
  assert.equal(statSync(`${f.directory}/master.key`).mode & 0o777, 0o600);
  const reopened = new Store(f.directory);
  assert.equal(reopened.unseal(reopened.credential(f.device.credential_uid).secret), f.device.source_secret); reopened.close();
  f.store.revoke(f.device.credential_uid);
  assert.throws(() => f.store.provisionDevice({ hardwareUid: f.device.hardware_uid, circuitId: 1 }), /revoked/);
  const rotated = f.store.provisionDevice({ hardwareUid: f.device.hardware_uid, circuitId: 1, rotate: true });
  assert.equal(rotated.source_public_uid, f.device.source_public_uid); assert.notEqual(rotated.source_secret, f.device.source_secret);
});

test('HTTP rejects nonce replay, tampering, guessed hardware IDs and wrong circuit; layouts are scoped', async t => {
  const f = await fixture(t), body = signed(f.device, f.now());
  const post = payload => fetch(`${f.baseUrl}/api/v1/telemetry/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await post(body)).status, 201); assert.equal((await post(body)).status, 401);
  assert.equal((await post({ ...signed(f.device, f.now()), hardware_uid: 'esp32:111111111111' })).status, 401);
  assert.equal((await session(f, f.device, { preferred_circuit_id: '2' })).status, 401);
  assert.equal((await session(f, f.gateway, { circuit_id: 2 })).status, 403);
  const auth = await session(f, f.device);
  const headers = { authorization: `Bearer ${auth.access_token}` };
  assert.equal((await fetch(`${f.baseUrl}/v1/layouts/${f.hash}`, { headers })).status, 200);
  assert.equal((await fetch(`${f.baseUrl}/v1/layouts/${f.store.circuit(2).layout_hash}`, { headers })).status, 409);
  assert.equal((await fetch(`${f.baseUrl}/v1/layouts/${f.hash}`)).status, 401);
});

test('real UDP -> WSS delivers only newer GPS, scopes circuits, and forwards no-fix', async t => {
  const f = await fixture(t), device = await session(f, f.device), gateway = await connect(f, (await session(f, f.gateway)).access_token);
  const foreign = await connect(f, (await session(f, f.store.provisionGateway(2, 'Other'))).access_token);
  const udp = dgram.createSocket('udp4'); t.after(() => udp.close());
  const send = data => new Promise((resolve, reject) => udp.send(data, f.udpPort, '127.0.0.1', e => e ? reject(e) : resolve()));
  await send(packet(device, f.now() * 1000, 2));
  const gps = await gateway.take(m => m.type === 'gps'); assert.equal(gps.sequence, 2); assert.equal(gps.sourcePublicUid, f.device.source_public_uid);
  await send(packet(device, f.now() * 1000 - 1000, 1));
  await send(packet(device, f.now() * 1000 - 5000000, 3));
  f.advance(200); await send(packet(device, f.now() * 1000, 4, 0));
  assert.equal((await gateway.take(m => m.type === 'gps')).latitudeE7, null);
  assert.equal(f.relay.stats.gpsAccepted, 2); assert.equal(f.relay.stats.gpsRejected, 2);
  assert.equal(foreign.messages.some(m => m.type === 'gps'), false);
  const replacement = await session(f, f.device);
  await send(packet(replacement, f.now() * 1000 - 50000, 0));
  await send(packet(device, f.now() * 1000 - 25000, 5));
  f.advance(200); await send(packet(replacement, f.now() * 1000, 1));
  assert.equal((await gateway.take(m => m.type === 'gps')).sequence, 1);
  assert.equal(f.relay.stats.gpsRejected, 4);
  f.store.revoke(f.device.credential_uid); f.advance(1001);
  await send(packet(replacement, f.now() * 1000, 2));
  await new Promise(r => setTimeout(r, 30)); assert.equal(f.relay.stats.gpsAccepted, 3);
});

test('flag snapshot, change, personal targeting, heartbeat lease, expiry, publisher fencing and reconnect', async t => {
  const f = await fixture(t);
  const d = await connect(f, (await session(f, f.device)).access_token), g = await connect(f, (await session(f, f.gateway)).access_token);
  assert.equal(d.firstType, 'hello'); assert.equal(g.firstType, 'hello');
  await d.take(m => m.type === 'flags.snapshot' && !m.healthy);
  const flags = { fullCourse: 'yellow', zones: [{ id: 'zone-1', flag: 'red' }], personal: [{ number: '7', zoneId: null, flag: 'personal_blue' }, { number: '8', zoneId: null, flag: 'personal_black' }] };
  const publish = (peer, sequence, extra = {}) => peer.send({ type: 'flags.publish', epoch: peer.hello.epoch, sequence, layoutHash: f.hash, observedAtMs: f.now(), healthy: true, flags, ...extra });
  publish(g, 1);
  const state = await d.take(m => m.type === 'flags.snapshot' && m.healthy);
  assert.equal(state.flags.personal.length, 1); assert.equal(state.flags.personal[0].number, '7');
  f.advance(1500);
  g.send({ type: 'flags.heartbeat', epoch: g.hello.epoch, sequence: 1, layoutHash: f.hash, observedAtMs: f.now(), healthy: true });
  const lease = await d.take(m => m.type === 'flags.lease'); assert.equal(lease.revision, state.revision); assert.equal(lease.validUntilMs, f.now() + 3000);
  f.advance(3001); assert.equal((await d.take(m => m.type === 'flags.snapshot' && !m.healthy && m.epoch === state.epoch)).validUntilMs, 0);
  publish(g, 2); assert.equal((await d.take(m => m.type === 'flags.snapshot' && m.healthy)).revision, 2);
  const closed = once(g.ws, 'close');
  const g2 = await connect(f, (await session(f, f.gateway)).access_token); await closed;
  assert.notEqual(g2.hello.epoch, g.hello.epoch);
  await d.take(m => m.type === 'flags.snapshot' && !m.healthy);
  publish(g2, 0); assert.equal((await d.take(m => m.type === 'flags.snapshot' && m.healthy)).epoch, g2.hello.epoch);
  const d2 = await connect(f, (await session(f, f.device)).access_token);
  assert.equal((await d2.take(m => m.type === 'flags.snapshot')).flags.fullCourse, 'yellow');
  const gone = once(g2.ws, 'close'); g2.ws.close(); await gone;
  assert.equal((await d2.take(m => m.type === 'flags.snapshot' && !m.healthy)).validUntilMs, 0);
});

test('reader cannot publish; wrong epoch fails; layout change updates device assignment', async t => {
  const f = await fixture(t);
  const reader = await connect(f, (await session(f, f.store.provisionGateway(1, 'Reader'))).access_token);
  const closed = once(reader.ws, 'close'); reader.send({ type: 'flags.publish' }); assert.equal((await closed)[0], 1008);
  const g = await connect(f, (await session(f, f.gateway)).access_token);
  const rejected = once(g.ws, 'close'); g.send({ type: 'flags.publish', epoch: 'wrong', sequence: 0 }); assert.equal((await rejected)[0], 1008);
  const d = await connect(f, (await session(f, f.device)).access_token);
  const hash = f.store.putCircuit(1, 'Test', { ...layout, revision: 2 }); f.advance(1001);
  assert.equal((await d.take(m => m.type === 'circuit.assignment')).layoutHash, hash);
});

test('outbound queue replaces old GPS and closes slow streams instead of replaying backlog', () => {
  let now = 10000; const sent = []; let terminated = false;
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: data => sent.push(JSON.parse(data)), terminate: () => { terminated = true; } };
  const queue = new LatestSocket(ws, () => now);
  for (let sequence = 0; sequence < 100; sequence++) queue.put('gps:one', { type: 'gps', timestampUs: now * 1000, sequence });
  queue.flush(); assert.equal(sent.length, 1); assert.equal(sent[0].sequence, 99);
  queue.put('gps:old', { type: 'gps', timestampUs: 1 }); queue.flush(); assert.equal(sent.length, 1);
  ws.bufferedAmount = 20000; queue.flush(); now += 1001; queue.flush(); assert.equal(terminated, true);
});

test('an expired heartbeat cannot revive a snapshot before the maintenance timer notices expiry', async t => {
  const f = await fixture(t), auth = await session(f, f.gateway);
  const g = await connect(f, auth.access_token);
  const peer = [...f.relay.peers].find(p => p.uid === f.gateway.credential_uid);
  const common = { epoch: g.hello.epoch, layoutHash: f.hash, sequence: 0, observedAtMs: f.now(), healthy: true };
  f.relay.message(peer, { ...common, type: 'flags.publish', flags: { fullCourse: 'green', zones: [], personal: [] } });
  f.relay.flags.get(1).validUntilMs = f.now();
  assert.throws(() => f.relay.message(peer, { ...common, type: 'flags.heartbeat' }), /snapshot required/);
});
