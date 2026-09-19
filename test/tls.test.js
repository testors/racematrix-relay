import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Store } from '../src/store.js';
import { Relay } from '../src/server.js';
import { WS_PROTOCOL } from '../src/protocol.js';
import { layout, signed } from './helpers.js';

test('HTTPS/WSS verify a trusted certificate and reject an untrusted peer; header bearer works', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rm-relay-tls-'));
  let store, relay;
  t.after(async () => { await relay?.close(); store?.close(); rmSync(directory, { recursive: true, force: true }); });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', `${directory}/tls.key`, '-out', `${directory}/tls.crt`], { stdio: 'ignore' });
  const cert = readFileSync(`${directory}/tls.crt`), key = readFileSync(`${directory}/tls.key`);
  store = new Store(`${directory}/data`); store.putCircuit(1, 'TLS test', layout);
  const credential = store.provisionDevice({ hardwareUid: 'esp32:aabbccddeeff', circuitId: 1 });
  relay = new Relay({ store, port: 0, udpPort: 0, udpHost: '127.0.0.1', tls: { cert, key, minVersion: 'TLSv1.2' } });
  const { httpPort } = await relay.start();
  const request = ca => new Promise((resolve, reject) => {
    const body = JSON.stringify(signed(credential, Date.now()));
    const req = https.request(`https://127.0.0.1:${httpPort}/api/v1/telemetry/session`, {
      method: 'POST', ca, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(body);
  });
  await assert.rejects(request(undefined), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  const auth = await request(cert); assert.equal(auth.status, 201);
  const ws = new WebSocket(`wss://127.0.0.1:${httpPort}/v1/stream`, WS_PROTOCOL, { ca: cert, headers: { Authorization: `Bearer ${auth.access_token}` } });
  const first = await new Promise((resolve, reject) => { ws.once('message', data => resolve(JSON.parse(data))); ws.once('error', reject); });
  assert.equal(first.type, 'hello'); assert.equal(first.sourcePublicUid, credential.source_public_uid);
  ws.terminate();
});
