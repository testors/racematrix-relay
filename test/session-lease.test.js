import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Relay } from '../src/server.js';
import { crc8 } from '../src/protocol.js';
import { fixture, session, connect, packet } from './helpers.js';

test('one authentication sustains UDP, bearer and the same WSS beyond their original lifetimes', async t => {
  const f = await fixture(t);
  let authentications = 0;
  f.relay.server.on('request', req => { if (req.url === '/api/v1/telemetry/session') authentications++; });
  const auth = await session(f, f.device), stream = await connect(f, auth.access_token);
  assert.equal(auth.session_renewal, 'udp');
  const peer = [...f.relay.peers][0], original = f.relay.sessions.get(auth.session_id);
  const key = Buffer.from(original.key), initialExpiry = original.expires;
  for (let second = 1; second <= 1200; second++) {
    // Advance wall time while keeping the existing TCP peer alive. GPS, not
    // pong/snapshot requests, must be what extends its authentication lease.
    peer.lastPong = f.now();
    f.advance(1000);
    f.relay.receiveGps(packet(auth, f.now() * 1000, second));
  }
  assert.ok(f.now() > initialExpiry);
  assert.equal(f.relay.stats.gpsAccepted, 1200);
  assert.equal(f.relay.sessions.size, 1);
  assert.deepEqual(original.key, key);
  assert.equal(stream.ws.readyState, WebSocket.OPEN);
  const headers = { authorization: `Bearer ${auth.access_token}` };
  assert.equal((await fetch(`${f.baseUrl}/v1/layouts/${f.hash}`, { headers })).status, 200);
  stream.send({ type: 'snapshot.request' });
  const snapshot = await stream.take(m => m.session?.expiresAtMs === f.now() + 900000);
  assert.deepEqual(snapshot.session, { id: auth.session_id, expiresAtMs: f.now() + 900000,
    controlExpiresAtMs: f.now() + 300000, registration: 'active' });
  assert.equal(authentications, 1);
  // Reconnecting with this same token also works after its original 5 minutes.
  const reconnected = await connect(f, auth.access_token);
  assert.equal(reconnected.hello.expiresAtMs, f.now() + 300000);
});

test('only authenticated, fresh and increasing UDP extends a session', async t => {
  const f = await fixture(t), auth = await session(f, f.device);
  const lease = f.relay.sessions.get(auth.session_id);
  f.relay.receiveGps(packet(auth, f.now() * 1000, 1));
  const expires = lease.expires, control = lease.controlExpires;
  f.advance(1000);
  const forged = packet(auth, f.now() * 1000, 2);
  forged[35] ^= 1; forged[51] = crc8(forged.subarray(0, 51));
  for (const bad of [forged, packet(auth, f.now() * 1000, 1),
    packet(auth, f.now() * 1000 - 5000000, 2), packet(auth, (f.now() - 1000) * 1000, 2)]) {
    f.relay.receiveGps(bad);
    assert.equal(lease.expires, expires);
    assert.equal(lease.controlExpires, control);
  }
  assert.equal(f.relay.stats.gpsRejected, 4);
  f.relay.receiveGps(packet(auth, f.now() * 1000, 2, 0)); // A fresh no-fix measurement is still authenticated activity.
  assert.equal(lease.expires, f.now() + 900000);
  assert.equal(lease.controlExpires, f.now() + 300000);
});

test('replacement grace cannot be extended by packets from an old session', async t => {
  const f = await fixture(t), old = await session(f, f.device);
  f.advance(1000);
  const current = await session(f, f.device), lease = f.relay.sessions.get(old.session_id);
  const deadline = lease.expires;
  f.advance(5000);
  f.relay.receiveGps(packet(old, f.now() * 1000, 1));
  assert.equal(lease.expires, deadline);
  assert.ok(lease.controlExpires <= deadline);
  f.advance(5001);
  f.relay.receiveGps(packet(old, f.now() * 1000, 2));
  assert.equal(f.relay.stats.gpsRejected, 1);
  assert.equal(f.relay.sessions.has(old.session_id), false);
  const headers = { authorization: `Bearer ${old.access_token}` };
  assert.equal((await fetch(`${f.baseUrl}/v1/layouts/${f.hash}`, { headers })).status, 401);
  f.relay.receiveGps(packet(current, f.now() * 1000, 0));
  assert.equal(f.relay.stats.gpsAccepted, 2);
});

test('idle expiry and revocation still reject validly signed UDP without reviving tokens', async t => {
  const f = await fixture(t), auth = await session(f, f.device);
  const lease = f.relay.sessions.get(auth.session_id), control = lease.controlExpires;
  f.advance(300001);
  f.relay.receiveGps(packet(auth, f.now() * 1000, 1));
  assert.equal(lease.expires, f.now() + 900000);
  assert.equal(lease.controlExpires, control);
  assert.equal(f.relay.tokens.has(auth.access_token), false);
  f.advance(900001);
  f.relay.receiveGps(packet(auth, f.now() * 1000, 2));
  assert.equal(f.relay.sessions.has(auth.session_id), false);
  const fresh = await session(f, f.device), freshLease = f.relay.sessions.get(fresh.session_id);
  const expires = freshLease.expires;
  f.store.revoke(f.device.credential_uid); f.advance(1001);
  f.relay.receiveGps(packet(fresh, f.now() * 1000, 0));
  assert.equal(freshLease.expires, expires);
  assert.equal(f.relay.stats.gpsAccepted, 1);
  assert.equal(f.relay.stats.gpsRejected, 2);
});

test('snapshot requests and WebSocket activity alone do not renew authentication', async t => {
  const f = await fixture(t), auth = await session(f, f.device), stream = await connect(f, auth.access_token);
  const peer = [...f.relay.peers][0], lease = f.relay.sessions.get(auth.session_id);
  const expires = lease.expires, control = lease.controlExpires;
  stream.send({ type: 'snapshot.request' });
  await stream.take(m => m.type === 'flags.snapshot');
  assert.equal(lease.expires, expires); assert.equal(lease.controlExpires, control);
  const closed = once(stream.ws, 'close');
  for (let i = 0; i < 301; i++) { peer.lastPong = f.now(); f.advance(1000); }
  await closed;
  assert.equal(f.relay.tokens.has(auth.access_token), false);
});

test('relay restart drops the old session and fresh authentication restores delivery', async t => {
  const f = await fixture(t), auth = await session(f, f.device), stream = await connect(f, auth.access_token);
  const closed = once(stream.ws, 'close');
  await f.relay.close(); await closed;
  const relay = new Relay({ store: f.store, host: '127.0.0.1', port: 0, udpHost: '127.0.0.1', udpPort: 0, now: f.now });
  const ports = await relay.start(); t.after(() => relay.close());
  relay.receiveGps(packet(auth, f.now() * 1000, 0));
  assert.equal(relay.stats.gpsRejected, 1);
  const restarted = { ...f, relay, baseUrl: `http://127.0.0.1:${ports.httpPort}` };
  const fresh = await session(restarted, f.device);
  relay.receiveGps(packet(fresh, f.now() * 1000, 0));
  assert.equal(relay.stats.gpsAccepted, 1);
  assert.equal((await connect(restarted, fresh.access_token)).hello.role, 'device');
});
