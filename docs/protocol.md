# Relay protocol v1

TLS protects HTTPS/WSS. Long-lived per-device/gateway secrets stay in factory
NVS/mobile secure storage/daemon configuration and the encrypted relay registry. Authentication uses
HMAC, not a hardware ID alone. Device creation is operator-only; mobile invitation redemption is described below.

## Session authentication

`POST /api/v1/telemetry/session` (device, compatible with Circuit GPS firmware):

```json
{
  "credential_uid": "cred_...",
  "hardware_uid": "esp32:aabbccddeeff",
  "nonce": "00112233445566778899aabbccddeeff00",
  "source_type": "esp32",
  "timestamp": "2026-09-19T12:34:56.000Z",
  "signature": "base64 HMAC-SHA256"
}
```

`POST /v1/gateway/session` uses `credential_uid`, numeric `circuit_id`, `nonce`,
`timestamp`, `signature`. Canonical JSON recursively sorts object keys, emits no
whitespace, and excludes `signature`. HMAC key = UTF-8 secret, **not** base64-decoded.
Timestamps must be within ±300s; used nonces remain rejected for 600s. Bodies are
limited to 4096 bytes. All requests are `application/json`.

Gateway credentials fix role and circuit. A device with a NULL registry circuit
is roaming; otherwise its circuit remains fixed. Device requests must match `hardware_uid`
and `source_type: "esp32"` for `esp32:<12hex>`, or `"mobile"` for `mobile:<32hex>`. Optional `preferred_circuit_id` must match the registry;
new Relay firmware provisioning omits this hint to allow server-side reassignments.

201 response common fields:

```json
{
  "success": true,
  "access_token": "43-character-base64url-token",
  "control_expires_in": 300,
  "control_path": "/v1/stream",
  "circuit_id": 1,
  "circuit_name": "Circuit A",
  "layout_hash": "64 lowercase hex characters"
}
```

Devices also receive `session_id` (uint32), `session_key` (base64 16 random bytes),
`expires_in: 900`, and `source_public_uid`. A replacement UDP session gets a new
key/epoch; the preceding session remains usable for at most 10s to bridge renewal.
At most two UDP sessions/four issued bearer tokens per credential are retained.
Credential rotation/rebinding/revocation invalidates sessions and WSS through
generation checks with a cache of at most 1s. Sessions are never persisted.
Roaming devices initially receive `circuit_id:0, layout_hash:null` and can upload
GPS and open WSS immediately. Location-based circuit changes preserve credentials
and UDP sessions. Layout GET authorization is resolved against the device's
current routing assignment, including when an older bearer token is reused.

## Mobile activation

`mobile-invite --base-url https://HOST --output PRIVATE.json` provisions a device
and exports `{relay_url,activation_code,expires_at,source_public_uid,credential_uid}`.
The code is 24 random bytes in base64url (32 characters), stored only as SHA256.
Default expiry 30 minutes, configurable 1..1440 minutes. The optional circuit and
UDP port are chosen by the trusted operator, never by the redeeming client.

`POST /v1/mobile/activate` with JSON `{activation_code,claim_nonce}` returns 201:
`{success:true,hardware_uid,source_public_uid,credential_uid,source_secret,circuit_id,udp_port}`.
`claim_nonce` is 32 random bytes as 64 lowercase hex, saved securely **before** the
request. First redemption atomically binds its SHA256 to the invitation. Until
expiry only the same nonce can retry (lost-response recovery). Other nonces, an
expired invitation, revoked device or changed credential generation return 401.
20 activation attempts/minute/socket IP; the HTTP proxy should also limit public
clients. No anonymous device registration, hardware-ID takeover or admin endpoint.
Secrets/codes are not logged. All responses use `Cache-Control: no-store`.

Mobile session HMAC works exactly as for ESP32; source type must match the
registry prefix. The random installation identity is not IMEI or a phone number.
Both sources send the identical encrypted GPS datagrams below. Mobile default
uplink is 1 Hz; acquisition tolerates distinct fixes up to 2 s apart. It still
requires three fixes over at least 400 ms and clears expired/ambiguous coverage.

## GPS UDP

One datagram is exactly 52 bytes, little-endian, version 2/type 2 only:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 2 | `BB 42` |
| 2 | 1 | `22` hex |
| 3 | 1 | reserved = 0 |
| 4 | 4 | uint32 sequence, strictly increasing per session |
| 8 | 1 | sample count = 1 |
| 9 | 1 | logger type = 2 |
| 10 | 4 | session ID |
| 14 | 8 | Unix UTC microseconds |
| 22 | 4 | signed longitude E7 |
| 26 | 4 | signed latitude E7 |
| 30 | 2 | heading degrees × 100 |
| 32 | 2 | speed km/h × 100 |
| 34 | 1 | valid bits: position=1, speed=2, heading=4 |
| 35 | 16 | first 16 bytes of HMAC-SHA256 |
| 51 | 1 | CRC8 poly 0x07, initial 0 |

AES-128-CTR encrypts bytes 14..34. Initial counter =
`[sessionId LE4][sequence LE4][02][02][00 × 6]`. HMAC uses the session key over
encrypted bytes 0..34; CRC covers bytes 0..50. Sequence must never wrap or repeat
with the same key. See [shared golden vector](../test/fixtures/gps-v2-vector.json).

UTC age must be within ±2000ms; repeated/older per-source timestamps and session
sequences are discarded. Position validity gates speed/heading validity. An
explicit no-fix sample clears position with null fields; silence never creates
a synthetic valid coordinate. No ACK, retransmission or offline backlog.

## WSS and layout fetch

Both roles connect to `/v1/stream`, offering subprotocol `racematrix-relay-v1`.
Authenticate with `Authorization: Bearer <token>` or an additional offered
subprotocol `racematrix-relay-bearer.<token>` (native daemon WebSocket cannot set
arbitrary headers). The selected protocol is always `racematrix-relay-v1`.
Tokens in query strings are rejected. One active connection per credential.

The first server message is `hello` with `schemaVersion:1`, `role`, `circuitId`,
`circuitName` (string or null), `sourcePublicUid` (devices), `epoch`, `canPublish`, `layoutHash`, `expiresAtMs`,
`leaseMs:3000`. Next comes `flags.snapshot`; gateways also receive current GPS
samples. `snapshot.request` requests the current flags, without history.

`GET /v1/layouts/<sha256>` uses bearer Authorization and permits only the caller's
currently assigned layout. Response is canonical compact JSON, at most 32768
bytes; ETag equals the raw response SHA-256. Clients verify the hash before use.
Layout `{schemaVersion:1,layoutId,revision,zones}` has 1..48 zones and at most 512
points total. Zone `{id,kind:"path"|"polygon",points:[[latE7,lonE7],...],widthM}`
uses ID characters `[A-Za-z0-9_:.-]`, at most 64. Path width is 2..100m; polygon
width is 0. Polygons need at least 3 distinct points, paths at least 2.
Layouts are kept in RAM on ESP32 and fetched after boot and on hash change.
Optional `coverage:{points:[[latE7,lonE7],...],radiusM}` is a circuit-selection
centerline (2..512 points, radius 25..500m), separate from driving-zone widths.
These additional points share the same 32KiB document limit. Without coverage,
roaming selection uses the union of path corridors of 150m and polygon interiors.

## Current layout publication and roaming

Only the circuit's designated publisher may send the following messages. Every
message carries `schemaVersion:1`, its own `circuitId`, connection `epoch`,
`sequence` and a fresh `observedAtMs` within ±2000ms:

- `layout.publish` additionally carries the full compact `layout` document.
- `layout.heartbeat` carries `layoutHash` and repeats the last layout sequence.
- `layout.withdraw` removes the circuit from automatic selection.

Publish/withdraw sequences strictly increase within the publisher connection.
The server validates/normalizes the document and updates only that credential's
circuit. It replies to publish/withdraw with `layout.accepted` containing
`schemaVersion`, `circuitId`, `epoch`, `sequence`, `layoutHash` (null for withdrawal).
The daemon waits for the matching hash ACK before publishing flags for that
layout. No static track-name/hash/zone mapping is required in automatic mode.
Heartbeat may extend only a live matching publication. Layout lifetime is
`min(serverNow, observedAtMs)+5000`; withdrawal, expiry, disconnect, publisher
replacement invalidates its flags and automatic routes. A track/layout change
invalidates flags and reevaluates routes against the new geometry.
Persisted layouts alone do not reactivate routes after relay restart.

A roaming device is assigned only if exactly one active circuit covers its
position for at least three distinct accepted fixes spanning 400ms, with no gap
over 1s while acquiring the circuit. Ambiguous/off-track/no-fix/stale GPS clears
the circuit. GPS reaches only the assigned circuit's gateways. The source UID
stays unchanged, and personal flag numbers are looked up per (source UID,circuit).

The server sends `circuit.assignment {schemaVersion:1,circuitId,circuitName,layoutHash}` on
circuit or layout changes. Circuit 0 and a null hash mean no assignment. A
positive circuit can also have a null hash while awaiting its initial layout.
The device immediately invalidates flags, reconnects and downloads/verifies the
new layout before accepting new snapshots. `hello` also carries the current
assignment to resolve races with session creation/download/reconnect. Queued
flags/leases and GPS for the previous circuit are discarded on reassignment.

Gateway GPS message:

```json
{
  "type": "gps", "schemaVersion": 1, "circuitId": 1,
  "sourcePublicUid": "SRC-...", "epoch": "24 lowercase hex characters",
  "sequence": 42, "timestampUs": 1789821296200000,
  "latitudeE7": 375001000, "longitudeE7": 1273001000,
  "speedCkph": 1852, "headingCdeg": 12345,
  "eventId": "relay:SRC-...:<epoch>:42", "receivedAtMs": 1789821296250
}
```

Invalid measurements are null. Session epoch plus sequence makes event IDs unique
across device restarts. Consumers reject delayed or older measurement timestamps.

## Flag publication and leases

Only the registry-selected gateway may publish for a circuit. New connections
fence the previous publisher by an unpredictable connection epoch from `hello`.

```json
{
  "type": "flags.publish", "epoch": "publisher hello epoch", "sequence": 1,
  "layoutHash": "approved layout hash", "observedAtMs": 1789821296200,
  "healthy": true,
  "flags": {
    "fullCourse": "yellow",
    "zones": [{ "id": "zone-1", "flag": "red" }],
    "personal": [{ "number": "7", "zoneId": "zone-1", "flag": "personal_blue" }]
  }
}
```

`sequence` strictly increases per publisher connection. `layoutHash` must equal
the current registered hash. `observedAtMs` is the last **source traffic receipt**,
not the unchanged flag's original change time, and must be within ±2000ms.
The daemon checks authenticated source health and the selected track before
issuing `healthy:true`. An unhealthy snapshot clears state immediately.

Unchanged live state uses `flags.heartbeat` with the same epoch, sequence,
layoutHash, observedAtMs and `healthy:true`; no `flags` body. It may only extend
the matching, still healthy published state. After expiry a new snapshot is
required. Lease end = `min(serverNow, observedAtMs) + 3000`.

Device/reader receives `flags.snapshot` with `schemaVersion`, `circuitId`,
`epoch`, server `revision`, `layoutHash`, `validUntilMs`, `healthy`, and `flags`.
Only personal entries matching the fixed credential's vehicle number, or the
roaming device's current circuit-specific number, reach that device.
There are at most 48 zone flags and 128 personal entries per circuit snapshot;
duplicate zone IDs or (number,zoneId) pairs are rejected. All referenced zones
must exist in the layout; global personal flags use `zoneId:null`.

Heartbeat delivery is `flags.lease {schemaVersion,epoch,revision,layoutHash,validUntilMs}`.
The device extends only an existing matching snapshot, bounds remaining life to
3s, then uses monotonic time. A lease alone cannot restore an expired snapshot.
Clients periodically request a snapshot to recover. Display validity does not
wait for HTTP downloads, TCP timeouts or a successful disconnect callback.

Flag tokens follow daemon canonical names: clear, green, yellow, double_yellow,
red, blue, white, black, slippery, safety_car, full_course_yellow, pit_entry_right,
personal_blue, personal_mechanical, personal_behavior, personal_black, checkered,
slow_zone, rain, fim_slippery, fim_yellow_slippery, vsc, code60, unknown.
`null` means no known state. `clear` is explicit clearing, never an inferred green.

Disconnect/restart/revocation/track mismatch/expired source traffic never imply
green. Firmware exposes full-course, local-zone and personal flags separately;
it does not invent a combined precedence or suppress red in favor of blue.
No GPS fix for 1s, an unknown layout, overlapping geometry or being off-track
invalidates local-zone selection. A fresh full-course flag can remain valid
without a GPS fix.

## Bounds and operational semantics

WSS input ≤36864 bytes and ≤20 messages/s/peer; JSON flag snapshots stay within the
ESP32's 16KiB control frame limit after device-specific filtering.
Gateway output queue is keyed by device UID (latest only), max 2048 pending keys;
slow streams are terminated above 64KiB buffered or after >1s over 16KiB.
Stale queued positions are dropped before transmission; flag expiry is absolute.
Session/token/nonce/IP/connection tables have hard limits. Transport ping every
5s, missing pong >15s closes WSS. Application snapshot requests detect half-open
streams in clients. Runtime identities, state, nonce caches and tokens are lost
on server restart; clients reauthenticate and seed fresh state.
