require("dotenv").config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const env = {
  PORT: process.env.PORT || 3000,
  DATABASE_URL: must("DATABASE_URL"),
  JWT_SECRET: must("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "12h",
  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS || "12", 10),

  // Tier 10 (Documents & Workflow)
  // Root directory for local filesystem storage.
  // In production this should point to a persistent volume.
  FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT || "storage",
  FILE_UPLOAD_MAX_MB: parseInt(process.env.FILE_UPLOAD_MAX_MB || "50", 10)
};

module.exports = { env };
