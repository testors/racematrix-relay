import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { normalizeLayout } from './layout.js';

const SOURCE_UID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = path.join(directory, 'master.key');
    if (!existsSync(keyPath)) {
      if (existsSync(path.join(directory, 'relay.sqlite'))) throw new Error('master.key missing for an existing database');
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('master.key must contain 32 bytes');
    this.db = new DatabaseSync(path.join(directory, 'relay.sqlite'), { timeout: 3000 });
    chmodSync(path.join(directory, 'relay.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS circuits(id INTEGER PRIMARY KEY, name TEXT NOT NULL, layout_hash TEXT NOT NULL, publisher_uid TEXT);
      CREATE TABLE IF NOT EXISTS layouts(hash TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(uid TEXT PRIMARY KEY, role TEXT NOT NULL, secret TEXT NOT NULL,
        circuit_id INTEGER REFERENCES circuits(id), hardware_uid TEXT UNIQUE, source_uid TEXT UNIQUE,
        number TEXT, label TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0);
      `);
    // A NULL circuit is a roaming device. Migrate old fixed-only registries
    // without changing IDs, secrets, generations or circuit assignments.
    this.transaction(() => {
      if (this.db.prepare('PRAGMA table_info(credentials)').all().find(c => c.name === 'circuit_id').notnull) this.db.exec(`
        ALTER TABLE credentials RENAME TO credentials_v1;
        CREATE TABLE credentials(uid TEXT PRIMARY KEY, role TEXT NOT NULL, secret TEXT NOT NULL,
          circuit_id INTEGER REFERENCES circuits(id), hardware_uid TEXT UNIQUE, source_uid TEXT UNIQUE,
          number TEXT, label TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, revoked INTEGER NOT NULL DEFAULT 0);
        INSERT INTO credentials SELECT * FROM credentials_v1;
        DROP TABLE credentials_v1;`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS device_numbers(
        source_uid TEXT NOT NULL REFERENCES credentials(source_uid), circuit_id INTEGER NOT NULL REFERENCES circuits(id),
        number TEXT NOT NULL, PRIMARY KEY(source_uid,circuit_id)); PRAGMA user_version=2;`);
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS mobile_invites(code_hash TEXT PRIMARY KEY,
      credential_uid TEXT NOT NULL REFERENCES credentials(uid), expires_ms INTEGER NOT NULL,
      udp_port INTEGER NOT NULL, claim_hash TEXT, credential_generation INTEGER NOT NULL DEFAULT 1);`);
    if (!this.db.prepare('PRAGMA table_info(mobile_invites)').all().some(c => c.name === 'credential_generation')) {
      this.db.exec('ALTER TABLE mobile_invites ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 1');
    }
  }
  seal(secret) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  unseal(value) {
    const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  circuit(id) { return this.db.prepare('SELECT * FROM circuits WHERE id=?').get(id); }
  layout(hash) { return this.db.prepare('SELECT json FROM layouts WHERE hash=?').get(hash)?.json; }
  credential(uid) { return this.db.prepare('SELECT * FROM credentials WHERE uid=?').get(uid); }
  createCircuit(id, name) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff || typeof name !== 'string' || !name || name.length > 100) throw new Error('invalid circuit');
    this.db.prepare("INSERT INTO circuits(id,name,layout_hash) VALUES(?,?,'') ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(id, name);
  }
  deviceNumber(sourceUid, circuitId) {
    return this.db.prepare('SELECT number FROM device_numbers WHERE source_uid=? AND circuit_id=?').get(sourceUid, circuitId)?.number ?? null;
  }
  setDeviceNumber(sourceUid, circuitId, number) {
    if (!this.circuit(circuitId) || !this.db.prepare("SELECT 1 FROM credentials WHERE role='device' AND source_uid=?").get(sourceUid) ||
        (number !== null && !/^[A-Za-z0-9-]{1,16}$/.test(number))) throw new Error('invalid device number assignment');
    if (number === null) this.db.prepare('DELETE FROM device_numbers WHERE source_uid=? AND circuit_id=?').run(sourceUid, circuitId);
    else this.db.prepare('INSERT INTO device_numbers(source_uid,circuit_id,number) VALUES(?,?,?) ON CONFLICT(source_uid,circuit_id) DO UPDATE SET number=excluded.number').run(sourceUid, circuitId, number);
  }
  putCircuit(id, name, document) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff || typeof name !== 'string' || !name || name.length > 100) throw new Error('invalid circuit');
    const { json, hash } = normalizeLayout(document);
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO layouts(hash,json) VALUES(?,?)').run(hash, json);
      this.db.prepare('INSERT INTO circuits(id,name,layout_hash) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,layout_hash=excluded.layout_hash').run(id, name, hash);
    });
    return hash;
  }
  allocateSourceUid(random = randomBytes) {
    // provisionDevice holds BEGIN IMMEDIATE through the insert, serializing writers.
    const taken = this.db.prepare('SELECT 1 FROM credentials WHERE source_uid=?');
    for (let attempt = 0; attempt < 32; attempt++) {
      // Six unbiased Base32 characters; omit I/L/O/U for printed device labels.
      const suffix = Array.from(random(6), byte => SOURCE_UID_ALPHABET[byte & 31]).join('');
      const source = `SRC-${suffix}`;
      if (!taken.get(source)) return source;
    }
    throw new Error('could not allocate a unique device ID');
  }
  provisionDevice({ hardwareUid, circuitId = null, number = null, label = 'GPS', rotate = false, importCredential = null }) {
    if (!/^(esp32:[a-f0-9]{12}|mobile:[a-f0-9]{32})$/.test(hardwareUid) || (circuitId !== null && !this.circuit(circuitId))) throw new Error('invalid hardware UID or circuit');
    if (circuitId === null && number !== null) throw new Error('roaming device numbers must be assigned per circuit with device-number');
    if (number !== null && !/^[A-Za-z0-9-]{1,16}$/.test(number)) throw new Error('invalid vehicle number');
    if (typeof label !== 'string' || label.length > 80) throw new Error('invalid label');
    return this.transaction(() => {
      let row = this.db.prepare('SELECT * FROM credentials WHERE hardware_uid=?').get(hardwareUid);
      if (row && row.circuit_id !== circuitId) throw new Error('device belongs to another circuit; use device-bind explicitly');
      if (row && importCredential && (row.uid !== importCredential.credential_uid || row.source_uid !== importCredential.source_public_uid ||
          this.unseal(row.secret) !== importCredential.source_secret)) throw new Error('existing device does not match imported credential');
      if (row?.revoked && !rotate) throw new Error('revoked credential; explicit --rotate is required');
      if (!row) {
        if (importCredential && (importCredential.hardware_uid !== hardwareUid || !/^[A-Za-z0-9_-]{1,79}$/.test(importCredential.credential_uid) ||
            !/^SRC[-_][A-Za-z0-9_-]{1,35}$/.test(importCredential.source_public_uid) || !/^[A-Za-z0-9_-]{32,127}$/.test(importCredential.source_secret))) throw new Error('invalid Circuit credential import');
        const uid = importCredential?.credential_uid ?? `cred_${randomBytes(12).toString('hex')}`;
        const source = importCredential?.source_public_uid ?? this.allocateSourceUid();
        const secret = importCredential?.source_secret ?? randomBytes(32).toString('base64url');
        this.db.prepare('INSERT INTO credentials(uid,role,secret,circuit_id,hardware_uid,source_uid,number,label) VALUES(?,?,?,?,?,?,?,?)')
          .run(uid, 'device', this.seal(secret), circuitId, hardwareUid, source, number, label);
        row = this.credential(uid);
      } else if (rotate) {
        this.db.prepare('UPDATE credentials SET secret=?,generation=generation+1,revoked=0 WHERE uid=?').run(this.seal(randomBytes(32).toString('base64url')), row.uid);
        row = this.credential(row.uid);
      }
      return { hardware_uid: row.hardware_uid, source_public_uid: row.source_uid,
        credential_uid: row.uid, source_secret: this.unseal(row.secret), circuit_id: row.circuit_id };
    });
  }
  inviteMobile({ baseUrl, udpPort = 8677, circuitId = null, label = 'Phone', ttlMinutes = 30, now = Date.now() }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !Number.isInteger(udpPort) || udpPort < 1 || udpPort > 65535 ||
        !Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new Error('invalid mobile invitation settings');
    const credential = this.provisionDevice({ hardwareUid: `mobile:${randomBytes(16).toString('hex')}`, circuitId, label });
    const code = randomBytes(24).toString('base64url'), expires = now + ttlMinutes * 60000;
    this.db.prepare('DELETE FROM mobile_invites WHERE expires_ms<=?').run(now);
    this.db.prepare('INSERT INTO mobile_invites(code_hash,credential_uid,expires_ms,udp_port) VALUES(?,?,?,?)')
      .run(createHash('sha256').update(code).digest('hex'), credential.credential_uid, expires, udpPort);
    // Operator transfers this short-lived invitation, never the long-term key.
    return { relay_url: url.origin, activation_code: code, expires_at: new Date(expires).toISOString(),
      source_public_uid: credential.source_public_uid, credential_uid: credential.credential_uid };
  }
  redeemMobile(code, claimNonce, now = Date.now()) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code) ||
        typeof claimNonce !== 'string' || !/^[a-f0-9]{64}$/.test(claimNonce)) throw new Error('invalid invitation');
    const hash = createHash('sha256').update(code).digest('hex');
    const claimHash = createHash('sha256').update(claimNonce).digest('hex');
    return this.transaction(() => {
      const invite = this.db.prepare('SELECT * FROM mobile_invites WHERE code_hash=?').get(hash);
      const row = invite && this.credential(invite.credential_uid);
      if (!invite || invite.expires_ms <= now || (invite.claim_hash && invite.claim_hash !== claimHash) ||
          !row || row.revoked || row.generation !== invite.credential_generation || row.role !== 'device' ||
          !row.hardware_uid.startsWith('mobile:')) throw new Error('invalid invitation');
      this.db.prepare('UPDATE mobile_invites SET claim_hash=? WHERE code_hash=?').run(claimHash, hash);
      // Same installation may retry after a dropped HTTPS response until expiry.
      return { hardware_uid: row.hardware_uid, source_public_uid: row.source_uid, credential_uid: row.uid,
        source_secret: this.unseal(row.secret), circuit_id: row.circuit_id, udp_port: invite.udp_port };
    });
  }
  provisionGateway(circuitId, label, publish = false) {
    if (!this.circuit(circuitId) || typeof label !== 'string' || !label || label.length > 80) throw new Error('invalid gateway');
    return this.transaction(() => {
      if (publish && this.circuit(circuitId).publisher_uid) throw new Error('circuit already has a publisher; change it explicitly');
      const uid = `gateway_${randomBytes(12).toString('hex')}`, secret = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO credentials(uid,role,secret,circuit_id,label) VALUES(?,?,?,?,?)').run(uid, 'gateway', this.seal(secret), circuitId, label);
      if (publish) this.db.prepare('UPDATE circuits SET publisher_uid=? WHERE id=?').run(uid, circuitId);
      return { credential_uid: uid, credential_secret: secret, circuit_id: circuitId };
    });
  }
  bindDevice(sourceUid, circuitId, number) {
    if ((circuitId !== null && !this.circuit(circuitId)) || (circuitId === null && number !== null) ||
        (number !== null && !/^[A-Za-z0-9-]{1,16}$/.test(number))) throw new Error('invalid binding');
    const result = this.db.prepare('UPDATE credentials SET circuit_id=?,number=?,generation=generation+1 WHERE source_uid=?').run(circuitId, number, sourceUid);
    if (!result.changes) throw new Error('unknown device');
  }
  bindPublisher(circuitId, uid) {
    const row = this.credential(uid);
    if (!row || row.revoked || row.role !== 'gateway' || row.circuit_id !== circuitId) throw new Error('invalid publisher');
    this.db.prepare('UPDATE circuits SET publisher_uid=? WHERE id=?').run(uid, circuitId);
  }
  revoke(uid) {
    if (!this.db.prepare('UPDATE credentials SET revoked=1,generation=generation+1 WHERE uid=?').run(uid).changes) throw new Error('unknown credential');
  }
  close() { this.db.close(); }
}
