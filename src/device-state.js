// Transport contract, not a list of firmware features. Unknown keys survive.
// Read-only scalar snapshots; never use these values as commands or authority.
export function validDeviceState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1 ||
      typeof state.bootId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(state.bootId) ||
      ![state.sequence, state.uptimeMs, state.droppedUpdates].every(n => Number.isSafeInteger(n) && n >= 0) ||
      !state.values || typeof state.values !== 'object' || Array.isArray(state.values)) return false;
  const entries = Object.entries(state.values);
  return entries.length <= 64 && entries.every(([key, value]) => /^[A-Za-z][A-Za-z0-9_.-]{0,62}$/.test(key) &&
    !['constructor', 'prototype', '__proto__'].includes(key) &&
    (value === null || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) ||
      (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 128))) && Buffer.byteLength(JSON.stringify(state)) <= 4096;
}
