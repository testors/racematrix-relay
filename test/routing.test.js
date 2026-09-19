import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CircuitRouter } from '../src/routing.js';
import { fixture, session, connect, packet, layout } from './helpers.js';

const farLayout = { ...layout, layoutId: 'second-track', zones: layout.zones.map(z => ({ ...z, points: z.points.map(([lat, lon]) => [lat + 10000000, lon]) })) };
const fix = (time, lat = 375001000) => ({ timestampUs: time * 1000, latitudeE7: lat, longitudeE7: 1273001000 });

test('GPS selection waits for distinct fixes, clears ambiguity, off-track, no-fix and expired layouts', () => {
  const router = new CircuitRouter();
  router.layouts.set(1, { layout, until: 10000 });
  assert.equal(router.observe('one', fix(1000), 1000), 0);
  for (let i = 0; i < 10; i++) assert.equal(router.observe('one', fix(1000), 1000), 0);
  assert.equal(router.observe('one', fix(1200), 1200), 0);
  assert.equal(router.observe('one', fix(1400), 1400), 1);
  router.layouts.set(2, { layout, until: 10000 });
  assert.equal(router.observe('one', fix(1600), 1600), 0);
  router.layouts.delete(2);
  for (const t of [1800, 2000, 2200]) router.observe('one', fix(t), t);
  assert.equal(router.circuit('one'), 1);
  assert.equal(router.observe('one', fix(2400, 0), 2400), 0);
  for (const t of [2600, 2800, 3000]) router.observe('one', fix(t), t);
  assert.equal(router.observe('one', { ...fix(3200), latitudeE7: null, longitudeE7: null }, 3200), 0);
  for (const t of [3400, 3600, 3800]) router.observe('one', fix(t), t);
  assert.equal(router.observe('one', fix(3800), 5801), 0);
  router.layouts.get(1).until = 6000;
  assert.equal(router.observe('one', fix(6100), 6100), 0);
});

async function publishLayout(f, peer, value, sequence = 0) {
  peer.send({ type: 'layout.publish', schemaVersion: 1, circuitId: peer.hello.circuitId,
    epoch: peer.hello.epoch, sequence, observedAtMs: f.now(), layout: value });
  return (await peer.take(m => m.type === 'layout.accepted' && m.sequence === sequence)).layoutHash;
}

test('one relay routes a roaming device to two circuits with scoped layouts, flags and personal numbers', async t => {
  const f = await fixture(t);
  const roaming = f.store.provisionDevice({ hardwareUid: 'esp32:111111111111' });
  f.store.setDeviceNumber(roaming.source_public_uid, 1, '7');
  f.store.setDeviceNumber(roaming.source_public_uid, 2, '42');
  const g1 = await connect(f, (await session(f, f.gateway)).access_token);
  const g2 = await connect(f, (await session(f, f.store.provisionGateway(2, 'Second', true))).access_token);
  const hash1 = await publishLayout(f, g1, layout), hash2 = await publishLayout(f, g2, farLayout);
  const auth = await session(f, roaming), d = await connect(f, auth.access_token);
  assert.equal(auth.circuit_id, 0); assert.equal(auth.layout_hash, null); assert.equal(d.hello.circuitId, 0);
  const publish = (peer, hash, color) => peer.send({ type: 'flags.publish', epoch: peer.hello.epoch, sequence: 0,
    layoutHash: hash, observedAtMs: f.now(), healthy: true,
    flags: { fullCourse: color, zones: [], personal: [{ number: '7', zoneId: null, flag: 'personal_blue' }, { number: '42', zoneId: null, flag: 'personal_black' }] } });
  publish(g1, hash1, 'yellow'); publish(g2, hash2, 'red');
  await g1.take(m => m.type === 'flags.snapshot' && m.healthy);
  await g2.take(m => m.type === 'flags.snapshot' && m.healthy);
  let seq = 0;
  const gps = lat => { f.advance(200); f.relay.receiveGps(packet(auth, f.now() * 1000, seq++, 7, { latitudeE7: lat })); };
  gps(375001000); gps(375001000); gps(375001000);
  assert.equal((await d.take(m => m.type === 'circuit.assignment')).circuitId, 1);
  let flags = await d.take(m => m.type === 'flags.snapshot' && m.healthy);
  assert.equal(flags.flags.fullCourse, 'yellow'); assert.deepEqual(flags.flags.personal.map(p => p.number), ['7']);
  assert.equal((await g1.take(m => m.type === 'gps')).sourcePublicUid, roaming.source_public_uid);
  assert.equal(g2.messages.some(m => m.type === 'gps'), false);
  const fetchLayout = hash => fetch(`${f.baseUrl}/v1/layouts/${hash}`, { headers: { authorization: `Bearer ${auth.access_token}` } });
  assert.equal((await fetchLayout(hash1)).status, 200); assert.equal((await fetchLayout(hash2)).status, 409);
  gps(385001000);
  assert.equal((await d.take(m => m.type === 'circuit.assignment')).circuitId, 0);
  await d.take(m => m.type === 'flags.snapshot' && !m.healthy && m.circuitId === 0);
  gps(385001000); gps(385001000);
  assert.equal((await d.take(m => m.type === 'circuit.assignment')).circuitId, 2);
  flags = await d.take(m => m.type === 'flags.snapshot' && m.healthy && m.circuitId === 2);
  assert.equal(flags.flags.fullCourse, 'red'); assert.deepEqual(flags.flags.personal.map(p => p.number), ['42']);
  assert.equal((await g2.take(m => m.type === 'gps')).sourcePublicUid, roaming.source_public_uid);
  assert.equal((await fetchLayout(hash1)).status, 409); assert.equal((await fetchLayout(hash2)).status, 200);
  assert.equal(f.store.credential(roaming.credential_uid).circuit_id, null);
  g2.send({ type: 'layout.withdraw', schemaVersion: 1, circuitId: 2, epoch: g2.hello.epoch, sequence: 1, observedAtMs: f.now() });
  await g2.take(m => m.type === 'layout.accepted' && m.layoutHash === null);
  assert.equal((await d.take(m => m.type === 'circuit.assignment')).circuitId, 0);
});

test('layout publishing is circuit scoped and old epochs cannot overwrite current selection', async t => {
  const f = await fixture(t), g = await connect(f, (await session(f, f.gateway)).access_token);
  await publishLayout(f, g, layout);
  const otherHash = f.store.circuit(2).layout_hash;
  const closed = once(g.ws, 'close');
  g.send({ type: 'layout.publish', schemaVersion: 1, circuitId: 2, epoch: g.hello.epoch, sequence: 1, observedAtMs: f.now(), layout: farLayout });
  assert.equal((await closed)[0], 1008); assert.equal(f.store.circuit(2).layout_hash, otherHash);
  const next = await connect(f, (await session(f, f.gateway)).access_token);
  const oldEpoch = once(next.ws, 'close');
  next.send({ type: 'layout.publish', schemaVersion: 1, circuitId: 1, epoch: g.hello.epoch, sequence: 2, observedAtMs: f.now(), layout: farLayout });
  assert.equal((await oldEpoch)[0], 1008); assert.equal(f.store.circuit(1).layout_hash, f.hash);
});

test('a circuit starts without a manual layout and accepts its first authenticated live publication', async t => {
  const f = await fixture(t);
  f.store.createCircuit(3, 'New circuit');
  const g = await connect(f, (await session(f, f.store.provisionGateway(3, 'New pair', true))).access_token);
  assert.equal(g.hello.layoutHash, null);
  const hash = await publishLayout(f, g, farLayout);
  assert.equal(f.store.circuit(3).layout_hash, hash);
});

test('layout heartbeat cannot revive an expired publication and publisher disconnect removes only its circuit', async t => {
  const f = await fixture(t), g = await connect(f, (await session(f, f.gateway)).access_token);
  const hash = await publishLayout(f, g, layout);
  const peer = [...f.relay.peers].find(p => p.uid === f.gateway.credential_uid);
  f.advance(5001);
  assert.equal(f.relay.router.layouts.has(1), false);
  assert.throws(() => f.relay.layoutMessage(peer, { type: 'layout.heartbeat', schemaVersion: 1, circuitId: 1,
    epoch: peer.epoch, sequence: 0, layoutHash: hash, observedAtMs: f.now() }), /snapshot required/);
  await publishLayout(f, g, layout, 1);
  const g2 = await connect(f, (await session(f, f.store.provisionGateway(2, 'Second', true))).access_token);
  await publishLayout(f, g2, farLayout);
  const closed = once(g.ws, 'close'); g.ws.close(); await closed;
  for (let i = 0; i < 20 && f.relay.router.layouts.has(1); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.relay.router.layouts.has(1), false); assert.equal(f.relay.router.layouts.has(2), true);
});
