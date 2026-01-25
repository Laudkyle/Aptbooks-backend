const crypto = require("crypto");

function generatePrefix() {
  // short prefix for indexing / log redaction
  return crypto.randomBytes(6).toString("hex");// 12 chars
}

function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function makeApiKey(prefix, secret) {
  return `ak_${prefix}_${secret}`;
}

function parseApiKey(apiKey) {
  const s = String(apiKey || "").trim();
  const m = s.match(/^ak_([0-9a-f]{12})_([0-9a-f]{64})$/i);
  if (!m) return null;
  return { prefix: m[1], secret: m[2] };
}

module.exports = { generatePrefix, generateSecret, hashSecret, makeApiKey, parseApiKey };