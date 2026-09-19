import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { Relay } from './server.js';

process.umask(0o077);
const host = process.env.RELAY_HOST ?? '127.0.0.1';
function port(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be 1..65535`);
  return value;
}
const httpPort = port('RELAY_PORT', 8787), udpPort = port('RELAY_UDP_PORT', 8677);
const cert = process.env.RELAY_TLS_CERT, key = process.env.RELAY_TLS_KEY;
if (!!cert !== !!key) throw new Error('set both RELAY_TLS_CERT and RELAY_TLS_KEY');
if (!cert && !['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.RELAY_BEHIND_TLS_PROXY !== '1') {
  throw new Error('public HTTP requires TLS or RELAY_BEHIND_TLS_PROXY=1 on a private proxy network');
}
const store = new Store(path.resolve(process.env.RELAY_DATA_DIR ?? 'data'));
const relay = new Relay({ store, host, port: httpPort,
  udpHost: process.env.RELAY_UDP_HOST ?? '0.0.0.0', udpPort,
  tls: cert ? { cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.2' } : null });
let addresses;
try { addresses = await relay.start(); } catch (error) { store.close(); throw error; }
console.log(JSON.stringify({ event: 'relay.started', host, ...addresses }));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  await relay.close(); store.close();
});
