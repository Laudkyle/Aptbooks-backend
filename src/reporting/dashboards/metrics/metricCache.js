const crypto = require('crypto');

const cache = new Map();
const MAX_ENTRIES = 2000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function keyFor(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(parts))).digest('hex');
}

function get(parts) {
  const key = keyFor(parts);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function set(parts, value, ttlMs) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(keyFor(parts), { value, expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || 60000) });
  return value;
}

function clear() { cache.clear(); }

module.exports = { get, set, clear };
