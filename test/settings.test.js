import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { fixture, session, connect } from './helpers.js';

const reported = { gnssMode: 0, staticHoldCms: 0, agnss: false, parking: true, debugLocation: 'none', tickLog: false, sessionSleep: false, sleepCheckMin: 10, sleepLeadMin: 10, sleepUntil: 0 };

test('a device reports its settings; the owner asks for changes and the device confirms them by revision', async t => {
  const f = await fixture(t);
  f.store.setDeviceOwner(f.device.source_public_uid, 1);
  const deviceSession = await session(f, f.device);
  const gatewaySession = await session(f, f.gateway);
  const gateway = await connect(f, gatewaySession.access_token);
  const info = async (body, token = deviceSession.access_token) => {
    const response = await fetch(`${f.baseUrl}/v1/device/info`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  let id = 0;
  const admin = async (op, args = {}) => {
    const requestId = `settings${++id}`;
    gateway.send({ type: 'admin.request', id: requestId, op, args });
    return gateway.take(m => m.id === requestId);
  };
  const listed = async () => (await admin('devices.list')).result.devices.find(d => d.sourceUid === f.device.source_public_uid);
  const change = settings => admin('devices.settings', { sourceUid: f.device.source_public_uid, settings });

  assert.equal((await listed()).settings, null, 'older firmware has reported nothing');
  assert.equal((await change({ parking: false })).error, 'device has not reported its settings');

  for (const settings of [null, [], {}, 'x', { 'bad key': 1 }, { a: 1.5 }, { a: 2 ** 31 }, { a: null }, { a: {} }, { a: 'has space' },
    { a: 'x'.repeat(33) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))]) {
    assert.equal((await info({ settings })).status, 400, `rejected: ${JSON.stringify(settings)}`);
  }
  for (const settings_revision of [0, -1, 1.5, '7', 2 ** 32, null]) assert.equal((await info({ settings: reported, settings_revision })).status, 400);
  assert.equal((await listed()).settings, null, 'an invalid report stores nothing');

  const first = await info({ modem_imei: '863235087085013', settings: reported });
  assert.deepEqual([first.status, first.settings_request], [200, undefined]);
  assert.deepEqual((await listed()).settings, { values: reported, reportedAtMs: f.now(), pending: null, requestedAtMs: null });
  const reportedAt = f.now();
  f.advance(1000);
  assert.equal((await info({ modem_imei: '863235087085013' })).status, 200);
  assert.deepEqual((await listed()).settings.values, reported, 'a report without settings keeps the last one');
  assert.equal((await listed()).settings.reportedAtMs, reportedAt);

  for (const settings of [undefined, {}, { unknown: true }, { parking: 1 }, { gnssMode: '3' }, { debugLocation: true }]) {
    assert.equal((await change(settings)).error, 'invalid device settings', `refused: ${JSON.stringify(settings)}`);
  }
  assert.equal((await listed()).settings.pending, null);

  // The open stream gets the request at once, a report gets it in its reply.
  const device = await connect(f, deviceSession.access_token);
  await device.take(m => m.type === 'flags.snapshot');
  const asked = await change({ parking: false });
  assert.deepEqual([asked.ok, asked.result.settings.pending, asked.result.settings.requestedAtMs], [true, { parking: false }, f.now()]);
  const pushed = await device.take(m => m.type === 'flags.snapshot' && m.settingsRequest);
  const revision = pushed.settingsRequest.revision;
  assert.deepEqual(pushed.settingsRequest, { revision, settings: { parking: false } });
  assert.ok(Number.isInteger(revision) && revision >= Math.floor(f.now() / 1000) && revision <= 0xffffffff);

  const merged = await change({ gnssMode: 4 });
  assert.deepEqual(merged.result.settings.pending, { parking: false, gnssMode: 4 }, 'requests made before the answer are merged');
  const polled = await info({ modem_imei: '863235087085013' });
  assert.deepEqual(polled.settings_request, { revision: revision + 1, settings: { parking: false, gnssMode: 4 } });

  // Confirming an older revision leaves the newer request in place.
  const applied = { ...reported, parking: false, gnssMode: 4 };
  assert.deepEqual((await info({ settings: applied, settings_revision: revision })).settings_request?.revision, revision + 1);
  const reopened = new Store(f.directory);
  assert.equal(JSON.parse(reopened.deviceBySource(f.device.source_public_uid).settings_request).gnssMode, 4, 'a pending request survives a restart');
  reopened.close();
  const confirmed = await info({ settings: applied, settings_revision: revision + 1 });
  assert.deepEqual([confirmed.status, confirmed.settings_request], [200, undefined]);
  assert.deepEqual((await listed()).settings, { values: applied, reportedAtMs: f.now(), pending: null, requestedAtMs: null });
  device.messages.length = 0; // Snapshots pushed while the request was pending.
  device.send({ type: 'snapshot.request' });
  assert.equal((await device.take(m => m.type === 'flags.snapshot')).settingsRequest, undefined);

  // A value the unit did not accept is confirmed too; the report is the truth.
  const refused = await change({ staticHoldCms: 5000 });
  assert.equal(refused.result.settings.pending.staticHoldCms, 5000);
  assert.ok((await info({ modem_imei: '863235087085013' })).settings_request.revision > revision + 1, 'revisions only increase');
  const answer = await info({ settings: applied, settings_revision: (await info({})).settings_request.revision });
  assert.equal(answer.settings_request, undefined);
  assert.deepEqual([(await listed()).settings.values.staticHoldCms, (await listed()).settings.pending], [0, null]);
});

test('only the owning circuit changes settings; gateways and unregistered units cannot report or be asked', async t => {
  const f = await fixture(t);
  const deviceSession = await session(f, f.device);
  const gatewaySession = await session(f, f.gateway);
  const gateway = await connect(f, gatewaySession.access_token);
  const info = (body, token) => fetch(`${f.baseUrl}/v1/device/info`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  let id = 0;
  const change = async sourceUid => {
    const requestId = `owner${++id}`;
    gateway.send({ type: 'admin.request', id: requestId, op: 'devices.settings', args: { sourceUid, settings: { parking: false } } });
    return gateway.take(m => m.id === requestId);
  };
  assert.equal((await info({ settings: reported }, gatewaySession.access_token)).status, 401);
  assert.equal((await info({ settings: reported }, deviceSession.access_token)).status, 200);
  assert.equal((await gateway.take(m => m.type === 'flags.snapshot')).settingsRequest, undefined, 'gateways never receive device requests');

  f.store.setDeviceOwner(f.device.source_public_uid, 2);
  assert.equal((await change(f.device.source_public_uid)).error, "only the owning circuit can change this device's settings");
  assert.equal((await change('GZZZZZZZZ')).error, 'unknown device');
  f.store.setDeviceOwner(f.device.source_public_uid, 1);
  assert.equal((await change(f.device.source_public_uid)).ok, true);

  // A unit that is reset and enrolls again does not inherit the request.
  const enroll = secret => fetch(`${f.baseUrl}/v1/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hardware_uid: 'esp32:aabbccddeeff', source_type: 'esp32', enroll_secret: secret }) });
  f.store.revoke(f.device.credential_uid);
  assert.equal((await enroll('s'.repeat(43))).status, 201);
  assert.equal(f.store.deviceByHardware('esp32:aabbccddeeff').settings_request, null);
});


test('session sleep configuration and an absolute permission survive relay delivery without changing types', async t => {
  const f = await fixture(t);
  f.store.setDeviceOwner(f.device.source_public_uid, 1);
  const device = await session(f, f.device);
  const info = body => fetch(`${f.baseUrl}/v1/device/info`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device.access_token}` }, body: JSON.stringify(body) });
  await info({ settings: reported });
  const gateway = await connect(f, (await session(f, f.gateway)).access_token);
  const settings = { sessionSleep: true, sleepCheckMin: 60, sleepLeadMin: 15, sleepUntil: Math.floor(f.now() / 1000) + 600 };
  gateway.send({ type: 'admin.request', id: 'sleep', op: 'devices.settings', args: { sourceUid: f.device.source_public_uid, settings } });
  assert.equal((await gateway.take(m => m.id === 'sleep')).ok, true);
  const response = await (await info({ parked: true })).json();
  assert.deepEqual(response.settings_request.settings, settings);
  await info({ settings: { ...reported, ...settings }, settings_revision: response.settings_request.revision });
  assert.equal(f.store.deviceBySource(f.device.source_public_uid).settings_request, null);
});
