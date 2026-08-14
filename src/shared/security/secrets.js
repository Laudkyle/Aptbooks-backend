const crypto = require("crypto");
const { env } = require("../../config/env");
const { AppError } = require("../errors/AppError");

const PREFIX = "enc:v1:";

function decodeConfiguredKey(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  let key;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, "hex");
    else key = Buffer.from(value, "base64");
  } catch (_) {
    key = null;
  }

  if (!key || key.length !== 32) {
    throw new AppError(500, "APP_SECRETS_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars or base64)");
  }
  return key;
}

function getSecretsKey() {
  const configured = decodeConfiguredKey(env.APP_SECRETS_ENCRYPTION_KEY);
  if (configured) return configured;

  // Keep local/dev installs usable without another required secret while still
  // avoiding plaintext-at-rest. Production must configure a distinct key.
  if (env.NODE_ENV === "production") {
    throw new AppError(500, "APP_SECRETS_ENCRYPTION_KEY is required in production");
  }

  return crypto
    .createHash("sha256")
    .update(`aptbooks:secrets:v1:${env.JWT_SECRET}`)
    .digest();
}

function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encryptSecret(value, { context = "aptbooks-secret" } = {}) {
  if (value === null || value === undefined || value === "") return value;
  const plaintext = String(value);
  if (isEncryptedSecret(plaintext)) return plaintext;

  const key = getSecretsKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(context), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptSecret(value, { context = "aptbooks-secret", allowPlaintextLegacy = true } = {}) {
  if (value === null || value === undefined || value === "") return value;
  const encoded = String(value);

  if (!isEncryptedSecret(encoded)) {
    if (allowPlaintextLegacy) return encoded;
    throw new AppError(500, "Stored secret is not encrypted");
  }

  const parts = encoded.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new AppError(500, "Stored secret is malformed");

  try {
    const [ivB64, tagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getSecretsKey(), iv);
    decipher.setAAD(Buffer.from(String(context), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(500, "Unable to decrypt stored secret");
  }
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
};
