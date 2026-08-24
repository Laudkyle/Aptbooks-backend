require('dotenv').config();

function must(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return String(raw).toLowerCase() === 'true';
}

function csv(name) {
  return String(process.env[name] || '').split(',').map((v) => v.trim()).filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const env = {
  NODE_ENV: nodeEnv,
  TRUST_PROXY: bool('TRUST_PROXY', false),
  PORT: process.env.PORT || 3000,

  SERVICE_NAME: process.env.SERVICE_NAME || 'aptbooks-backend',
  APP_VERSION: process.env.APP_VERSION || process.env.RELEASE_VERSION || 'dev',
  METRICS_ENABLED: bool('METRICS_ENABLED', true),
  METRICS_PATH: process.env.METRICS_PATH || '/metrics',
  METRICS_BEARER_TOKEN: process.env.METRICS_BEARER_TOKEN || '',
  TRACE_SAMPLE_RATIO: Number.parseFloat(process.env.TRACE_SAMPLE_RATIO || (isProduction ? '0.1' : '1')),
  SLOW_REQUEST_MS: parseInt(process.env.SLOW_REQUEST_MS || '2000', 10),
  SLOW_DB_QUERY_MS: parseInt(process.env.SLOW_DB_QUERY_MS || '1000', 10),
  SHUTDOWN_GRACE_MS: parseInt(process.env.SHUTDOWN_GRACE_MS || '30000', 10),
  SLO_AVAILABILITY_TARGET: Number.parseFloat(process.env.SLO_AVAILABILITY_TARGET || '99.9'),
  SLO_P95_LATENCY_MS: parseInt(process.env.SLO_P95_LATENCY_MS || '1000', 10),

  DATABASE_URL: must('DATABASE_URL'),
  DATABASE_MIGRATOR_URL: process.env.DATABASE_MIGRATOR_URL || '',
  PG_SSL: bool('PG_SSL', isProduction),
  PG_SSL_REJECT_UNAUTHORIZED: bool('PG_SSL_REJECT_UNAUTHORIZED', true),
  PG_POOL_MAX: parseInt(process.env.PG_POOL_MAX || '10', 10),
  PG_POOL_IDLE_TIMEOUT_MS: parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS || '30000', 10),
  PG_POOL_CONNECTION_TIMEOUT_MS: parseInt(process.env.PG_POOL_CONNECTION_TIMEOUT_MS || '5000', 10),
  PG_STATEMENT_TIMEOUT_MS: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '30000', 10),
  RLS_ENABLED: bool('RLS_ENABLED', isProduction),
  DB_ENFORCE_LEAST_PRIVILEGE: bool('DB_ENFORCE_LEAST_PRIVILEGE', isProduction),

  JWT_SECRET: must('JWT_SECRET'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "15m",
  JWT_ISSUER: process.env.JWT_ISSUER || '',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || '',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || must('JWT_SECRET'),
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '30d',

  REFRESH_TOKEN_USE_COOKIE: bool('REFRESH_TOKEN_USE_COOKIE', true),
  REFRESH_TOKEN_COOKIE_NAME: process.env.REFRESH_TOKEN_COOKIE_NAME || 'aptbooks_rt',
  COOKIE_SECURE: bool('COOKIE_SECURE', isProduction),
  COOKIE_SAMESITE: String(process.env.COOKIE_SAMESITE || 'lax').toLowerCase(),
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || '',

  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
  APP_SECRETS_ENCRYPTION_KEY: process.env.APP_SECRETS_ENCRYPTION_KEY || '',
  PUBLIC_REGISTRATION_ENABLED: bool('PUBLIC_REGISTRATION_ENABLED', !isProduction),

  PASSWORD_RESET_TOKEN_TTL_MINUTES: parseInt(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || '30', 10),
  PASSWORD_RESET_TOKEN_PEPPER: process.env.PASSWORD_RESET_TOKEN_PEPPER || (process.env.JWT_SECRET || ''),
  RETURN_RESET_TOKEN_IN_RESPONSE: bool('RETURN_RESET_TOKEN_IN_RESPONSE', !isProduction),

  CORS_ALLOWED_ORIGINS: csv('CORS_ALLOWED_ORIGINS'),
  CORS_ALLOW_CREDENTIALS: bool('CORS_ALLOW_CREDENTIALS', isProduction),

  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '300', 10),
  RATE_LIMIT_STORE: String(process.env.RATE_LIMIT_STORE || (isProduction ? 'postgres' : 'memory')).toLowerCase(),
  RATE_LIMIT_FAIL_CLOSED: bool('RATE_LIMIT_FAIL_CLOSED', isProduction),
  AUTH_RATE_LIMIT_WINDOW_MS: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000', 10),
  AUTH_RATE_LIMIT_MAX: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '30', 10),
  LOGIN_RATE_LIMIT_MAX: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '10', 10),
  PASSWORD_RESET_RATE_LIMIT_MAX: parseInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX || '5', 10),

  EXPOSE_SWAGGER: bool('EXPOSE_SWAGGER', !isProduction),
  EXPOSE_INTERNAL_UTILITIES: bool('EXPOSE_INTERNAL_UTILITIES', !isProduction),

  FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT || 'storage',
  FILE_UPLOAD_MAX_MB: parseInt(process.env.FILE_UPLOAD_MAX_MB || '50', 10),
  ENTITY_RESOLVER_STRICT: bool('ENTITY_RESOLVER_STRICT', false),

  MIGRATION_LOCK_ID: process.env.MIGRATION_LOCK_ID || '874230519223',
  ALLOW_DESTRUCTIVE_MIGRATIONS: bool('ALLOW_DESTRUCTIVE_MIGRATIONS', false),

  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY || '',
  PAYSTACK_PUBLIC_KEY: process.env.PAYSTACK_PUBLIC_KEY || '',
  PAYSTACK_BASE_URL: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',

  MTN_MOMO_BASE_URL: process.env.MTN_MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com',
  MTN_MOMO_SUBSCRIPTION_KEY: process.env.MTN_MOMO_SUBSCRIPTION_KEY || '',
  MTN_MOMO_API_USER_ID: process.env.MTN_MOMO_API_USER_ID || '',
  MTN_MOMO_API_KEY: process.env.MTN_MOMO_API_KEY || '',
  MTN_MOMO_TARGET_ENV: process.env.MTN_MOMO_TARGET_ENV || 'sandbox',
  MTN_MOMO_CALLBACK_URL: process.env.MTN_MOMO_CALLBACK_URL || '',
};

function byteLengthAtLeast(value, bytes) {
  return Buffer.byteLength(String(value || ''), 'utf8') >= bytes;
}

function decodeEncryptionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    const decoded = Buffer.from(raw, 'base64');
    return decoded.length ? decoded : null;
  } catch (_) {
    return null;
  }
}

function validateRuntimeEnv() {
  if (!['memory', 'postgres'].includes(env.RATE_LIMIT_STORE)) {
    throw new Error("RATE_LIMIT_STORE must be either 'memory' or 'postgres'");
  }
  if (!['lax', 'strict', 'none'].includes(env.COOKIE_SAMESITE)) {
    throw new Error('COOKIE_SAMESITE must be one of: lax, strict, none');
  }
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true when COOKIE_SAMESITE=none');
  }
  if (!Number.isInteger(env.BCRYPT_ROUNDS) || env.BCRYPT_ROUNDS < 12) {
    throw new Error('BCRYPT_ROUNDS must be at least 12');
  }

  if (!Number.isFinite(env.TRACE_SAMPLE_RATIO) || env.TRACE_SAMPLE_RATIO < 0 || env.TRACE_SAMPLE_RATIO > 1) {
    throw new Error('TRACE_SAMPLE_RATIO must be between 0 and 1');
  }
  if (!env.METRICS_PATH.startsWith('/')) throw new Error('METRICS_PATH must start with /');
  if (!Number.isInteger(env.SHUTDOWN_GRACE_MS) || env.SHUTDOWN_GRACE_MS < 1000) throw new Error('SHUTDOWN_GRACE_MS must be at least 1000');
  if (!Number.isFinite(env.SLO_AVAILABILITY_TARGET) || env.SLO_AVAILABILITY_TARGET <= 0 || env.SLO_AVAILABILITY_TARGET > 100) {
    throw new Error('SLO_AVAILABILITY_TARGET must be within (0, 100]');
  }

  if (env.NODE_ENV !== 'production') return;

  if (!env.CORS_ALLOWED_ORIGINS.length) throw new Error('CORS_ALLOWED_ORIGINS must be set in production');
  if (!env.CORS_ALLOW_CREDENTIALS) throw new Error('CORS_ALLOW_CREDENTIALS must be true in production cookie-session mode');
  if (!env.REFRESH_TOKEN_USE_COOKIE) throw new Error('REFRESH_TOKEN_USE_COOKIE must be true in production');
  if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  if (!env.PG_SSL) throw new Error('PG_SSL must be true in production');
  if (!env.RLS_ENABLED) throw new Error('RLS_ENABLED must be true in production');
  if (env.RATE_LIMIT_STORE !== 'postgres') throw new Error('RATE_LIMIT_STORE must be postgres in production');
  if (!env.RATE_LIMIT_FAIL_CLOSED) throw new Error('RATE_LIMIT_FAIL_CLOSED must be true in production');
  if (!env.JWT_ISSUER || !env.JWT_AUDIENCE) throw new Error('JWT_ISSUER and JWT_AUDIENCE must be set in production');
  if (!byteLengthAtLeast(env.JWT_SECRET, 32)) throw new Error('JWT_SECRET must contain at least 32 bytes in production');
  if (!byteLengthAtLeast(env.JWT_REFRESH_SECRET, 32)) throw new Error('JWT_REFRESH_SECRET must contain at least 32 bytes in production');
  if (env.JWT_REFRESH_SECRET === env.JWT_SECRET) throw new Error('JWT_REFRESH_SECRET must be different from JWT_SECRET in production');
  if (!byteLengthAtLeast(env.PASSWORD_RESET_TOKEN_PEPPER, 32)) throw new Error('PASSWORD_RESET_TOKEN_PEPPER must contain at least 32 bytes in production');
  if ([env.JWT_SECRET, env.JWT_REFRESH_SECRET].includes(env.PASSWORD_RESET_TOKEN_PEPPER)) {
    throw new Error('PASSWORD_RESET_TOKEN_PEPPER must be distinct from JWT secrets in production');
  }
  if (env.RETURN_RESET_TOKEN_IN_RESPONSE) throw new Error('RETURN_RESET_TOKEN_IN_RESPONSE must be false in production');
  if (!env.DATABASE_MIGRATOR_URL) throw new Error('DATABASE_MIGRATOR_URL must be set in production and use a role distinct from the runtime app role');

  if (!env.METRICS_ENABLED) throw new Error('METRICS_ENABLED must be true in production');
  if (!env.APP_VERSION || env.APP_VERSION === 'dev') throw new Error('APP_VERSION must identify the deployed release in production');

  if (env.METRICS_ENABLED && !byteLengthAtLeast(env.METRICS_BEARER_TOKEN, 32)) {
    throw new Error('METRICS_BEARER_TOKEN must contain at least 32 bytes when metrics are enabled in production');
  }

  const encryptionKey = decodeEncryptionKey(env.APP_SECRETS_ENCRYPTION_KEY);
  if (!encryptionKey || encryptionKey.length !== 32) {
    throw new Error('APP_SECRETS_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars or base64)');
  }
  if ([env.JWT_SECRET, env.JWT_REFRESH_SECRET, env.PASSWORD_RESET_TOKEN_PEPPER].includes(String(env.APP_SECRETS_ENCRYPTION_KEY).trim())) {
    throw new Error('APP_SECRETS_ENCRYPTION_KEY must be distinct from authentication secrets');
  }
}

module.exports = { env, validateRuntimeEnv };
