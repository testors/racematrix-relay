#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { importCircuitLayout } from '../src/layout.js';

const usage = `Usage: node bin/relay.js COMMAND [options]
  circuit-create --circuit-id ID --name NAME
  circuit-put --circuit-id ID --name NAME --layout FILE
  circuit-import --circuit-id ID --name NAME --base-layout FILE --overlay FILE [--zone-ids id1,id2]
  device-provision --hardware-uid esp32:MAC --output PRIVATE.json [--circuit-id ID --number 7] [--rotate] [--import-credential FILE]
  gateway-provision --circuit-id ID --name NAME --output PRIVATE.json [--publish]
  mobile-invite --base-url https://RELAY --output PRIVATE.json [--udp-port 8677 --ttl-minutes 30 --circuit-id ID --name NAME]
  device-bind --source-uid SRC-... (--auto | --circuit-id ID [--number 7])
  device-number --source-uid SRC-... --circuit-id ID [--number 7]
  publisher-bind --circuit-id ID --credential-uid gateway_...
  revoke --credential-uid UID
  list
All commands accept --data-dir (default RELAY_DATA_DIR or ./data). Never print secrets.`;
let store;
try {
  process.umask(0o077);
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    ...['data-dir', 'circuit-id', 'name', 'layout', 'base-layout', 'overlay', 'zone-ids', 'hardware-uid', 'number', 'output', 'source-uid', 'credential-uid', 'import-credential', 'base-url', 'udp-port', 'ttl-minutes'].map(key => [key, { type: 'string' }]),
    ...['rotate', 'publish', 'help', 'auto'].map(key => [key, { type: 'boolean' }]),
  ]) });
  if (v.help || !positionals.length) { console.log(usage); process.exit(0); }
  if (positionals.length !== 1) throw new Error('one command is required');
  const command = positionals[0], circuitId = Number(v['circuit-id']);
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  if (['device-provision', 'gateway-provision', 'mobile-invite'].includes(command) && (!v.output || existsSync(v.output))) throw new Error('--output must be a new private file');
  store = new Store(path.resolve(v['data-dir'] ?? process.env.RELAY_DATA_DIR ?? 'data'));
  let result;
  if (command === 'circuit-create') store.createCircuit(circuitId, v.name);
  else if (command === 'circuit-put' || command === 'circuit-import') {
    const layout = command === 'circuit-put' ? read(v.layout) : importCircuitLayout(read(v['base-layout']), read(v.overlay), v['zone-ids']?.split(',')).layout;
    console.log(JSON.stringify({ circuitId, layoutHash: store.putCircuit(circuitId, v.name, layout) }));
  } else if (command === 'device-provision') {
    result = store.provisionDevice({ hardwareUid: v['hardware-uid'], circuitId: v['circuit-id'] === undefined ? null : circuitId, number: v.number ?? null,
      label: v.name ?? 'GPS', rotate: v.rotate, importCredential: v['import-credential'] ? read(v['import-credential']) : null });
  } else if (command === 'mobile-invite') {
    result = store.inviteMobile({ baseUrl: v['base-url'], udpPort: Number(v['udp-port'] ?? 8677), ttlMinutes: Number(v['ttl-minutes'] ?? 30),
      circuitId: v['circuit-id'] === undefined ? null : circuitId, label: v.name ?? 'Phone' });
  } else if (command === 'gateway-provision') {
    result = store.provisionGateway(circuitId, v.name, v.publish);
  } else if (command === 'device-bind') {
    if (v.auto && v['circuit-id'] !== undefined) throw new Error('--auto and --circuit-id are mutually exclusive');
    store.bindDevice(v['source-uid'], v.auto ? null : circuitId, v.number ?? null);
  } else if (command === 'device-number') store.setDeviceNumber(v['source-uid'], circuitId, v.number ?? null);
  else if (command === 'publisher-bind') store.bindPublisher(circuitId, v['credential-uid']);
  else if (command === 'revoke') store.revoke(v['credential-uid']);
  else if (command === 'list') console.log(JSON.stringify({
    circuits: store.db.prepare('SELECT * FROM circuits ORDER BY id').all(),
    credentials: store.db.prepare('SELECT uid,role,circuit_id,hardware_uid,source_uid,number,label,generation,revoked FROM credentials ORDER BY uid').all(),
    deviceNumbers: store.db.prepare('SELECT source_uid,circuit_id,number FROM device_numbers ORDER BY circuit_id,source_uid').all(),
  }, null, 2));
  else throw new Error('unknown command');
  if (result) {
    writeFileSync(v.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ credentialUid: result.credential_uid, sourcePublicUid: result.source_public_uid, writtenTo: v.output }));
  }
} catch (error) {
  console.error(`relay: ${error.message}`); process.exitCode = 1;
} finally { store?.close(); }
