const crypto = require("crypto");

// Minimal RFC6238 TOTP implementation (SHA1, 30s step, 6 digits)

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(str) {
  const clean = String(str || "").toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0;i + 8 <= bits.length;i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function base32Encode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let bits = "";
  for (const byte of b) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0;i < bits.length;i += 5) {
    const chunk = bits.slice(i, i + 5);
    if (chunk.length < 5) break;
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function generateSecretBase32(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString();
  return code.padStart(6, "0");
}

function totp(secretBase32, { timeStepSeconds = 30, t = Date.now(), window = 1 } = {}) {
  const counter = Math.floor(t / 1000 / timeStepSeconds);
  // allow small window
  const codes = [];
  for (let w = -window;w <= window;w += 1) {
    codes.push(hotp(secretBase32, counter + w));
  }
  return codes;
}

function verifyTotp(secretBase32, token, opts) {
  const clean = String(token || "").replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(clean)) return false;
  return totp(secretBase32, opts).includes(clean);
}

function buildOtpauthUrl({ issuer, email, secret }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const qs = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${qs.toString()}`;
}

module.exports = {
  generateSecretBase32,
  verifyTotp,
  buildOtpauthUrl
};
