import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { decodeGps, verifySignature, validateFlags, canonicalJson, MAX_AGE_MS, LEASE_MS, WS_PROTOCOL, TOKEN_PREFIX, HASH } from './protocol.js';
import { normalizeLayout } from './layout.js';
import { CircuitRouter } from './routing.js';

const MAX_PEERS = 4096, MAX_SESSIONS = 8192, MAX_TOKENS = 16384, MAX_NONCES = 65536;
const TOKEN_MS = 300000, SESSION_MS = 900000;
const LAYOUT_LEASE_MS = 5000;
const emptyFlags = () => ({ fullCourse: null, zones: [], personal: [] });
const fail = (status, message) => Object.assign(new Error(message), { status });

// One pending value per key. A slow TCP stream is closed rather than allowed
// to accumulate historical positions or extend a flag lease on arrival.
export class LatestSocket {
  constructor(ws, now = Date.now) { this.ws = ws; this.now = now; this.pending = new Map(); this.blockedAt = null; }
  put(key, message) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.pending.set(key, message);
    if (this.pending.size > 2048) this.ws.terminate();
  }
  flush() {
    if (this.ws.readyState !== WebSocket.OPEN) { this.pending.clear(); return; }
    if (this.ws.bufferedAmount > 16384) {
      this.blockedAt ??= this.now();
      if (this.now() - this.blockedAt > 1000 || this.ws.bufferedAmount > 65536) this.ws.terminate();
      return;
    }
    this.blockedAt = null;
    for (const [key, message] of this.pending) {
      this.pending.delete(key);
      if (message.type === 'gps' && this.now() - message.timestampUs / 1000 > MAX_AGE_MS) continue;
      this.ws.send(JSON.stringify(message), error => { if (error) this.ws.terminate(); });
      if (this.ws.bufferedAmount > 16384) break;
    }
  }
}

export class Relay {
  constructor({ store, host = '127.0.0.1', port = 8787, udpHost = '0.0.0.0', udpPort = 8677, tls = null, now = Date.now }) {
    Object.assign(this, { store, host, port, udpHost, udpPort, now });
    this.sessions = new Map(); this.tokens = new Map(); this.nonces = new Map(); this.rate = new Map(); this.activationRate = new Map();
    this.latest = new Map(); this.peers = new Set(); this.publishers = new Map(); this.flags = new Map(); this.credentialCache = new Map();
    this.router = new CircuitRouter();
    this.stats = { gpsAccepted: 0, gpsRejected: 0, flagChanges: 0, flagExpired: 0, authRejected: 0 };
    this.server = tls ? https.createServer(tls) : http.createServer();
    this.server.requestTimeout = 10000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 5000;
    this.server.on('request', (req, res) => this.request(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 36864, perMessageDeflate: false,
      handleProtocols: protocols => protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', data => this.receiveGps(data));
    this.udp.on('error', error => { this.lastUdpError = error.code ?? 'udp_error'; });
  }
  async start() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve); });
    try {
      await new Promise((resolve, reject) => { this.udp.once('error', reject); this.udp.bind(this.udpPort, this.udpHost, resolve); });
    } catch (error) { this.server.close(); throw error; }
    this.timer = setInterval(() => this.tick(), 25); this.timer.unref();
    return { httpPort: this.server.address().port, udpPort: this.udp.address().port };
  }
  async close() {
    clearInterval(this.timer);
    for (const peer of this.peers) peer.ws.terminate();
    await Promise.all([
      new Promise(resolve => this.server.close(resolve)),
      new Promise(resolve => { try { this.udp.close(resolve); } catch { resolve(); } }),
      new Promise(resolve => this.wss.close(resolve)),
    ]);
  }
  credential(uid) {
    let cached = this.credentialCache.get(uid);
    if (!cached || this.now() - cached.at >= 1000) {
      cached = { row: this.store.credential(uid), at: this.now() };
      // Only successful identities are cached; random unauthenticated UIDs
      // cannot create an unbounded cache.
      if (cached.row) this.credentialCache.set(uid, cached);
    }
    return cached.row;
  }
  authorized(identity) {
    const row = this.credential(identity.uid);
    return row && !row.revoked && row.generation === identity.generation && row.circuit_id === (identity.roaming ? null : identity.circuitId);
  }
  deviceContext(identity) {
    if (!identity.roaming) return identity;
    const circuitId = this.router.circuit(identity.sourceUid);
    return { ...identity, circuitId, number: circuitId ? this.store.deviceNumber(identity.sourceUid, circuitId) : null };
  }
  allowRequest(ip) {
    const now = this.now(); let entry = this.rate.get(ip);
    if (!entry) {
      if (this.rate.size >= 4096) return false;
      entry = { tokens: 600, at: now };
    }
    entry.tokens = Math.min(600, entry.tokens + (now - entry.at) / 10); entry.at = now;
    this.rate.set(ip, entry);
    if (entry.tokens < 1) return false;
    entry.tokens--; return true;
  }
  authenticate(payload, role) {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object' || typeof payload.credential_uid !== 'string' || typeof payload.nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{1,79}$/.test(payload.credential_uid) || typeof payload.timestamp !== 'string' ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce)) throw fail(401, 'invalid authentication');
    const timestamp = Date.parse(payload.timestamp);
    const row = this.credential(payload.credential_uid);
    if (!Number.isFinite(timestamp) || Math.abs(timestamp - this.now()) > 300000 || !row || row.revoked || row.role !== role ||
        !verifySignature(this.store.unseal(row.secret), payload)) throw fail(401, 'invalid authentication');
    const nonce = `${row.uid}:${payload.nonce}`;
    if (this.nonces.has(nonce)) throw fail(401, 'replayed nonce');
    if (this.nonces.size >= MAX_NONCES) throw fail(503, 'authentication capacity');
    this.nonces.set(nonce, this.now() + 600000);
    return row;
  }
  issueToken(row) {
    if (this.tokens.size >= MAX_TOKENS) throw fail(503, 'session capacity');
    const existing = [...this.tokens].filter(([, t]) => t.uid === row.uid);
    for (const [token] of existing.slice(0, -3)) this.tokens.delete(token);
    const token = randomBytes(32).toString('base64url');
    const identity = { uid: row.uid, generation: row.generation, role: row.role, circuitId: row.circuit_id ?? 0,
      roaming: row.role === 'device' && row.circuit_id === null,
      sourceUid: row.source_uid, number: row.number, expires: this.now() + TOKEN_MS };
    this.tokens.set(token, identity);
    return token;
  }
  bearer(req) {
    let token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
    const offered = protocols.filter(p => p.startsWith(TOKEN_PREFIX));
    if (offered.length > 1) return null;
    const fromProtocol = offered[0]?.slice(TOKEN_PREFIX.length);
    if (token && fromProtocol && token !== fromProtocol) return null;
    token ??= fromProtocol;
    const identity = this.tokens.get(token);
    return identity && identity.expires > this.now() && this.authorized(identity) ? this.deviceContext({ ...identity }) : null;
  }
  async request(req, res) {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      if (!this.allowRequest(req.socket.remoteAddress ?? 'unknown')) throw fail(429, 'request rate exceeded');
      if (req.method === 'GET' && req.url === '/healthz') {
        json(this.lastUdpError ? 503 : 200, { ok: !this.lastUdpError }); return;
      }
      if (req.method === 'GET' && /^\/v1\/layouts\/[a-f0-9]{64}$/.test(req.url)) {
        const identity = this.bearer(req);
        if (!identity) throw fail(401, 'unauthorized');
        const hash = req.url.split('/').at(-1), circuit = this.store.circuit(identity.circuitId);
        if (circuit?.layout_hash !== hash) throw fail(409, 'layout changed');
        const body = this.store.layout(hash);
        if (req.headers['if-none-match'] === `"${hash}"`) { res.writeHead(304); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
          etag: `"${hash}"`, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        res.end(body); return;
      }
      if (req.method !== 'POST' || !['/api/v1/telemetry/session', '/v1/gateway/session', '/v1/mobile/activate'].includes(req.url)) throw fail(404, 'not found');
      if (req.url === '/v1/mobile/activate') {
        const ip = req.socket.remoteAddress ?? 'unknown', now = this.now();
        let entry = this.activationRate.get(ip);
        if (!entry) {
          if (this.activationRate.size >= 4096) throw fail(429, 'activation rate exceeded');
          entry = { at: now, count: 0 }; this.activationRate.set(ip, entry);
        }
        if (now - entry.at >= 60000) { entry.at = now; entry.count = 0; }
        if (++entry.count > 20) throw fail(429, 'activation rate exceeded');
      }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(415, 'JSON required');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw fail(413, 'request too large');
        chunks.push(chunk);
      }
      let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'invalid JSON'); }
      if (req.url === '/v1/mobile/activate') {
        let credential;
        try { credential = this.store.redeemMobile(payload?.activation_code, payload?.claim_nonce, this.now()); }
        catch { throw fail(401, 'invalid or expired invitation'); }
        json(201, { success: true, ...credential }); return;
      }
      const role = req.url === '/v1/gateway/session' ? 'gateway' : 'device';
      const row = this.authenticate(payload, role);
      if (role === 'device' && (payload.hardware_uid !== row.hardware_uid || payload.source_type !== (row.hardware_uid.startsWith('mobile:') ? 'mobile' : 'esp32') ||
          (payload.preferred_circuit_id !== undefined && String(payload.preferred_circuit_id) !== String(row.circuit_id)))) throw fail(401, 'device binding mismatch');
      if (role === 'gateway' && payload.circuit_id !== row.circuit_id) throw fail(403, 'circuit binding mismatch');
      const token = this.issueToken(row), identity = this.deviceContext(this.tokens.get(token)), circuit = this.store.circuit(identity.circuitId);
      const result = { success: true, access_token: token, control_expires_in: TOKEN_MS / 1000,
        control_path: '/v1/stream', circuit_id: identity.circuitId, circuit_name: circuit?.name ?? null, layout_hash: circuit?.layout_hash || null };
      if (role === 'device') {
        if (this.sessions.size >= MAX_SESSIONS) throw fail(503, 'session capacity');
        const previous = [...this.sessions.values()].filter(s => s.uid === row.uid);
        for (const session of previous.slice(0, -1)) this.sessions.delete(session.id);
        for (const session of previous) session.expires = Math.min(session.expires, this.now() + 10000);
        let id; do { id = randomBytes(4).readUInt32LE(); } while (this.sessions.has(id));
        const key = randomBytes(16), epoch = randomBytes(12).toString('hex');
        this.sessions.set(id, { id, key, epoch, uid: row.uid, generation: row.generation, circuitId: row.circuit_id,
          roaming: identity.roaming, sourceUid: row.source_uid, lastSequence: -1, expires: this.now() + SESSION_MS });
        Object.assign(result, { session_id: id, session_key: key.toString('base64'), expires_in: SESSION_MS / 1000, source_public_uid: row.source_uid });
      }
      json(201, result);
    } catch (error) {
      if (error.status === 401) this.stats.authRejected++;
      if (!res.headersSent && !res.destroyed) json(error.status ?? 500, { success: false, error: error.status ? error.message : 'internal error' });
    }
  }
  upgrade(req, socket, head) {
    socket.on('error', () => {});
    const reject = (status, reason) => { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (req.url !== '/v1/stream') return reject(404, 'Not Found');
    if (!this.allowRequest(req.socket.remoteAddress ?? 'unknown')) return reject(429, 'Too Many Requests');
    const identity = this.bearer(req);
    if (!identity) return reject(401, 'Unauthorized');
    if (this.peers.size >= MAX_PEERS) return reject(503, 'Unavailable');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
    if (!offered.includes(WS_PROTOCOL)) return reject(400, 'Protocol Required');
    this.wss.handleUpgrade(req, socket, head, ws => this.connected(ws, identity));
  }
  connected(ws, identity) {
    const circuit = this.store.circuit(identity.circuitId);
    const peer = { ...identity, ws, out: new LatestSocket(ws, this.now), epoch: randomBytes(12).toString('hex'),
      lastPong: this.now(), lastMessage: this.now(), messages: 0, lastSequence: -1, revision: 0,
      lastLayoutSequence: -1, layoutHash: circuit?.layout_hash || null,
      canPublish: identity.role === 'gateway' && circuit?.publisher_uid === identity.uid };
    // One connection per identity; a new publisher fences its old connection.
    for (const old of this.peers) if (old.uid === peer.uid) old.ws.terminate();
    this.peers.add(peer);
    ws.on('error', () => {});
    ws.on('pong', () => { peer.lastPong = this.now(); });
    ws.on('message', (data, binary) => {
      try {
        if (binary || !this.authorized(peer) || peer.expires <= this.now()) throw new Error('unauthorized message');
        if (this.now() - peer.lastMessage >= 1000) { peer.messages = 0; peer.lastMessage = this.now(); }
        if (++peer.messages > 20) throw new Error('message rate exceeded');
        this.message(peer, JSON.parse(data.toString('utf8')));
      } catch { ws.close(1008, 'invalid message'); }
    });
    ws.on('close', () => {
      this.peers.delete(peer);
      if (this.publishers.get(peer.circuitId) === peer) {
        this.publishers.delete(peer.circuitId); this.router.layouts.delete(peer.circuitId);
        this.invalidateFlags(peer.circuitId); this.refreshRoutes();
      }
    });
    peer.out.put('hello', { type: 'hello', schemaVersion: 1, circuitId: peer.circuitId, epoch: peer.epoch,
      circuitName: circuit?.name ?? null,
      role: peer.role, sourcePublicUid: peer.sourceUid, canPublish: peer.canPublish, layoutHash: peer.layoutHash,
      expiresAtMs: peer.expires, leaseMs: LEASE_MS });
    if (peer.canPublish) {
      this.publishers.set(peer.circuitId, peer); this.router.layouts.delete(peer.circuitId);
      this.invalidateFlags(peer.circuitId); this.refreshRoutes();
    }
    this.sendSnapshot(peer);
    if (peer.role === 'gateway') for (const sample of this.latest.values()) {
      if (sample.circuitId === peer.circuitId && this.now() - sample.timestampUs / 1000 <= MAX_AGE_MS) peer.out.put(`gps:${sample.sourcePublicUid}`, sample);
    }
    peer.out.flush();
  }
  receiveGps(data) {
    const session = data.length === 52 ? this.sessions.get(data.readUInt32LE(10)) : null;
    const sample = session && session.expires > this.now() && this.authorized(session) ? decodeGps(data, session, this.now()) : null;
    const previous = session && this.latest.get(session.sourceUid);
    if (!sample || sample.sequence <= session.lastSequence || (previous && sample.timestampUs <= previous.timestampUs)) {
      this.stats.gpsRejected++; return;
    }
    session.lastSequence = sample.sequence;
    sample.receivedAtMs = this.now();
    const circuitId = session.roaming ? this.router.observe(session.sourceUid, sample, this.now()) : session.circuitId;
    Object.assign(sample, { sourcePublicUid: session.sourceUid, epoch: session.epoch, circuitId, roaming: !!session.roaming,
      eventId: `relay:${session.sourceUid}:${session.epoch}:${sample.sequence}`, receivedAtMs: this.now() });
    this.latest.set(session.sourceUid, sample); this.stats.gpsAccepted++;
    if (session.roaming) this.clearForeignGps(session.sourceUid, circuitId);
    if (session.roaming) for (const peer of this.peers) if (peer.role === 'device' && peer.sourceUid === session.sourceUid) this.syncDevicePeer(peer);
    for (const peer of this.peers) if (peer.role === 'gateway' && peer.circuitId === sample.circuitId) peer.out.put(`gps:${sample.sourcePublicUid}`, sample);
  }
  message(peer, message) {
    if (message?.type === 'snapshot.request') { this.sendSnapshot(peer); return; }
    if (['layout.publish', 'layout.heartbeat', 'layout.withdraw'].includes(message?.type)) { this.layoutMessage(peer, message); return; }
    if (!peer.canPublish || this.publishers.get(peer.circuitId) !== peer ||
        this.store.circuit(peer.circuitId).publisher_uid !== peer.uid || message.epoch !== peer.epoch ||
        message.layoutHash !== this.store.circuit(peer.circuitId).layout_hash ||
        !Number.isSafeInteger(message.sequence) || message.sequence < 0 ||
        !Number.isSafeInteger(message.observedAtMs) || Math.abs(this.now() - message.observedAtMs) > MAX_AGE_MS) throw new Error('invalid publisher');
    const previous = this.flags.get(peer.circuitId);
    if (message.type === 'flags.publish') {
      if (message.sequence <= peer.lastSequence) throw new Error('old publication');
      if (typeof message.healthy !== 'boolean') throw new Error('source health required');
      const layout = JSON.parse(this.store.layout(message.layoutHash));
      const flags = validateFlags(message.flags, layout);
      peer.lastSequence = message.sequence;
      const state = { epoch: peer.epoch, revision: ++peer.revision, sequence: message.sequence,
        layoutHash: message.layoutHash, flags, healthy: message.healthy,
        validUntilMs: message.healthy ? Math.min(this.now(), message.observedAtMs) + LEASE_MS : 0 };
      this.flags.set(peer.circuitId, state); this.stats.flagChanges++;
      for (const client of this.peers) if (client.circuitId === peer.circuitId) this.sendSnapshot(client);
    } else if (message.type === 'flags.heartbeat') {
      if (!previous || previous.epoch !== peer.epoch || previous.sequence !== message.sequence || message.healthy !== true ||
          !previous.healthy || previous.validUntilMs <= this.now()) throw new Error('snapshot required');
      previous.validUntilMs = Math.min(this.now(), message.observedAtMs) + LEASE_MS;
      for (const client of this.peers) if (client.circuitId === peer.circuitId) client.out.put('lease', {
        type: 'flags.lease', schemaVersion: 1, epoch: previous.epoch, revision: previous.revision,
        layoutHash: previous.layoutHash, validUntilMs: previous.validUntilMs,
      });
    } else throw new Error('unsupported message');
  }
  sendSnapshot(peer) {
    const circuit = this.store.circuit(peer.circuitId), state = this.flags.get(peer.circuitId);
    const valid = !!state && state.healthy && state.layoutHash === circuit?.layout_hash && state.validUntilMs > this.now();
    const flags = valid ? state.flags : emptyFlags();
    peer.out.put('flags', { type: 'flags.snapshot', schemaVersion: 1, circuitId: peer.circuitId,
      epoch: state?.epoch ?? 'unavailable', revision: state?.revision ?? 0, layoutHash: circuit?.layout_hash || null,
      validUntilMs: valid ? state.validUntilMs : 0, healthy: valid,
      flags: { ...flags, personal: peer.role === 'device' ? flags.personal.filter(p => p.number === peer.number) : flags.personal } });
  }
  invalidateFlags(circuitId) {
    this.flags.delete(circuitId);
    for (const peer of this.peers) if (peer.circuitId === circuitId) this.sendSnapshot(peer);
  }
  layoutMessage(peer, message) {
    if (!peer.canPublish || this.publishers.get(peer.circuitId) !== peer ||
        this.store.circuit(peer.circuitId)?.publisher_uid !== peer.uid || message.circuitId !== peer.circuitId ||
        message.schemaVersion !== 1 || message.epoch !== peer.epoch || !Number.isSafeInteger(message.sequence) || message.sequence < 0 ||
        !Number.isSafeInteger(message.observedAtMs) || Math.abs(this.now() - message.observedAtMs) > MAX_AGE_MS) throw new Error('invalid layout publisher');
    const previous = this.router.layouts.get(peer.circuitId);
    if (message.type === 'layout.heartbeat') {
      if (!previous || previous.epoch !== peer.epoch || previous.until <= this.now() || message.sequence !== peer.lastLayoutSequence ||
          message.layoutHash !== previous.hash) throw new Error('layout snapshot required');
      previous.until = Math.min(this.now(), message.observedAtMs) + LAYOUT_LEASE_MS;
      return;
    }
    if (message.sequence <= peer.lastLayoutSequence) throw new Error('old layout publication');
    let hash = null;
    if (message.type === 'layout.publish') {
      const normalized = normalizeLayout(message.layout); hash = normalized.hash;
      const circuit = this.store.circuit(peer.circuitId);
      if (circuit.layout_hash !== hash) this.store.putCircuit(peer.circuitId, circuit.name, normalized.layout);
      this.router.layouts.set(peer.circuitId, { layout: normalized.layout, hash, epoch: peer.epoch,
        until: Math.min(this.now(), message.observedAtMs) + LAYOUT_LEASE_MS });
      peer.layoutHash = hash;
    } else this.router.layouts.delete(peer.circuitId);
    peer.lastLayoutSequence = message.sequence;
    if (previous?.hash !== hash) this.invalidateFlags(peer.circuitId);
    peer.out.put('layout', { type: 'layout.accepted', schemaVersion: 1, circuitId: peer.circuitId,
      epoch: peer.epoch, sequence: message.sequence, layoutHash: hash });
    this.refreshRoutes();
    for (const client of this.peers) if (client.role === 'device') this.syncDevicePeer(client);
  }
  syncDevicePeer(peer) {
    const context = this.deviceContext(peer), hash = this.store.circuit(context.circuitId)?.layout_hash || null;
    if (peer.circuitId === context.circuitId && peer.number === context.number && peer.layoutHash === hash) return;
    Object.assign(peer, { circuitId: context.circuitId, number: context.number, layoutHash: hash });
    peer.out.pending.clear();
    peer.out.put('assignment', { type: 'circuit.assignment', schemaVersion: 1, circuitId: peer.circuitId,
      circuitName: this.store.circuit(peer.circuitId)?.name ?? null, layoutHash: hash });
    this.sendSnapshot(peer);
  }
  refreshRoutes() {
    for (const uid of this.router.devices.keys()) {
      const sample = this.latest.get(uid);
      const circuitId = this.router.observe(uid, sample, this.now());
      if (sample?.roaming) sample.circuitId = circuitId;
      this.clearForeignGps(uid, circuitId);
      if (!sample && !circuitId) this.router.devices.delete(uid);
    }
    for (const peer of this.peers) if (peer.role === 'device' && peer.roaming) this.syncDevicePeer(peer);
  }
  clearForeignGps(uid, circuitId) {
    for (const peer of this.peers) if (peer.role === 'gateway' && peer.circuitId !== circuitId) peer.out.pending.delete(`gps:${uid}`);
  }
  tick() {
    const now = this.now();
    if (!this.lastMaintenance || now - this.lastMaintenance >= 1000) {
      this.lastMaintenance = now;
      for (const [id, session] of this.sessions) if (session.expires <= now || !this.authorized(session)) this.sessions.delete(id);
      for (const [id, token] of this.tokens) if (token.expires <= now || !this.authorized(token)) this.tokens.delete(id);
      for (const [id, expires] of this.nonces) if (expires <= now) this.nonces.delete(id);
      for (const [ip, entry] of this.rate) if (now - entry.at > 60000) this.rate.delete(ip);
      for (const [ip, entry] of this.activationRate) if (now - entry.at > 60000) this.activationRate.delete(ip);
      for (const [uid, cached] of this.credentialCache) if (now - cached.at > 600000) this.credentialCache.delete(uid);
      for (const [uid, sample] of this.latest) if (now - sample.timestampUs / 1000 > MAX_AGE_MS) this.latest.delete(uid);
      for (const [id, entry] of this.router.layouts) if (entry.until <= now || !this.publishers.has(id) ||
          this.store.circuit(id)?.layout_hash !== entry.hash) {
        this.router.layouts.delete(id); this.invalidateFlags(id);
      }
      this.refreshRoutes();
      for (const peer of this.peers) {
        const circuit = this.store.circuit(peer.circuitId);
        if (peer.expires <= now || !this.authorized(peer) || now - peer.lastPong > 15000 ||
            (peer.canPublish && circuit?.publisher_uid !== peer.uid)) { peer.ws.terminate(); continue; }
        if (peer.role === 'device') this.syncDevicePeer(peer);
        else if (peer.layoutHash !== (circuit?.layout_hash || null)) {
          peer.layoutHash = circuit.layout_hash;
          this.invalidateFlags(peer.circuitId);
          // Re-authentication gives the gateway/device an unambiguous new
          // layout handshake. A publisher must explicitly adopt the new hash.
          peer.ws.close(1012, 'layout changed');
          continue;
        }
        if (!peer.lastPing || now - peer.lastPing >= 5000) { peer.lastPing = now; peer.ws.ping(); }
      }
      for (const [circuitId, state] of this.flags) if (state.healthy && state.validUntilMs <= now) {
        state.healthy = false; this.stats.flagExpired++;
        for (const peer of this.peers) if (peer.circuitId === circuitId) this.sendSnapshot(peer);
      }
    }
    for (const peer of this.peers) peer.out.flush();
  }
}
