const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { AppError } = require("../shared/errors/AppError");
const { pool } = require("../db/pool");
const { parseApiKey, hashSecret } = require("../shared/security/apiKeys");
const { runWithTenant } = require("../shared/security/tenantContext");

function verifyOptions() {
  const opts = {};
  if (env.JWT_ISSUER) opts.issuer = env.JWT_ISSUER;
  if (env.JWT_AUDIENCE) opts.audience = env.JWT_AUDIENCE;
  return opts;
}

/**
 * Authentication is deliberately live-state aware. Access JWTs are short-lived,
 * but every request also verifies the user is still active, is still a member of
 * the token's organization, has not switched organization context, and has the
 * same auth_version that was embedded when the token was issued.
 */
async function authRequired(req, _res, next) {
  try {
    const apiKeyHeader = req.headers["x-api-key"];
    if (apiKeyHeader && typeof apiKeyHeader === "string") {
      const parsed = parseApiKey(apiKeyHeader);
      if (!parsed) throw new AppError(401, "Invalid API key format");
      const { rows } = await pool.query(
        `SELECT id, organization_id, user_id, secret_hash, is_active FROM api_keys WHERE prefix=$1 LIMIT 1`,
        [parsed.prefix]
      );
      if (!rows.length) throw new AppError(401, "Invalid API key");
      const rec = rows[0];
      if (!rec.is_active) throw new AppError(403, "API key revoked");
      if (hashSecret(parsed.secret) !== rec.secret_hash) throw new AppError(401, "Invalid API key");
      if (!rec.user_id) throw new AppError(403, "API key has no user context");
      const { rows: uRows } = await pool.query(
        `SELECT u.id, u.email, u.status
           FROM users u
           JOIN user_organizations uo ON uo.user_id=u.id AND uo.organization_id=$2
          WHERE u.id=$1 AND COALESCE(u.is_system,FALSE)=FALSE
          LIMIT 1`,
        [rec.user_id, rec.organization_id]
      );
      if (!uRows.length) throw new AppError(401, "API key user not found");
      if (uRows[0].status !== "active") throw new AppError(403, "API key user is not active");
      req.user = { id: uRows[0].id, email: uRows[0].email, organization_id: rec.organization_id, typ: "api_key" };
      return runWithTenant(rec.organization_id, () => next());
    }

    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) throw new AppError(401, "Missing bearer token");

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET, verifyOptions());
    } catch (_) {
      throw new AppError(401, "Invalid token");
    }
    if (payload?.typ && payload.typ !== "access") throw new AppError(401, "Invalid token type");
    if (!payload?.id || !payload?.organization_id || !Number.isInteger(Number(payload?.ver))) {
      throw new AppError(401, "Session must be renewed");
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.organization_id, u.status, u.is_system, u.auth_version
         FROM users u
         JOIN user_organizations uo
           ON uo.user_id=u.id AND uo.organization_id=$2
        WHERE u.id=$1
          AND u.organization_id=$2
        LIMIT 1`,
      [payload.id, payload.organization_id]
    );
    const user = rows[0];
    if (!user || user.is_system || user.status !== "active") {
      throw new AppError(401, "Session is no longer active");
    }
    if (Number(user.auth_version) !== Number(payload.ver)) {
      throw new AppError(401, "Session has been revoked");
    }

    req.user = {
      ...payload,
      id: user.id,
      email: user.email,
      organization_id: user.organization_id,
      auth_version: Number(user.auth_version),
    };
    return runWithTenant(user.organization_id, () => next());
  } catch (e) {
    return next(e instanceof AppError ? e : new AppError(401, "Invalid token"));
  }
}

module.exports = { authRequired };
