import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { fixture, session, connect, packet, layout } from './helpers.js';

const secret = () => randomBytes(32).toString('base64url');
async function enroll(f, hardwareUid, enrollSecret) {
  const response = await fetch(`${f.baseUrl}/v1/device/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hardware_uid: hardwareUid, source_type: 'esp32', enroll_secret: enrollSecret }) });
  return { status: response.status, ...await response.json() };
}
let requestId = 0;
async function admin(gateway, op, args = {}) {
  const id = `r${++requestId}`;
  gateway.send({ type: 'admin.request', id, op, args });
  return gateway.take(m => m.type === 'admin.response' && m.id === id);
}
function sender(t, f) {
  const udp = dgram.createSocket('udp4'); t.after(() => udp.close());
  return data => new Promise((resolve, reject) => udp.send(data, f.udpPort, '127.0.0.1', e => e ? reject(e) : resolve()));
}
// Inside the fixture layout's coverage; circuit 2 is moved far away from it.
const ON_TRACK = { latitudeE7: 375000500, longitudeE7: 1273005000 };
const FAR = { schemaVersion: 1, layoutId: 'other', revision: 1,
  zones: [{ id: 'zone-1', kind: 'path', widthM: 14, points: [[355000000, 1293000000], [355001000, 1293010000]] }] };
async function publishLayout(f, peer, value) {
  peer.send({ type: 'layout.publish', schemaVersion: 1, circuitId: peer.hello.circuitId, epoch: peer.hello.epoch, sequence: 0, observedAtMs: f.now(), layout: value });
  await peer.take(m => m.type === 'layout.accepted');
}

test('a device enrolls with its own key, is idempotent, and another key cannot take over the hardware ID', async t => {
  const f = await fixture(t), key = secret();
  const first = await enroll(f, 'esp32:0123456789ab', key);
  assert.equal(first.status, 201); assert.equal(first.registration, 'pending'); assert.match(first.source_public_uid, /^G[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.deepEqual(await enroll(f, 'esp32:0123456789ab', key), first);
  assert.equal((await enroll(f, 'esp32:0123456789ab', secret())).status, 409);
  assert.equal((await enroll(f, f.device.hardware_uid, secret())).status, 409, 'USB-provisioned hardware keeps its server-issued key');
  assert.equal((await enroll(f, 'esp32:0123456789AB', key)).status, 400);
  assert.equal((await enroll(f, 'mobile:' + '0'.repeat(32), key)).status, 400);
  assert.equal((await enroll(f, 'esp32:0123456789ac', 'short')).status, 400);
  assert.notEqual(f.store.credential(first.credential_uid).secret, key, 'the device key is sealed at rest');
});

test('a pending device authenticates and reports position, but nothing reaches a circuit until it is approved', async t => {
  const f = await fixture(t), key = secret(), send = sender(t, f);
  const enrolled = await enroll(f, 'esp32:0123456789ab', key);
  const credential = { hardware_uid: 'esp32:0123456789ab', credential_uid: enrolled.credential_uid, source_secret: key };
  const device = await session(f, credential);
  assert.equal(device.status, 201); assert.equal(device.registration, 'pending'); assert.equal(device.circuit_id, 0); assert.equal(device.layout_hash, null);
  f.store.putCircuit(2, 'Other circuit', FAR);
  const gateway = await connect(f, (await session(f, f.gateway)).access_token);
  const other = await connect(f, (await session(f, f.store.provisionGateway(2, 'Other'))).access_token);
  await publishLayout(f, gateway, layout);
  for (let i = 1; i <= 4; i++) { await send(packet(device, f.now() * 1000, i, 7, ON_TRACK)); f.advance(200); }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(gateway.messages.filter(m => m.type === 'gps').length, 0);
  let list = (await admin(gateway, 'devices.list')).result;
  assert.deepEqual(list.pending.map(d => d.hardwareUid), ['esp32:0123456789ab']);
  assert.equal(list.pending[0].online, true); assert.equal(list.pending[0].position.latitude, 37.50005);
  assert.deepEqual(list.devices.map(d => d.sourceUid), [f.device.source_public_uid]);
  assert.equal(JSON.stringify(list).includes(key), false, 'listings never contain keys');
  assert.deepEqual((await admin(other, 'devices.list')).result.pending, [], 'another circuit does not see a device outside its coverage');
  assert.equal((await admin(other, 'devices.approve', { sourceUid: enrolled.source_public_uid })).ok, false);

  const approved = await admin(gateway, 'devices.approve', { sourceUid: enrolled.source_public_uid, label: 'Car 12 tracker', number: '12' });
  assert.equal(approved.ok, true); assert.equal(approved.result.status, 'active'); assert.equal(approved.result.owned, true); assert.equal(approved.result.number, '12');
  f.advance(1000);
  // The running session keeps working: no USB step and no re-authentication.
  for (let i = 5; i <= 8; i++) { await send(packet(device, f.now() * 1000, i, 7, ON_TRACK)); f.advance(200); }
  const gps = await gateway.take(m => m.type === 'gps');
  assert.equal(gps.sourcePublicUid, enrolled.source_public_uid); assert.equal(gps.circuitId, 1);
  list = (await admin(gateway, 'devices.list')).result;
  assert.deepEqual(list.pending, []); assert.equal(list.devices.find(d => d.sourceUid === enrolled.source_public_uid).label, 'Car 12 tracker');
});

test('ownership: the approving circuit renames and revokes; a visited circuit only assigns its own number', async t => {
  const f = await fixture(t), key = secret(), send = sender(t, f);
  f.store.putCircuit(2, 'Other circuit', FAR);
  const enrolled = await enroll(f, 'esp32:0123456789ab', key);
  const credential = { hardware_uid: 'esp32:0123456789ab', credential_uid: enrolled.credential_uid, source_secret: key };
  const owner = await connect(f, (await session(f, f.gateway)).access_token);
  const visited = await connect(f, (await session(f, f.store.provisionGateway(2, 'Other', true))).access_token);
  await publishLayout(f, visited, FAR);
  // No position yet: not listed anywhere, but the operator can claim it by the ID printed on the unit.
  assert.deepEqual((await admin(owner, 'devices.list')).result.pending, []);
  assert.equal((await admin(owner, 'devices.approve', { sourceUid: enrolled.source_public_uid })).ok, false);
  assert.equal((await admin(owner, 'devices.approve', { hardwareUid: '01:23:45:67:89:AB' })).ok, true);
  assert.equal((await admin(owner, 'devices.approve', { hardwareUid: '0123456789ab' })).ok, false, 'already approved');

  assert.deepEqual((await admin(visited, 'devices.list')).result.devices, []);
  assert.equal((await admin(visited, 'devices.update', { sourceUid: enrolled.source_public_uid, number: '5' })).ok, false, 'not visible to a circuit it never visited');
  const device = await session(f, credential);
  for (let i = 1; i <= 4; i++) { await send(packet(device, f.now() * 1000, i, 7, { latitudeE7: 355000500, longitudeE7: 1293005000 })); f.advance(200); }
  // It drove onto circuit 2's track: that circuit now sees it as a visitor.
  assert.equal((await visited.take(m => m.type === 'gps')).sourcePublicUid, enrolled.source_public_uid);
  const seenByVisited = (await admin(visited, 'devices.list')).result.devices;
  assert.equal(seenByVisited.length, 1); assert.equal(seenByVisited[0].owned, false); assert.equal(seenByVisited[0].onTrack, true); assert.equal(seenByVisited[0].number, null);
  assert.equal((await admin(visited, 'devices.update', { sourceUid: enrolled.source_public_uid, label: 'Mine now' })).error, 'only the owning circuit can rename this device');
  assert.equal((await admin(visited, 'devices.revoke', { sourceUid: enrolled.source_public_uid })).ok, false);
  assert.equal((await admin(visited, 'devices.update', { sourceUid: enrolled.source_public_uid, number: '9' })).result.number, '9');
  assert.equal((await admin(visited, 'devices.update', { sourceUid: enrolled.source_public_uid, number: null })).ok, true);

  assert.equal((await admin(owner, 'devices.update', { sourceUid: enrolled.source_public_uid, label: 'Renamed', number: '7' })).result.label, 'Renamed');
  assert.equal((await admin(owner, 'devices.update', { sourceUid: enrolled.source_public_uid, label: '' })).ok, false);
  assert.equal((await admin(owner, 'devices.revoke', { sourceUid: enrolled.source_public_uid })).ok, true);
  f.advance(1100);
  assert.equal((await session(f, credential)).status, 401);
  // A reset unit asks again under the same public ID and has to be approved again.
  const again = await enroll(f, 'esp32:0123456789ab', secret());
  assert.equal(again.status, 201); assert.equal(again.registration, 'pending'); assert.equal(again.source_public_uid, enrolled.source_public_uid);
  // An older SRC-... ID is retired the same way: revoke, reset, enroll.
  const legacy = f.store.provisionDevice({ hardwareUid: 'esp32:0123456789ff', importCredential: { hardware_uid: 'esp32:0123456789ff',
    credential_uid: 'cred_legacy', source_public_uid: 'SRC-PB3XFZ', source_secret: 'a'.repeat(43) } });
  f.store.setDeviceNumber(legacy.source_public_uid, 1, '7');
  f.store.revoke(legacy.credential_uid);
  const migrated = await enroll(f, 'esp32:0123456789ff', secret());
  assert.match(migrated.source_public_uid, /^G[0-9A-HJKMNP-TV-Z]{8}$/); assert.equal(f.store.deviceBySource('SRC-PB3XFZ'), undefined);
  assert.equal(f.store.deviceNumber('SRC-PB3XFZ', 1), null);
  assert.equal(f.store.deviceBySource(enrolled.source_public_uid).owner_circuit_id, null);
});

test('rejection is sticky, malformed admin requests close the stream, devices cannot use the admin channel', async t => {
  const f = await fixture(t), key = secret(), send = sender(t, f);
  const enrolled = await enroll(f, 'esp32:0123456789ab', key);
  const credential = { hardware_uid: 'esp32:0123456789ab', credential_uid: enrolled.credential_uid, source_secret: key };
  const device = await session(f, credential);
  await send(packet(device, f.now() * 1000, 1, 7, ON_TRACK)); f.advance(200);
  const gateway = await connect(f, (await session(f, f.gateway)).access_token);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await admin(gateway, 'devices.reject', { sourceUid: enrolled.source_public_uid })).ok, true);
  f.advance(1100);
  assert.equal((await enroll(f, 'esp32:0123456789ab', key)).status, 403);
  assert.equal((await session(f, credential)).status, 401);
  assert.deepEqual((await admin(gateway, 'devices.list')).result.pending, []);
  assert.equal((await admin(gateway, 'devices.nope')).error, 'unsupported operation');
  assert.equal((await admin(gateway, 'devices.update', { sourceUid: 'G00000000' })).error, 'unknown device');
  // An operator who has the unit in hand can still take it.
  assert.equal((await admin(gateway, 'devices.approve', { hardwareUid: 'esp32:0123456789ab' })).ok, true);

  const stream = await connect(f, (await session(f, f.device)).access_token);
  const closed = new Promise(resolve => stream.ws.once('close', resolve));
  stream.send({ type: 'admin.request', id: 'x', op: 'devices.list' });
  assert.equal(await closed, 1008);
  const closedGateway = new Promise(resolve => gateway.ws.once('close', resolve));
  gateway.send({ type: 'admin.request', id: 'bad id!', op: 'devices.list' });
  assert.equal(await closedGateway, 1008);
});

test('pending enrollments are bounded', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 256; i++) f.store.enrollDevice({ hardwareUid: `esp32:${i.toString(16).padStart(12, '0')}`, secret: secret() });
  assert.throws(() => f.store.enrollDevice({ hardwareUid: 'esp32:ffffffffffff', secret: secret() }), /capacity/);
  assert.equal((await enroll(f, 'esp32:fffffffffffe', secret())).status, 503);
});

test('a device reports its modem and SIM for operators; a pending unit can be claimed by the printed IMEI', async t => {
  const f = await fixture(t), key = secret();
  const enrolled = await enroll(f, 'esp32:0123456789ab', key);
  const credential = { hardware_uid: 'esp32:0123456789ab', credential_uid: enrolled.credential_uid, source_secret: key };
  const device = await session(f, credential);
  const info = (body, token = device.access_token) => fetch(`${f.baseUrl}/v1/device/info`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await info({ modem_imei: '863235087085013' }, null)).status, 401);
  const gatewaySession = await session(f, f.gateway);
  assert.equal((await info({ modem_imei: '863235087085013' }, gatewaySession.access_token)).status, 401, 'only devices describe themselves');
  assert.equal((await info({ modem_imei: '86323508708501x' })).status, 400);
  assert.equal((await info({ sim_phone_tail: '01020583047' })).status, 400, 'phone_tail stays four digits; full numbers use sim_phone_number');
  assert.equal((await info({ sim_phone_number: 1020583047 })).status, 400);
  assert.equal((await info({ sim_phone_number: '01020583047', sim_phone_tail: '9999' })).status, 400);
  assert.equal((await info({ sim_phone_number: '1234567890123456' })).status, 400);
  assert.equal((await info({ modem_imei: '863235087085013', sim_iccid: '8982052504122918948', sim_phone_tail: '3047' })).status, 200);
  assert.equal(f.store.deviceByHardware('esp32:0123456789ab').phone_number, null, 'legacy tail-only reports remain valid');
  assert.equal((await info({ modem_imei: '863235087085013', sim_iccid: '8982052504122918948', sim_phone_number: '01020583047' })).status, 200);
  const gateway = await connect(f, gatewaySession.access_token);
  assert.equal((await admin(gateway, 'devices.approve', { imei: '863235087085099' })).error, 'no pending device with this IMEI');
  const approved = await admin(gateway, 'devices.approve', { imei: '863235087085013', label: 'Car 3' });
  assert.equal(approved.ok, true);
  assert.deepEqual([approved.result.imei, approved.result.iccid, approved.result.phoneTail, approved.result.phoneNumber, approved.result.sourceUid],
    ['863235087085013', '8982052504122918948', '3047', '01020583047', enrolled.source_public_uid]);
  assert.equal((await admin(gateway, 'devices.approve', { imei: '863235087085013' })).ok, false, 'already approved');
  assert.equal((await info({ modem_imei: '863235087085013', sim_iccid: '8982052504122918948', sim_phone_number: '+821020583047' })).status, 200);
  const international = (await admin(gateway, 'devices.list')).result.devices.find(d => d.sourceUid === enrolled.source_public_uid);
  assert.deepEqual([international.phoneNumber, international.phoneTail], ['+821020583047', '3047']);
  // A SIM swap replaces what was reported; an absent value clears it.
  assert.equal((await info({ modem_imei: '863235087085013', sim_iccid: '8982000000000000001' })).status, 200);
  const listed = (await admin(gateway, 'devices.list')).result.devices.find(d => d.sourceUid === enrolled.source_public_uid);
  assert.deepEqual([listed.iccid, listed.phoneTail, listed.phoneNumber], ['8982000000000000001', null, null]);
  // Two pending units claiming one IMEI cannot be told apart by it.
  for (const mac of ['0123456789ac', '0123456789ad']) {
    const other = secret(), e = await enroll(f, `esp32:${mac}`, other);
    const s = await session(f, { hardware_uid: `esp32:${mac}`, credential_uid: e.credential_uid, source_secret: other });
    assert.equal((await info({ modem_imei: '490154203237518' }, s.access_token)).status, 200);
  }
  assert.equal((await admin(gateway, 'devices.approve', { imei: '490154203237518' })).error, 'several pending devices report this IMEI');
});
