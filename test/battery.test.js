import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { fixture, session, connect, packet } from './helpers.js';

test('battery reports are authenticated, range checked, persistent and visible without GPS', async t => {
  const f = await fixture(t);
  const device = await session(f, f.device);
  const gatewaySession = await session(f, f.gateway);
  let gateway = await connect(f, gatewaySession.access_token);
  const info = (body, token = device.access_token) => fetch(`${f.baseUrl}/v1/device/info`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) });
  let id = 0;
  const listed = async () => {
    const requestId = `battery${++id}`;
    gateway.send({ type: 'admin.request', id: requestId, op: 'devices.list' });
    return (await gateway.take(m => m.id === requestId)).result.devices.find(d => d.sourceUid === f.device.source_public_uid);
  };
  assert.equal((await listed()).battery, null, 'an old device has never reported a battery');
  assert.equal((await info({ battery_voltage_mv: 3800 }, null)).status, 401);
  assert.equal((await info({ battery_voltage_mv: 3800 }, gatewaySession.access_token)).status, 401);
  assert.equal((await info({ modem_imei: '863235087085013', battery_voltage_mv: 3800 })).status, 200);
  const expected = { voltageMv: 3800, reportedAtMs: f.now() };
  assert.deepEqual((await listed()).battery, expected);
  assert.equal((await listed()).position, null, 'battery reporting does not invent a GPS fix');
  assert.equal((await listed()).online, true);
  const reopened = new Store(f.directory);
  assert.equal(reopened.deviceBySource(f.device.source_public_uid).battery_voltage_mv, 3800);
  reopened.close();
  for (const battery_voltage_mv of [0, 1999, 6001, 3800.5, '3800', {}, true]) {
    assert.equal((await info({ battery_voltage_mv })).status, 400);
    assert.deepEqual((await listed()).battery, expected, 'invalid reports cannot replace a previous reading');
  }
  f.advance(60_000);
  gateway = await connect(f, gatewaySession.access_token);
  assert.equal((await info({ modem_imei: '863235087085013' })).status, 200);
  assert.deepEqual((await listed()).battery, expected, 'older firmware does not erase or refresh battery evidence');
  assert.equal((await info({ battery_voltage_mv: null })).status, 200);
  assert.deepEqual((await listed()).battery, { voltageMv: null, reportedAtMs: f.now() }, 'failed measurement clears the previous voltage');
  for (const voltageMv of [2000, 6000]) {
    f.advance(60_000);
    gateway = await connect(f, gatewaySession.access_token);
    assert.equal((await info({ battery_voltage_mv: voltageMv })).status, 200);
    assert.deepEqual((await listed()).battery, { voltageMv, reportedAtMs: f.now() });
  }
});

test('a parked device stays online without UDP until its report is 25 minutes old', async t => {
  const f = await fixture(t);
  const device = await session(f, f.device);
  // Gateway tokens last 5 minutes; the operator side reconnects as Ops does.
  const operator = async () => connect(f, (await session(f, f.gateway)).access_token);
  let gateway = await operator();
  const info = body => fetch(`${f.baseUrl}/v1/device/info`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device.access_token}` },
    body: JSON.stringify(body) });
  let id = 0;
  const listed = async () => {
    const requestId = `parked${++id}`;
    gateway.send({ type: 'admin.request', id: requestId, op: 'devices.list' });
    return (await gateway.take(m => m.id === requestId)).result.devices.find(d => d.sourceUid === f.device.source_public_uid);
  };
  for (const parked of ['true', 1, null]) assert.equal((await info({ battery_voltage_mv: 3800, parked })).status, 400);
  assert.equal((await info({ battery_voltage_mv: 3800 })).status, 200);
  assert.equal((await listed()).parked, false, 'older firmware never parks');
  assert.equal((await info({ battery_voltage_mv: 3800, parked: true })).status, 200);
  f.advance(1_499_000);
  gateway = await operator();
  assert.deepEqual([(await listed()).parked, (await listed()).online], [true, true]);
  f.advance(2_000);
  gateway = await operator();
  assert.deepEqual([(await listed()).parked, (await listed()).online], [false, false], 'a missed parked report means offline');
});


test('timed sleep liveness is bounded by the confirmed wake time and clears on fresh GPS', async t => {
  const f = await fixture(t);
  let device = await session(f, f.device);
  let gateway = await connect(f, (await session(f, f.gateway)).access_token);
  const info = body => fetch(`${f.baseUrl}/v1/device/info`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device.access_token}` }, body: JSON.stringify(body) });
  let id = 0;
  const listed = async () => {
    const requestId = `sleep${++id}`;
    gateway.send({ type: 'admin.request', id: requestId, op: 'devices.list' });
    return (await gateway.take(m => m.id === requestId)).result.devices.find(d => d.sourceUid === f.device.source_public_uid);
  };
  const until = Math.floor(f.now() / 1000) + 3600;
  for (const sleep_until of [-1, '123', null, 1.5, until + 61]) assert.equal((await info({ parked: true, sleep_until })).status, 400);
  assert.equal((await info({ sleep_until: until })).status, 400, 'sleep must also report parked');
  assert.equal((await info({ external_power: 'battery' })).status, 400, 'unknown is not proof of battery power');
  assert.equal((await info({ parked: true, sleep_until: until, external_power: 'unknown' })).status, 200);
  f.advance(30 * 60_000);
  gateway = await connect(f, (await session(f, f.gateway)).access_token);
  assert.deepEqual([(await listed()).online, (await listed()).sleepUntilMs], [true, until * 1000]);
  f.advance(32 * 60_000 + 1000);
  gateway = await connect(f, (await session(f, f.gateway)).access_token);
  assert.deepEqual([(await listed()).online, (await listed()).sleepUntilMs], [false, null], 'missed wake cannot remain online indefinitely');
  device = await session(f, f.device);
  await info({ parked: true, sleep_until: Math.floor(f.now() / 1000) + 600 });
  f.relay.receiveGps(packet(device, f.now() * 1000, 1));
  assert.deepEqual([(await listed()).parked, (await listed()).sleepUntilMs], [false, null]);
  await info({ parked: false, sleep_until: 0, external_power: 'usb-host' });
  assert.equal((await listed()).externalPower, 'usb-host');
});
