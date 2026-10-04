import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { fixture, session, connect } from './helpers.js';

test('generic device snapshots retain unknown keys, persist, replace and age independently of other reports', async t => {
  const f = await fixture(t), device = await session(f, f.device);
  let gateway = await connect(f, (await session(f, f.gateway)).access_token), id = 0;
  const info = (body, token = device.access_token) => fetch(`${f.baseUrl}/v1/device/info`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const listed = async () => {
    const requestId = `state-${++id}`;
    gateway.send({ type: 'admin.request', id: requestId, op: 'devices.list' });
    return (await gateway.take(m => m.id === requestId)).result.devices.find(d => d.sourceUid === f.device.source_public_uid);
  };
  assert.equal((await listed()).state, null);
  const state = { schemaVersion: 1, bootId: 'boot-a', sequence: 2, uptimeMs: 12345, droppedUpdates: 0,
    values: { 'future.feature': 'new', 'gps.speedKph': 10.25, 'wifi.connected': false, 'power.currentMa': null } };
  assert.equal((await info({ state }, 'bad')).status, 401);
  assert.equal((await info({ state })).status, 200);
  const expected = { ...state, reportedAtMs: f.now() };
  assert.deepEqual((await listed()).state, expected);
  const reopened = new Store(f.directory);
  assert.deepEqual(JSON.parse(reopened.deviceBySource(f.device.source_public_uid).device_state), state);
  reopened.close();
  f.advance(60000);
  gateway = await connect(f, (await session(f, f.gateway)).access_token);
  for (const body of [{ battery_voltage_mv: 3800 }, { state }, { state: { ...state, sequence: 1 } }]) {
    assert.equal((await info(body)).status, 200);
    assert.deepEqual((await listed()).state, expected, 'missing/duplicate/older snapshots never refresh evidence');
  }
  for (const invalid of [null, [], { ...state, schemaVersion: 2 }, { ...state, uptimeMs: -1 },
    { ...state, values: { nested: {} } }, { ...state, values: { secret: 'x'.repeat(129) } },
    { ...state, values: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key${i}`, i])) },
    { ...state, values: { constructor: true } }, { ...state, values: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, 'x'.repeat(120)])) }]) {
    assert.equal((await info({ state: invalid })).status, 400);
    assert.deepEqual((await listed()).state, expected, 'invalid input cannot replace or refresh previous evidence');
  }
  const next = { ...state, sequence: 3, values: { 'future.only': true } };
  await info({ state: next });
  assert.deepEqual((await listed()).state, { ...next, reportedAtMs: f.now() }, 'full snapshot removes disappeared keys');
  const reboot = { ...state, bootId: 'boot-b', sequence: 1, uptimeMs: 100, values: {} };
  await info({ state: reboot });
  assert.deepEqual((await listed()).state.values, {}, 'new boot resets sequence and values');
});
