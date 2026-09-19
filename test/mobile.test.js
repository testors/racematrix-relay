import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, session, connect, packet, layout } from './helpers.js';
import { CircuitRouter } from '../src/routing.js';

const settings = { baseUrl: 'https://relay.example.test', label: 'Phone' };
test('mobile activation is single-installation, retryable, expiring, revocable and HTTPS-only', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.inviteMobile({ ...settings, baseUrl: 'http://relay.example.test' }));
  const invite = f.store.inviteMobile({ ...settings, now: f.now() });
  assert.match(invite.source_public_uid, /^SRC-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(invite.source_secret, undefined);
  const claim = randomBytes(32).toString('hex');
  const activate = async (code = invite.activation_code, nonce = claim) => {
    const response = await fetch(`${f.baseUrl}/v1/mobile/activate`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activation_code: code, claim_nonce: nonce }) });
    return { status: response.status, ...await response.json() };
  };
  const first = await activate(); assert.equal(first.status, 201); assert.match(first.hardware_uid, /^mobile:[a-f0-9]{32}$/);
  assert.deepEqual(await activate(), first);
  assert.equal((await activate(invite.activation_code, randomBytes(32).toString('hex'))).status, 401);
  assert.equal((await session(f, first)).status, 401); // Cannot impersonate ESP32 source_type.
  assert.equal((await session(f, first, { source_type: 'mobile' })).status, 201);
  f.store.revoke(first.credential_uid); assert.equal((await activate()).status, 401);
  f.store.provisionDevice({ hardwareUid: first.hardware_uid, rotate: true });
  assert.equal((await activate()).status, 401); // Rotation cannot expose its new key through an old invitation.
  const next = f.store.inviteMobile({ ...settings, ttlMinutes: 1, now: f.now() });
  f.advance(60000); assert.equal((await activate(next.activation_code)).status, 401);
  const raw = f.store.db.prepare('SELECT * FROM mobile_invites').all();
  assert.equal(JSON.stringify(raw).includes(invite.activation_code), false);
  assert.equal(JSON.stringify(raw).includes(claim), false);
});

test('1 Hz jitter acquires a circuit; repeated or stale timestamps cannot acquire', () => {
  const router = new CircuitRouter(); router.layouts.set(1, { layout, until: 100000 });
  const fix = time => ({ timestampUs: time * 1000, latitudeE7: 375000500, longitudeE7: 1273005000 });
  for (const time of [1000, 2110]) assert.equal(router.observe('phone', fix(time), time), 0);
  assert.equal(router.observe('phone', fix(3180), 3180), 1);
  assert.equal(router.observe('phone', fix(3180), 5181), 0);
  assert.equal(router.observe('phone', fix(6000), 6000), 0);
  for (let i = 0; i < 4; i++) assert.equal(router.observe('phone', fix(6000), 6200), 0);
  assert.equal(router.observe('phone', fix(8101), 8101), 0); // Over 2 s starts new acquisition.
});

test('mobile UDP shares GPS and flag channels, automatically acquires named circuit at 1 Hz', async t => {
  const f = await fixture(t);
  const invite = f.store.inviteMobile({ ...settings, now: f.now() });
  const device = f.store.redeemMobile(invite.activation_code, randomBytes(32).toString('hex'), f.now());
  const gateway = await connect(f, (await session(f, f.gateway)).access_token);
  gateway.send({ type: 'layout.publish', schemaVersion: 1, circuitId: 1, epoch: gateway.hello.epoch, sequence: 0,
    observedAtMs: f.now(), layout });
  await gateway.take(m => m.type === 'layout.accepted');
  const auth = await session(f, device, { source_type: 'mobile' });
  const phone = await connect(f, auth.access_token);
  assert.equal(phone.hello.circuitName, null);
  for (let sequence = 0; sequence < 3; sequence++) {
    f.advance(1100); f.relay.receiveGps(packet(auth, f.now() * 1000, sequence));
  }
  const assigned = await phone.take(m => m.type === 'circuit.assignment' && m.circuitId === 1);
  assert.equal(assigned.circuitName, 'Test circuit'); assert.equal(assigned.layoutHash, f.hash);
  gateway.send({ type: 'flags.publish', epoch: gateway.hello.epoch, sequence: 0, observedAtMs: f.now(),
    layoutHash: f.hash, healthy: true, flags: { fullCourse: 'red', zones: [], personal: [] } });
  assert.equal((await phone.take(m => m.type === 'flags.snapshot' && m.healthy)).flags.fullCourse, 'red');
  assert.equal((await gateway.take(m => m.type === 'gps')).sourcePublicUid, device.source_public_uid);
  assert.equal((await session(f, device, { source_type: 'mobile' })).circuit_name, 'Test circuit');
});
