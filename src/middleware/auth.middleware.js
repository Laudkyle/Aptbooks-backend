const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { AppError } = require("../shared/errors/AppError");
const { pool } = require("../db/pool");
const { parseApiKey, hashSecret } = require("../shared/security/apiKeys");

function verifyOptions() {
  const opts = {};
  if (env.JWT_ISSUER) opts.issuer = env.JWT_ISSUER;
  if (env.JWT_AUDIENCE) opts.audience = env.JWT_AUDIENCE;
  return opts;
}

function authRequired(req, _res, next) {
  // 1) API key authentication (service-to-service / admin automations)
  const apiKeyHeader = req.headers["x-api-key"];
  if (apiKeyHeader && typeof apiKeyHeader === "string") {
    const parsed = parseApiKey(apiKeyHeader);
    if (!parsed) return next(new AppError(401, "Invalid API key format"));
    (async () => {
      try {
        const { rows } = await pool.query(
          `SELECT id, organization_id, user_id, secret_hash, is_active FROM api_keys WHERE prefix=$1 LIMIT 1`,
          [parsed.prefix]
        );
        if (!rows.length) throw new AppError(401, "Invalid API key");
        const rec = rows[0];
        if (!rec.is_active) throw new AppError(403, "API key revoked");
        if (hashSecret(parsed.secret) !== rec.secret_hash) throw new AppError(401, "Invalid API key");
        // Resolve user context (required for permission system)
        if (!rec.user_id) throw new AppError(403, "API key has no user context");
        const { rows: uRows } = await pool.query(
          `SELECT id, email, organization_id, status FROM users WHERE id=$1 AND organization_id=$2 LIMIT 1`,
          [rec.user_id, rec.organization_id]
        );
        if (!uRows.length) throw new AppError(401, "API key user not found");
        if (uRows[0].status !== "active") throw new AppError(403, "API key user is not active");
        req.user = { id: uRows[0].id, email: uRows[0].email, organization_id: uRows[0].organization_id, typ: "api_key" };
        return next();
      } catch (e) {
        return next(e);
      }
    })();
    return;
  }

  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return next(new AppError(401, "Missing bearer token"));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, verifyOptions());
    if (payload?.typ && payload.typ !== "access") {
      return next(new AppError(401, "Invalid token type"));
    }
    req.user = payload; // { id, organization_id, email }
    return next();
  } catch {
    return next(new AppError(401, "Invalid token"));
  }
}

module.exports = { authRequired };
