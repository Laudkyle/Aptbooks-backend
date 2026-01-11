require("dotenv").config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const env = {
  // Platform
  NODE_ENV: process.env.NODE_ENV || "development",
  TRUST_PROXY: (process.env.TRUST_PROXY || "false").toLowerCase() === "true",

  PORT: process.env.PORT || 3000,

  // Database / auth
  DATABASE_URL: must("DATABASE_URL"),

  // Postgres pool tuning (defaults are intentionally conservative)
  PG_POOL_MAX: parseInt(process.env.PG_POOL_MAX || "10", 10),
  PG_POOL_IDLE_TIMEOUT_MS: parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS || "30000", 10),
  PG_POOL_CONNECTION_TIMEOUT_MS: parseInt(process.env.PG_POOL_CONNECTION_TIMEOUT_MS || "5000", 10),
  // Optional server-side safety: set a statement timeout for all DB sessions (ms). 0 disables.
  PG_STATEMENT_TIMEOUT_MS: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "0", 10),
  JWT_SECRET: must("JWT_SECRET"),
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "12h",

  // Optional JWT claims enforcement
  JWT_ISSUER: process.env.JWT_ISSUER || "",
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || "",

  // Refresh token settings (A3)
  // In production, set JWT_REFRESH_SECRET to a distinct strong secret.
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || must("JWT_SECRET"),
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || "30d",

  // If true, refresh tokens are also set as an HttpOnly cookie.
  REFRESH_TOKEN_USE_COOKIE: (process.env.REFRESH_TOKEN_USE_COOKIE || "false").toLowerCase() === "true",
  REFRESH_TOKEN_COOKIE_NAME: process.env.REFRESH_TOKEN_COOKIE_NAME || "aptbooks_rt",
  COOKIE_SECURE: (process.env.COOKIE_SECURE || "false").toLowerCase() === "true",
  COOKIE_SAMESITE: process.env.COOKIE_SAMESITE || "lax", // lax|strict|none
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || "",

  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS || "12", 10),

  // CORS (comma-separated origins). In production you should set this explicitly.
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  CORS_ALLOW_CREDENTIALS: (process.env.CORS_ALLOW_CREDENTIALS || "false").toLowerCase() === "true",

  // Global rate limiting
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10), // 60s
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || "300", 10), // 300 req / min / IP

  // Auth rate limiting (additional layer; login endpoint also has its own limiter)
  AUTH_RATE_LIMIT_WINDOW_MS: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || "900000", 10), // 15m
  AUTH_RATE_LIMIT_MAX: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "50", 10), // 50 req / 15m / IP

  // Tier 10 (Documents & Workflow)
  // Root directory for local filesystem storage.
  // In production this should point to a persistent volume.
  FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT || "storage",
  FILE_UPLOAD_MAX_MB: parseInt(process.env.FILE_UPLOAD_MAX_MB || "50", 10),

  // Tier 10: Entity reference validation
  // When true, documents must link to a known entity_type and a real entity record.
  // When false, unknown entity_type values are allowed (no validation), but known types are validated.
  ENTITY_RESOLVER_STRICT: (process.env.ENTITY_RESOLVER_STRICT || "false").toLowerCase() === "true"
  ,

  // Migrations (A7)
  // Advisory lock ID used to prevent concurrent migration runs.
  MIGRATION_LOCK_ID: process.env.MIGRATION_LOCK_ID || "874230519223", // bigint as string
  // Destructive operations (e.g., schema reset) are blocked unless explicitly enabled.
  ALLOW_DESTRUCTIVE_MIGRATIONS: (process.env.ALLOW_DESTRUCTIVE_MIGRATIONS || "false").toLowerCase() === "true"
};

module.exports = { env };
