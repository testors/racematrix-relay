// Real relay sockets + the sibling daemon runtime. Isolated ports and registry;
// source observations are injected into a local simulator, never a live venue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import dgram from 'node:dgram';
import { fixture, session, connect, packet } from '../test/helpers.js';
const root = path.resolve(process.env.RACEMATRIX_DAEMON_REPO ?? '../racematrix-daemon');
const { discoverPlugins } = await import(pathToFileURL(`${root}/src/runtime/plugin-registry.js`));
const { ConfigStore } = await import(pathToFileURL(`${root}/src/runtime/config-store.js`));
const { PluginRuntime } = await import(pathToFileURL(`${root}/src/runtime/runtime.js`));
await discoverPlugins();
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('condition timeout'); }

test('ESP32 UDP -> relay -> daemon canonical telemetry; live flags -> relay -> device and disconnect invalidation', async t => {
  const f = await fixture(t); f.relay.now = Date.now; f.now = Date.now;
  const file = `${f.directory}/daemon.json`, published = [];
  writeFileSync(file, JSON.stringify({ gateway: { gatewayId: 'isolated-test', host: '127.0.0.1', port: 1 }, adapters: [
    { id: 'source', kind: 'simulator', enabled: true, intervalMs: 100000 },
    { id: 'relay', kind: 'racematrix-relay', enabled: true, baseUrl: f.baseUrl, allowInsecure: true,
      circuitId: 1, credentialUid: f.gateway.credential_uid, credentialSecret: f.gateway.credential_secret,
      publishFlags: true, flagSourceAdapterId: 'source', sourceTrackName: 'Test', layoutHash: f.hash,
      zoneBindings: [{ sourceEntityId: 'x2-sector-3', zoneId: 'zone-1' }] },
  ] }));
  const runtime = new PluginRuntime(await ConfigStore.load(file), { start() {}, stop() {}, publish(e) { published.push(e); } });
  t.after(() => runtime.stop()); await runtime.start();
  const source = runtime.plugins.get('source').plugin;
  let healthy = true;
  source.health = () => ({ status: 'running', session: { connected: healthy, authenticated: healthy, clientId: 'test', lastFrameAgeMs: 0 }, trackConfig: { current: 'Test' } });
  const event = { kind: 'control.flag.state.observed', adapterId: 'source', eventId: 'flag:1', overlayEntityId: 'x2-sector-3', sourceTimestampUs: Date.now() * 1000, payload: { scope: 'zone', flag: 'yellow' } };
  source.observedStateEvents = () => [event];
  await until(() => runtime.plugins.get('relay').plugin.connected);
  const device = await session(f, f.device), screen = await connect(f, device.access_token);
  const initial = await screen.take(m => m.type === 'flags.snapshot' && m.healthy && m.flags.zones[0]?.flag === 'yellow');
  assert.equal(initial.layoutHash, f.hash);
  const udp = dgram.createSocket('udp4'); t.after(() => udp.close());
  await new Promise((resolve, reject) => udp.send(packet(device, Date.now() * 1000, 0), f.udpPort, '127.0.0.1', e => e ? reject(e) : resolve()));
  await until(() => published.some(e => e.kind === 'vehicle.telemetry.observed'));
  const telemetry = published.find(e => e.kind === 'vehicle.telemetry.observed');
  assert.equal(telemetry.payload.telemetryDeviceId, f.device.source_public_uid);
  assert.equal(telemetry.payload.gps.latitude, 37.5001); assert.equal(telemetry.payload.speed.speedKph, 18.52);
  const change = { ...event, sourceTimestampUs: Date.now() * 1000, eventId: 'flag:2', payload: { scope: 'personal', flag: 'personal_blue', competitorNumber: '7' } };
  for (const callback of source.callbacks) callback(change);
  const personal = await screen.take(m => m.type === 'flags.snapshot' && m.healthy && m.flags.personal.length > 0);
  assert.equal(personal.flags.personal[0].zoneId, 'zone-1'); assert.equal(personal.flags.zones.length, 0);
  healthy = false;
  assert.equal((await screen.take(m => m.type === 'flags.snapshot' && !m.healthy && m.epoch === initial.epoch)).validUntilMs, 0);
  assert.equal(runtime.sourceObservers.get('source').size, 1);
  await runtime.disable('relay'); assert.equal(runtime.sourceObservers.has('source'), false);
});

test('two daemon pairs automatically publish selected layouts, switch tracks and route a roaming device', { timeout: 12000 }, async t => {
  const f = await fixture(t); f.relay.now = Date.now; f.now = Date.now;
  const roaming = f.store.provisionDevice({ hardwareUid: 'esp32:111111111111' });
  const secondGateway = f.store.provisionGateway(2, 'Second pair', true);
  async function pair(circuitId, credential, lat) {
    const state = { track: `Track ${circuitId}`, lat, healthy: true, flag: circuitId === 1 ? 'yellow' : 'red' };
    const file = `${f.directory}/daemon-${circuitId}.json`, events = [];
    writeFileSync(file, JSON.stringify({ gateway: { gatewayId: `pair-${circuitId}`, host: '127.0.0.1', port: 1 }, adapters: [
      { id: 'source', kind: 'simulator', enabled: true, intervalMs: 100000 },
      { id: 'relay', kind: 'racematrix-relay', enabled: true, baseUrl: f.baseUrl, allowInsecure: true,
        circuitId, credentialUid: credential.credential_uid, credentialSecret: credential.credential_secret,
        syncLayout: true, publishFlags: true, flagSourceAdapterId: 'source' },
    ] }));
    const runtime = new PluginRuntime(await ConfigStore.load(file), { start() {}, stop() {}, publish(e) { events.push(e); } });
    t.after(() => runtime.stop()); await runtime.start();
    const source = runtime.plugins.get('source').plugin;
    const points = () => [[state.lat, 127.3], [state.lat + .001, 127.3]];
    source.health = () => ({ status: 'running', session: { connected: state.healthy, authenticated: state.healthy, clientId: 'test', lastFrameAgeMs: 0 }, trackConfig: { current: state.track } });
    source.entities = () => [{ overlayEntityId: 'x2-sector-3', kind: 'flag_zone', path: points() }];
    source.trackSpine = () => ({ trackName: state.track, coordinates: points() });
    source.observedStateEvents = () => [{ kind: 'control.flag.state.observed', overlayEntityId: 'x2-sector-3', sourceTimestampUs: Date.now() * 1000,
      payload: { scope: 'zone', flag: state.flag }, eventId: `${state.track}:${state.flag}` }];
    return { runtime, state, events };
  }
  const a = await pair(1, f.gateway, 37.5), b = await pair(2, secondGateway, 38.5);
  await until(() => f.relay.router.layouts.size === 2 && f.relay.flags.get(1)?.healthy && f.relay.flags.get(2)?.healthy);
  const firstHash = f.store.circuit(1).layout_hash, secondHash = f.store.circuit(2).layout_hash;
  assert.notEqual(firstHash, secondHash);
  const auth = await session(f, roaming), device = await connect(f, auth.access_token);
  let seq = 0;
  const udp = dgram.createSocket('udp4'); t.after(() => udp.close());
  const send = lat => new Promise((resolve, reject) => udp.send(packet(auth, Date.now() * 1000, seq++, 7, { latitudeE7: Math.round(lat * 1e7) }),
    f.udpPort, '127.0.0.1', error => error ? reject(error) : resolve()));
  async function drive(lat) { for (let i = 0; i < 3; i++) { await send(lat); await new Promise(r => setTimeout(r, 210)); } }
  await drive(37.5001);
  assert.equal((await device.take(m => m.type === 'circuit.assignment')).circuitId, 1);
  const ownGps = e => e.kind === 'vehicle.telemetry.observed' && e.payload.telemetryDeviceId === roaming.source_public_uid;
  await until(() => a.events.some(ownGps)); assert.equal(b.events.some(ownGps), false);
  assert.equal((await device.take(m => m.type === 'flags.snapshot' && m.healthy)).flags.zones[0].flag, 'yellow');
  await drive(38.5001);
  await device.take(m => m.type === 'circuit.assignment' && m.circuitId === 2);
  await until(() => b.events.some(ownGps));
  assert.equal((await device.take(m => m.type === 'flags.snapshot' && m.healthy && m.circuitId === 2)).flags.zones[0].flag, 'red');
  // Ops selects the vendor track through its existing daemon command path;
  // the relay follows the resulting observed current track, without hashes
  // or entity mappings being manually reconfigured.
  b.state.track = 'Track 2 short'; b.state.flag = 'green';
  await until(() => f.store.circuit(2).layout_hash !== secondHash);
  const changed = await device.take(m => m.type === 'circuit.assignment' && m.circuitId === 2 && m.layoutHash !== secondHash);
  assert.equal(changed.layoutHash, f.store.circuit(2).layout_hash);
  assert.equal(f.store.circuit(1).layout_hash, firstHash);
  await until(() => f.relay.flags.get(2)?.flags.zones[0]?.flag === 'green');
  b.state.healthy = false;
  await until(() => !f.relay.router.layouts.has(2));
  await device.take(m => m.type === 'circuit.assignment' && m.circuitId === 0);
  assert.equal(f.relay.router.layouts.has(1), true);
});
