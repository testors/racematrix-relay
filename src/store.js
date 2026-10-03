import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { normalizeLayout } from './layout.js';

const SOURCE_UID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 'G' + Base32 (no I/L/O/U, for printed labels); older registries issued SRC-... IDs.
export const SOURCE_UID = /^(SRC[-_][A-Za-z0-9_-]{1,35}|G[0-9A-HJKMNP-TV-Z]{8,12})$/;
// Eight characters are 40 bits of SHA-256. A longer form of the same digest
// resolves the rare case of two units sharing those 40 bits.
export function derivedSourceUid(hardwareUid, length = 8) {
  const bits = createHash('sha256').update(`racematrix-source-uid:${hardwareUid}`).digest().readBigUInt64BE();
  return 'G' + Array.from({ length }, (_, i) => SOURCE_UID_ALPHABET[Number((bits >> BigInt(59 - 5 * i)) & 31n)]).join('');
}
// credentials.status: a self-enrolled device waits for an operator before any
// of its positions reach a circuit. Rejected hardware cannot enroll again.
export const ACTIVE = 0, PENDING = 1, REJECTED = 2;
const MAX_PENDING = 256;
const fail = (status, message) => Object.assign(new Error(message), { status });
// Operator-visible device options: a flat JSON object of booleans, integers and
// short tokens. The firmware defines the keys; the Relay only stores and
// forwards them.
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/, SETTING_TEXT = /^[A-Za-z0-9_.-]{0,32}$/;
export function validSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length >= 1 && entries.length <= 16 && entries.every(([key, v]) => SETTING_KEY.test(key) &&
    (typeof v === 'boolean' || (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) || (typeof v === 'string' && SETTING_TEXT.test(v))));
}

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
    // Added after the table rebuild above so old registries migrate unchanged.
    const columns = new Set(this.db.prepare('PRAGMA table_info(credentials)').all().map(c => c.name));
    if (!columns.has('status')) this.db.exec('ALTER TABLE credentials ADD COLUMN status INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('owner_circuit_id')) this.db.exec('ALTER TABLE credentials ADD COLUMN owner_circuit_id INTEGER');
    if (!columns.has('created_ms')) this.db.exec('ALTER TABLE credentials ADD COLUMN created_ms INTEGER');
    // What the unit itself reports about its modem and SIM: labels for
    // operators to match a physical unit, never an authentication input.
    for (const column of ['battery_voltage_mv', 'battery_reported_ms']) if (!columns.has(column)) this.db.exec(`ALTER TABLE credentials ADD COLUMN ${column} INTEGER`);
    for (const column of ['imei', 'iccid', 'phone_tail', 'phone_number']) if (!columns.has(column)) this.db.exec(`ALTER TABLE credentials ADD COLUMN ${column} TEXT`);
    // The unit's own settings report, and the changes an operator asked for
    // until the unit confirms them by revision.
    for (const column of ['settings', 'settings_request']) if (!columns.has(column)) this.db.exec(`ALTER TABLE credentials ADD COLUMN ${column} TEXT`);
    for (const column of ['settings_reported_ms', 'settings_revision', 'settings_requested_ms']) if (!columns.has(column)) this.db.exec(`ALTER TABLE credentials ADD COLUMN ${column} INTEGER`);
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
  allocateSourceUid(hardwareUid) {
    // The ID is a function of the hardware ID, not of this registry: a rebuilt
    // registry gives every unit the ID that Ops entries already refer to.
    // Callers hold BEGIN IMMEDIATE through the insert, serializing writers.
    const owner = this.db.prepare('SELECT hardware_uid FROM credentials WHERE source_uid=?');
    for (const length of [8, 10, 12]) {
      const source = derivedSourceUid(hardwareUid, length), row = owner.get(source);
      if (!row || row.hardware_uid === hardwareUid) return source;
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
            !SOURCE_UID.test(importCredential.source_public_uid) || !/^[A-Za-z0-9_-]{32,127}$/.test(importCredential.source_secret))) throw new Error('invalid Circuit credential import');
        const uid = importCredential?.credential_uid ?? `cred_${randomBytes(12).toString('hex')}`;
        const source = importCredential?.source_public_uid ?? this.allocateSourceUid(hardwareUid);
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
  devices() {
    return this.db.prepare(`SELECT uid,circuit_id,hardware_uid,source_uid,number,label,generation,revoked,status,owner_circuit_id,created_ms,imei,iccid,phone_tail,phone_number,battery_voltage_mv,battery_reported_ms,
      settings,settings_reported_ms,settings_request,settings_revision,settings_requested_ms
      FROM credentials WHERE role='device' ORDER BY source_uid`).all();
  }
  deviceBySource(sourceUid) { return this.db.prepare("SELECT * FROM credentials WHERE role='device' AND source_uid=?").get(sourceUid); }
  deviceByHardware(hardwareUid) { return this.db.prepare("SELECT * FROM credentials WHERE role='device' AND hardware_uid=?").get(hardwareUid); }
  devicesByImei(imei) { return this.db.prepare("SELECT * FROM credentials WHERE role='device' AND imei=?").all(imei); }
  // Store full SIM numbers; retain/derive phone_tail for existing Ops clients.
  // A settings report replaces the previous one; a report without settings keeps it.
  // settingsRevision confirms the request with that revision, whatever the unit made of it.
  setDeviceInfo(uid, { imei = null, iccid = null, phoneTail = null, phoneNumber = null, batteryVoltageMv, settings, settingsRevision, reportedAtMs = Date.now() }) {
    if ((imei !== null && !/^[0-9]{14,17}$/.test(imei)) || (iccid !== null && !/^[0-9]{18,22}$/.test(iccid)) ||
        (phoneTail !== null && !/^[0-9]{4}$/.test(phoneTail)) ||
        (phoneNumber !== null && (typeof phoneNumber !== 'string' || !/^\+?[0-9]{7,15}$/.test(phoneNumber))) ||
        (phoneNumber !== null && phoneTail !== null && phoneTail !== phoneNumber.slice(-4))) throw fail(400, 'invalid device information');
    if (phoneNumber !== null) phoneTail = phoneNumber.slice(-4);
    const batteryPresent = batteryVoltageMv !== undefined;
    if (batteryPresent && ((batteryVoltageMv !== null && (!Number.isInteger(batteryVoltageMv) || batteryVoltageMv < 2000 || batteryVoltageMv > 6000)) ||
        !Number.isSafeInteger(reportedAtMs) || reportedAtMs < 0)) throw fail(400, 'invalid battery information');
    const settingsPresent = settings !== undefined;
    if ((settingsPresent && !validSettings(settings)) || (settingsRevision !== undefined &&
        (!Number.isInteger(settingsRevision) || settingsRevision < 1 || settingsRevision > 0xffffffff))) throw fail(400, 'invalid device settings');
    if (!this.db.prepare(`UPDATE credentials SET imei=?,iccid=?,phone_tail=?,phone_number=?,
      battery_voltage_mv=CASE WHEN ? THEN ? ELSE battery_voltage_mv END,
      battery_reported_ms=CASE WHEN ? THEN ? ELSE battery_reported_ms END,
      settings=CASE WHEN ? THEN ? ELSE settings END,
      settings_reported_ms=CASE WHEN ? THEN ? ELSE settings_reported_ms END,
      settings_request=CASE WHEN settings_revision=? THEN NULL ELSE settings_request END WHERE uid=? AND role='device'`)
      .run(imei, iccid, phoneTail, phoneNumber, Number(batteryPresent), batteryVoltageMv ?? null, Number(batteryPresent), reportedAtMs,
        Number(settingsPresent), settingsPresent ? JSON.stringify(settings) : null, Number(settingsPresent), reportedAtMs,
        settingsRevision ?? null, uid).changes) throw fail(404, 'unknown device');
  }
  // Only keys the unit itself reported, with the same JSON type, can be asked
  // for. Requests made before the unit answers are merged into one.
  requestDeviceSettings(uid, patch, now = Date.now()) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT settings,settings_request,settings_revision FROM credentials WHERE uid=? AND role='device'").get(uid);
      if (!row) throw fail(404, 'unknown device');
      if (!row.settings) throw fail(409, 'device has not reported its settings');
      const reported = JSON.parse(row.settings);
      if (!validSettings(patch) || Object.entries(patch).some(([key, value]) => !Object.hasOwn(reported, key) || typeof value !== typeof reported[key])) throw fail(400, 'invalid device settings');
      // Seconds since 1970, so a rebuilt registry never reuses a revision the unit has already handled.
      const revision = Math.max(Math.floor(now / 1000), (row.settings_revision ?? 0) + 1);
      this.db.prepare('UPDATE credentials SET settings_request=?,settings_revision=?,settings_requested_ms=? WHERE uid=?')
        .run(JSON.stringify({ ...(row.settings_request ? JSON.parse(row.settings_request) : {}), ...patch }), revision, now, uid);
      return revision;
    });
  }
  deviceNumbers(circuitId) {
    return new Map(this.db.prepare('SELECT source_uid,number FROM device_numbers WHERE circuit_id=?').all(circuitId).map(r => [r.source_uid, r.number]));
  }
  // The device chooses its own key on first boot and presents it over TLS.
  // The first key seen for a hardware ID is kept; an operator still has to
  // approve the device before it is routed anywhere.
  enrollDevice({ hardwareUid, secret, now = Date.now() }) {
    if (typeof hardwareUid !== 'string' || !/^esp32:[a-f0-9]{12}$/.test(hardwareUid) ||
        typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,127}$/.test(secret)) throw fail(400, 'invalid enrollment');
    return this.transaction(() => {
      let row = this.deviceByHardware(hardwareUid);
      if (!row) {
        if (this.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE role='device' AND status=? AND revoked=0").get(PENDING).n >= MAX_PENDING) throw fail(503, 'enrollment capacity');
        const uid = `cred_${randomBytes(12).toString('hex')}`;
        this.db.prepare('INSERT INTO credentials(uid,role,secret,circuit_id,hardware_uid,source_uid,number,label,status,created_ms) VALUES(?,?,?,NULL,?,?,NULL,?,?,?)')
          .run(uid, 'device', this.seal(secret), hardwareUid, this.allocateSourceUid(hardwareUid), 'GPS', PENDING, now);
        row = this.credential(uid);
      } else if (row.revoked) {
        // A revoked device that was reset comes back as a new request under the ID
        // derived from its hardware, which also retires an older SRC-... ID.
        this.db.prepare('DELETE FROM device_numbers WHERE source_uid=?').run(row.source_uid);
        this.db.prepare('UPDATE credentials SET secret=?,source_uid=?,status=?,revoked=0,generation=generation+1,circuit_id=NULL,number=NULL,owner_circuit_id=NULL,settings_request=NULL,created_ms=? WHERE uid=?')
          .run(this.seal(secret), this.allocateSourceUid(hardwareUid), PENDING, now, row.uid);
        row = this.credential(row.uid);
      } else {
        if (row.status === REJECTED) throw fail(403, 'enrollment rejected');
        const stored = Buffer.from(this.unseal(row.secret)), offered = Buffer.from(secret);
        if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) throw fail(409, 'hardware is registered with another key');
      }
      return { credential_uid: row.uid, source_public_uid: row.source_uid, registration: row.status === PENDING ? 'pending' : 'active' };
    });
  }
  approveDevice(uid, ownerCircuitId, label = null) {
    if ((ownerCircuitId !== null && !this.circuit(ownerCircuitId)) || (label !== null && (typeof label !== 'string' || !label || label.length > 80))) throw new Error('invalid approval');
    const result = this.db.prepare(`UPDATE credentials SET status=?,owner_circuit_id=?,label=COALESCE(?,label)
      WHERE uid=? AND role='device' AND revoked=0 AND status IN (?,?)`).run(ACTIVE, ownerCircuitId, label, uid, PENDING, REJECTED);
    if (!result.changes) throw new Error('no pending device');
  }
  rejectDevice(uid) {
    if (!this.db.prepare("UPDATE credentials SET status=?,generation=generation+1 WHERE uid=? AND role='device' AND status=?").run(REJECTED, uid, PENDING).changes) throw new Error('no pending device');
  }
  setDeviceLabel(uid, label) {
    if (typeof label !== 'string' || !label || label.length > 80 || !this.db.prepare("UPDATE credentials SET label=? WHERE uid=? AND role='device'").run(label, uid).changes) throw new Error('invalid label');
  }
  setDeviceOwner(sourceUid, circuitId) {
    if ((circuitId !== null && !this.circuit(circuitId)) || !this.db.prepare("UPDATE credentials SET owner_circuit_id=? WHERE source_uid=? AND role='device'").run(circuitId, sourceUid).changes) throw new Error('invalid owner');
  }
  revoke(uid) {
    if (!this.db.prepare('UPDATE credentials SET revoked=1,generation=generation+1 WHERE uid=?').run(uid).changes) throw new Error('unknown credential');
  }
  close() { this.db.close(); }
}
