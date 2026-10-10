import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FirmwareStore, parseImage, validateImage } from '../src/firmware.js';
import { fixture, session } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));

/** An ESP-IDF app image header and descriptor in front of filler bytes. */
export function image({ chipId = 0x0000, version = '0.2.0', project = 'racematrix-gps-device', magic = 0xe9, size = 200 * 1024 } = {}) {
  const b = Buffer.alloc(size, 0x5a);
  b[0] = magic; b[1] = 3; b.writeUInt16LE(chipId, 12);
  b.fill(0, 0x20, 0x20 + 256);
  b.writeUInt32LE(0xabcd5432, 0x20);
  b.write(version, 0x20 + 16); b.write(project, 0x20 + 48); b.write('08:53:15', 0x20 + 80); b.write('Oct  4 2026', 0x20 + 96); b.write('5.5.0', 0x20 + 112);
  return b;
}
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

test('an image is served only when its own header and descriptor match the target and version', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rm-relay-firmware-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const parsed = parseImage(image());
  assert.deepEqual([parsed.chipId, parsed.version, parsed.projectName, parsed.idfVersion, `${parsed.date} ${parsed.time}`], [0, '0.2.0', 'racematrix-gps-device', '5.5.0', 'Oct  4 2026 08:53:15']);
  const refused = (buffer, target, version, message) => assert.throws(() => validateImage(buffer, target, version), error => error.status === 400 && error.message.includes(message), message);
  refused(image({ magic: 0xe8 }), 'esp32', '0.2.0', 'not an ESP-IDF image');
  refused(image({ size: 512 }), 'esp32', '0.2.0', 'too small');
  refused(image({ chipId: 0x0009 }), 'esp32', '0.2.0', 'is not esp32');
  refused(image(), 'esp32s3', '0.2.0', 'is not esp32s3');
  refused(image({ version: '0.2.1' }), 'esp32', '0.2.0', 'is not 0.2.0');
  refused(image({ project: 'other-project' }), 'esp32', '0.2.0', 'is not racematrix-gps-device');
  refused(image(), 'esp8266', '0.2.0', 'unknown firmware target');
  refused(image(), 'esp32', 'v0.2.0', 'invalid firmware version');
  const descriptorless = image(); descriptorless.writeUInt32LE(0, 0x20);
  refused(descriptorless, 'esp32', '0.2.0', 'app descriptor missing');

  const store = new FirmwareStore(directory);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('esp32', '0.2.0'), null);
  const bin = image(), meta = store.put('esp32', '0.2.0', bin, { now: 1700000000000 });
  assert.deepEqual(meta, { target: 'esp32', version: '0.2.0', size: bin.length, sha256: sha256(bin), projectName: 'racematrix-gps-device',
    builtAt: 'Oct  4 2026 08:53:15', idfVersion: '5.5.0', chipId: 0, putAtMs: 1700000000000 });
  assert.throws(() => store.put('esp32', '0.2.0', bin), error => error.status === 409);
  const s3 = image({ chipId: 0x0009, version: '0.2.0' });
  store.put('esp32s3', '0.2.0', s3, { now: 1700000001000 });
  store.put('esp32', '0.2.0', image(), { replace: true, now: 1700000002000 });
  assert.deepEqual(store.list().map(m => [m.target, m.version, m.putAtMs]), [['esp32', '0.2.0', 1700000002000], ['esp32s3', '0.2.0', 1700000001000]]);
  assert.equal(store.get('esp32', '0.2.0').path, path.join(directory, 'firmware', 'esp32', '0.2.0.bin'));
  assert.equal(store.get('esp32', '9.9.9'), null);
  assert.equal(store.get('esp32', '../0.2.0'), null);
  // A sidecar that disagrees with the file on disk is not served.
  writeFileSync(path.join(directory, 'firmware', 'esp32s3', '0.2.0.bin'), Buffer.alloc(10));
  assert.equal(store.get('esp32s3', '0.2.0'), null);
  assert.equal(store.list().length, 1);
  assert.equal(store.remove('esp32s3', '0.2.0'), true);
  assert.equal(store.remove('esp32s3', '0.2.0'), false);
  assert.equal(existsSync(path.join(directory, 'firmware', 'esp32s3', '0.2.0.json')), false);
  assert.equal(store.remove('esp32', '0.2.0'), true);
  assert.deepEqual(store.list(), []);
});

test('authenticated devices and gateways download images whole or by byte range', async t => {
  const f = await fixture(t);
  const bin = image();
  f.relay.firmware.put('esp32', '0.2.0', bin);
  const deviceSession = await session(f, f.device), gatewaySession = await session(f, f.gateway);
  const url = `${f.baseUrl}/v1/firmware/esp32/0.2.0.bin`;
  const get = (headers = {}, method = 'GET', token = deviceSession.access_token) =>
    fetch(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

  let response = await get({}, 'GET', null);
  assert.deepEqual([response.status, (await response.json()).error], [401, 'unauthorized']);
  response = await get({}, 'GET', 'x'.repeat(43));
  assert.equal(response.status, 401);
  response = await fetch(`${f.baseUrl}/v1/firmware/esp32/0.3.0.bin`, { headers: { authorization: `Bearer ${deviceSession.access_token}` } });
  assert.deepEqual([response.status, (await response.json()).error], [404, 'unknown firmware']);
  response = await fetch(`${f.baseUrl}/v1/firmware/esp32s3/0.2.0.bin`, { headers: { authorization: `Bearer ${deviceSession.access_token}` } });
  assert.equal(response.status, 404, 'the other CPU has its own image');
  response = await fetch(`${f.baseUrl}/v1/firmware/esp32/0.2.0`, { headers: { authorization: `Bearer ${deviceSession.access_token}` } });
  assert.equal(response.status, 404);
  response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${deviceSession.access_token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 404);

  response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), String(bin.length));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('etag'), `"${sha256(bin)}"`);
  assert.equal(response.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bin));

  response = await get({ 'if-none-match': `"${sha256(bin)}"` });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get('etag'), `"${sha256(bin)}"`);

  response = await get({ range: 'bytes=0-65535' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-65535/${bin.length}`);
  assert.equal(response.headers.get('content-length'), '65536');
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bin.subarray(0, 65536)));

  response = await get({ range: 'bytes=65536-' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 65536-${bin.length - 1}/${bin.length}`);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bin.subarray(65536)));

  response = await get({ range: `bytes=${bin.length - 100}-${bin.length + 5000}` });
  assert.equal(response.status, 206, 'an end past the file is clamped');
  assert.equal(response.headers.get('content-range'), `bytes ${bin.length - 100}-${bin.length - 1}/${bin.length}`);
  response = await get({ range: 'bytes=-100' });
  assert.equal(response.status, 206);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(bin.subarray(-100)));

  for (const range of [`bytes=${bin.length}-`, 'bytes=999999999-', 'bytes=10-5', 'bytes=-0']) {
    response = await get({ range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${bin.length}`);
  }
  response = await get({ range: 'bytes=0-9,20-29' });
  assert.equal(response.status, 200, 'several ranges are answered with the whole image');
  assert.equal(response.headers.get('content-length'), String(bin.length));

  response = await get({}, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(bin.length));
  assert.equal(response.headers.get('etag'), `"${sha256(bin)}"`);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  response = await get({ range: 'bytes=0-1023' }, 'HEAD');
  assert.deepEqual([response.status, response.headers.get('content-range')], [206, `bytes 0-1023/${bin.length}`]);

  response = await get({}, 'GET', gatewaySession.access_token);
  assert.equal(response.status, 200, 'a gateway may fetch images too');

  // A download renews the device session as a position sample would: the
  // bearer of a multi-minute transfer must not lapse while no fix is sent.
  const live = f.relay.sessions.get(deviceSession.session_id);
  f.advance(240_000);
  response = await get({ range: 'bytes=0-1023' });
  assert.equal(response.status, 206);
  assert.equal(live.controlExpires, f.now() + 300_000, 'a device download renews the control token');
  assert.equal(live.expires, f.now() + 900_000, 'and the UDP session');
  f.advance(240_000);
  response = await get({ range: 'bytes=1024-2047' });
  assert.equal(response.status, 206, 'the token outlives its original five minutes');
  const extended = live.controlExpires;
  f.advance(1_000);
  response = await fetch(`${f.baseUrl}/v1/firmware/esp32/0.3.0.bin`, { headers: { authorization: `Bearer ${deviceSession.access_token}` } });
  assert.equal(response.status, 404);
  assert.equal(live.controlExpires, extended, 'an unknown image is not activity');

  // Revoking the device ends its access on the next request.
  f.store.revoke(f.device.credential_uid); f.relay.credentialCache.delete(f.device.credential_uid);
  response = await get();
  assert.equal(response.status, 401);

  f.relay.firmware.remove('esp32', '0.2.0');
  // The gateway token from the start has aged out meanwhile (no session to renew): a fresh one.
  response = await get({}, 'GET', (await session(f, f.gateway)).access_token);
  assert.equal(response.status, 404, 'a removed image is gone at once');
});

test('operator CLI puts, lists and removes images in the same data directory as the service', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rm-relay-firmware-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (...args) => execFileSync(process.execPath, ['bin/relay.js', ...args, '--data-dir', `${directory}/data`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const file = path.join(directory, 'firmware.bin');
  writeFileSync(file, image({ chipId: 0x0009, version: '0.2.0' }));
  assert.throws(() => run('firmware-put', '--target', 'esp32', '--version', '0.2.0', '--file', file), /is not esp32/);
  assert.throws(() => run('firmware-put', '--target', 'esp32s3', '--version', '0.2.1', '--file', file), /is not 0\.2\.1/);
  assert.throws(() => run('firmware-put', '--target', 'esp32s3', '--version', '0.2.0'), /--file is required/);
  const put = JSON.parse(run('firmware-put', '--target', 'esp32s3', '--version', '0.2.0', '--file', file));
  assert.deepEqual([put.target, put.version, put.chipId, put.size], ['esp32s3', '0.2.0', 9, 200 * 1024]);
  assert.ok(existsSync(`${directory}/data/firmware/esp32s3/0.2.0.bin`));
  assert.throws(() => run('firmware-put', '--target', 'esp32s3', '--version', '0.2.0', '--file', file), /firmware version exists/);
  run('firmware-put', '--target', 'esp32s3', '--version', '0.2.0', '--file', file, '--replace');
  assert.deepEqual(JSON.parse(run('firmware-list')).map(m => `${m.target}/${m.version}`), ['esp32s3/0.2.0']);
  const store = new FirmwareStore(`${directory}/data`);
  assert.equal(store.get('esp32s3', '0.2.0').sha256, put.sha256);
  run('firmware-remove', '--target', 'esp32s3', '--version', '0.2.0');
  assert.throws(() => run('firmware-remove', '--target', 'esp32s3', '--version', '0.2.0'), /unknown firmware/);
  assert.deepEqual(JSON.parse(run('firmware-list')), []);
});
