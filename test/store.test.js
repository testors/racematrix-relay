import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';
import { layout } from './helpers.js';

function registry(t) {
  const directory = mkdtempSync(join(tmpdir(), 'rm-relay-identity-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.putCircuit(1, 'First circuit', layout);
  store.putCircuit(2, 'Second circuit', { ...layout, layoutId: 'other' });
  return { store, directory };
}

function imported(sourceUid) {
  return { hardware_uid: 'esp32:aabbccddeeff', credential_uid: 'cred_imported',
    source_public_uid: sourceUid, source_secret: 'a'.repeat(43) };
}

test('short IDs retry collisions across circuits, including revoked devices', t => {
  const { store } = registry(t), existing = imported('SRC-000000');
  store.provisionDevice({ hardwareUid: existing.hardware_uid, circuitId: 1, importCredential: existing });
  store.revoke(existing.credential_uid);
  let attempts = 0;
  t.mock.method(store, 'allocateSourceUid', () => Store.prototype.allocateSourceUid.call(store,
    size => Buffer.alloc(size, attempts++ === 0 ? 0 : 1)));
  const device = store.provisionDevice({ hardwareUid: 'esp32:111111111111', circuitId: 2 });
  assert.equal(attempts, 2);
  assert.equal(device.source_public_uid, 'SRC-111111');
  assert.equal(store.credential(existing.credential_uid).source_uid, existing.source_public_uid);
  assert.equal(store.credential(existing.credential_uid).revoked, 1);
  assert.equal(store.credential(device.credential_uid).hardware_uid, device.hardware_uid);
});

test('exhausted ID collisions leave no partial device and release the transaction', t => {
  const { store } = registry(t), existing = imported('SRC-000000');
  store.provisionDevice({ hardwareUid: existing.hardware_uid, circuitId: 1, importCredential: existing });
  let attempts = 0;
  const mock = t.mock.method(store, 'allocateSourceUid', () => Store.prototype.allocateSourceUid.call(store,
    size => { attempts++; return Buffer.alloc(size); }));
  const options = { hardwareUid: 'esp32:111111111111', circuitId: 1 };
  assert.throws(() => store.provisionDevice(options), /could not allocate a unique device ID/);
  assert.equal(attempts, 32);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM credentials').get().n, 1);
  mock.mock.restore();
  assert.match(store.provisionDevice(options).source_public_uid, /^SRC-[0-9A-HJKMNP-TV-Z]{6}$/);
});

test('legacy long IDs survive import, reopening, reprovisioning and key rotation', t => {
  const { store, directory } = registry(t), existing = imported('SRC-0123456789ABCDEF0123');
  const options = { hardwareUid: existing.hardware_uid, circuitId: 1 };
  const first = store.provisionDevice({ ...options, importCredential: existing });
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.provisionDevice(options), first);
    const rotated = reopened.provisionDevice({ ...options, rotate: true });
    assert.equal(rotated.source_public_uid, existing.source_public_uid);
    assert.equal(rotated.credential_uid, existing.credential_uid);
    assert.notEqual(rotated.source_secret, existing.source_secret);
  } finally { reopened.close(); }
});

test('fixed-only registry migration preserves credentials and enables roaming and scoped numbers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'rm-relay-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(directory);
  store.putCircuit(1, 'Existing circuit', layout);
  const device = store.provisionDevice({ hardwareUid: 'esp32:aabbccddeeff', circuitId: 1, number: '7' });
  const gateway = store.provisionGateway(1, 'Existing publisher', true);
  store.close();
  const old = new DatabaseSync(join(directory, 'relay.sqlite'));
  old.exec(`DROP TABLE device_numbers;
    ALTER TABLE credentials RENAME TO saved;
    CREATE TABLE credentials(uid TEXT PRIMARY KEY, role TEXT NOT NULL, secret TEXT NOT NULL,
      circuit_id INTEGER NOT NULL REFERENCES circuits(id), hardware_uid TEXT UNIQUE, source_uid TEXT UNIQUE,
      number TEXT, label TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0);
    INSERT INTO credentials SELECT * FROM saved; DROP TABLE saved; PRAGMA user_version=1;`);
  old.close();
  store = new Store(directory);
  try {
    assert.deepEqual(store.provisionDevice({ hardwareUid: device.hardware_uid, circuitId: 1 }), device);
    assert.equal(store.circuit(1).publisher_uid, gateway.credential_uid);
    assert.equal(store.unseal(store.credential(gateway.credential_uid).secret), gateway.credential_secret);
    const roaming = store.provisionDevice({ hardwareUid: 'esp32:111111111111' });
    assert.equal(roaming.circuit_id, null);
    assert.deepEqual(store.provisionDevice({ hardwareUid: roaming.hardware_uid }), roaming);
    assert.throws(() => store.provisionDevice({ hardwareUid: 'esp32:222222222222', number: '7' }), /per circuit/);
    store.setDeviceNumber(roaming.source_public_uid, 1, '42');
    assert.equal(store.deviceNumber(roaming.source_public_uid, 1), '42');
    store.setDeviceNumber(roaming.source_public_uid, 1, null);
    assert.equal(store.deviceNumber(roaming.source_public_uid, 1), null);
    store.bindDevice(device.source_public_uid, null, null);
    assert.equal(store.credential(device.credential_uid).circuit_id, null);
    assert.equal(store.unseal(store.credential(device.credential_uid).secret), device.source_secret);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { store.close(); }
});
