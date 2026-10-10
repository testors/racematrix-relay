import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** ESP-IDF image header chip ids this Relay distributes. */
export const FIRMWARE_TARGETS = { esp32: 0x0000, esp32s3: 0x0009 };
export const FIRMWARE_PROJECT = 'racematrix-gps-device';
export const FIRMWARE_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IMAGE_MAGIC = 0xe9, APP_DESC_MAGIC = 0xabcd5432, APP_DESC_OFFSET = 0x20, MIN_IMAGE_BYTES = 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });

function cString(buffer, offset, length) {
  const bytes = buffer.subarray(offset, offset + length), end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? length : end).toString('utf8');
}

/** Reads esp_image_header_t and the esp_app_desc_t that follows the first segment header. */
export function parseImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) throw fail(400, 'firmware image too small');
  if (buffer[0] !== IMAGE_MAGIC) throw fail(400, 'not an ESP-IDF image');
  if (buffer.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) throw fail(400, 'app descriptor missing');
  const d = APP_DESC_OFFSET;
  return { chipId: buffer.readUInt16LE(12), version: cString(buffer, d + 16, 32), projectName: cString(buffer, d + 48, 32),
    time: cString(buffer, d + 80, 16), date: cString(buffer, d + 96, 16), idfVersion: cString(buffer, d + 112, 32),
    appElfSha256: buffer.subarray(d + 144, d + 176).toString('hex') };
}

/** The image a device would fetch for `target`/`version` must describe itself the same way. */
export function validateImage(buffer, target, version) {
  if (!Object.hasOwn(FIRMWARE_TARGETS, target)) throw fail(400, 'unknown firmware target');
  if (typeof version !== 'string' || !FIRMWARE_VERSION.test(version)) throw fail(400, 'invalid firmware version');
  const image = parseImage(buffer);
  if (image.chipId !== FIRMWARE_TARGETS[target]) throw fail(400, `image chip id 0x${image.chipId.toString(16)} is not ${target}`);
  if (image.version !== version) throw fail(400, `image version "${image.version}" is not ${version}`);
  if (image.projectName !== FIRMWARE_PROJECT) throw fail(400, `image project "${image.projectName}" is not ${FIRMWARE_PROJECT}`);
  return image;
}

/** Images under <data>/firmware/<target>/<version>.bin with a <version>.json sidecar. */
export class FirmwareStore {
  constructor(dataDirectory) { this.directory = path.join(dataDirectory, 'firmware'); }
  paths(target, version) {
    if (!Object.hasOwn(FIRMWARE_TARGETS, target) || typeof version !== 'string' || !FIRMWARE_VERSION.test(version)) return null;
    const dir = path.join(this.directory, target);
    return { dir, bin: path.join(dir, `${version}.bin`), meta: path.join(dir, `${version}.json`) };
  }
  put(target, version, buffer, { replace = false, now = Date.now() } = {}) {
    const image = validateImage(buffer, target, version);
    const p = this.paths(target, version);
    if (!replace && existsSync(p.bin)) throw fail(409, 'firmware version exists; pass --replace to overwrite');
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const meta = { target, version, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
      projectName: image.projectName, builtAt: `${image.date} ${image.time}`.trim(), idfVersion: image.idfVersion, chipId: image.chipId, putAtMs: now };
    // The image lands before its sidecar, so a sidecar never describes a missing or half-written image.
    writeFileSync(`${p.bin}.tmp`, buffer, { mode: 0o600 }); renameSync(`${p.bin}.tmp`, p.bin);
    writeFileSync(`${p.meta}.tmp`, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 }); renameSync(`${p.meta}.tmp`, p.meta);
    return meta;
  }
  /** Sidecar plus the image path, or null when either is missing or they disagree. */
  get(target, version) {
    const p = this.paths(target, version);
    if (!p || !existsSync(p.bin) || !existsSync(p.meta)) return null;
    let meta; try { meta = JSON.parse(readFileSync(p.meta, 'utf8')); } catch { return null; }
    if (!meta || meta.target !== target || meta.version !== version || meta.size !== statSync(p.bin).size || !/^[a-f0-9]{64}$/.test(meta.sha256 ?? '')) return null;
    return { path: p.bin, ...meta };
  }
  list() {
    const images = [];
    for (const target of Object.keys(FIRMWARE_TARGETS)) {
      const dir = path.join(this.directory, target);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        const version = name.endsWith('.json') ? name.slice(0, -5) : null, image = version && this.get(target, version);
        if (image) { const { path: _, ...meta } = image; images.push(meta); }
      }
    }
    return images;
  }
  remove(target, version) {
    const p = this.paths(target, version);
    if (!p || !existsSync(p.bin)) return false;
    unlinkSync(p.bin);
    if (existsSync(p.meta)) unlinkSync(p.meta);
    return true;
  }
}
