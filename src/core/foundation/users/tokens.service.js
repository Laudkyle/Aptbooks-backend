const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../../../config/env");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

function sha256(input) {
  if (!input) {
    console.error('sha256 called with falsy input:', input);
    throw new Error('sha256: input cannot be undefined or null');
  }
  return crypto.createHash("sha256").update(input).digest("hex");
}


function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older Node: 16 bytes -> uuidv4-ish
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function jwtOptions() {
  const opts = {};
  if (env.JWT_ISSUER) opts.issuer = env.JWT_ISSUER;
  if (env.JWT_AUDIENCE) opts.audience = env.JWT_AUDIENCE;
  return opts;
}

function signAccessToken({ userId, organizationId, email }) {
  return jwt.sign(
    { id: userId, organization_id: organizationId, email, typ: "access" },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN, ...jwtOptions() }
  );
}

function signRefreshToken({ userId, organizationId, email, familyId }) {
  const jti = uuid();
  const fid = familyId || uuid();
  const token = jwt.sign(
    { sub: userId, organization_id: organizationId, email, jti, fid, typ: "refresh" },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN, ...jwtOptions() }
  );
  const decoded = jwt.decode(token);
  const expMs = decoded?.exp ? decoded.exp * 1000 : (Date.now() + 30 * 24 * 3600 * 1000);
  return { token, jti, familyId: fid, expiresAt: new Date(expMs) };
}

async function persistRefreshToken({ organizationId, userId, familyId, tokenJti, token, expiresAt, ip, userAgent }) {
  const tokenHash = sha256(token);

  await pool.query(
    `INSERT INTO refresh_tokens
      (organization_id, user_id, family_id, token_jti, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [organizationId, userId, familyId, tokenJti, tokenHash, expiresAt, ip || null, userAgent || null]
  );

  return { tokenHash };
}

async function revokeRefreshTokenByJti({ jti, organizationId, userId, reason = null }) {
  // reason reserved for future audit/fields
  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens
       SET revoked_at = now()
     WHERE token_jti=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL`,
    [jti, organizationId, userId]
  );
  return rowCount > 0;
}

async function revokeRefreshTokenFamily({ familyId, organizationId, userId }) {
  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens
       SET revoked_at = now()
     WHERE family_id=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL`,
    [familyId, organizationId, userId]
  );
  return rowCount;
}

/**
 * Revoke all refresh tokens for a specific user in an organization
 * Useful for logout all devices, security incidents, or account deactivation
 */
async function revokeAllRefreshTokensForUser({ organizationId, userId, reason = null }) {
  const { rowCount } = await pool.query(
    `UPDATE refresh_tokens
       SET revoked_at = now(),
           revoke_reason = $3
     WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
    [organizationId, userId, reason || null]
  );
  
  return rowCount;
}

/**
 * Revoke all refresh tokens except the current one
 * Useful for "logout other devices" functionality
 */
async function revokeAllOtherRefreshTokens({ organizationId, userId, exceptJti = null, exceptFamilyId = null }) {
  let query = `UPDATE refresh_tokens SET revoked_at = now() WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL`;
  const params = [organizationId, userId];
  
  if (exceptJti) {
    query += ` AND token_jti != $${params.length + 1}`;
    params.push(exceptJti);
  }
  
  if (exceptFamilyId) {
    query += ` AND family_id != $${params.length + 1}`;
    params.push(exceptFamilyId);
  }
  
  const { rowCount } = await pool.query(query, params);
  
  console.log(`Revoked ${rowCount} other refresh tokens for user ${userId} (except: ${exceptJti || exceptFamilyId || 'none'})`);
  return rowCount;
}

/**
 * Get active refresh tokens for a user (for security audit/management)
 */
async function getActiveRefreshTokens({ organizationId, userId, limit = 100 }) {
  const { rows } = await pool.query(
    `SELECT 
        token_jti, 
        family_id, 
        ip, 
        user_agent, 
        created_at, 
        expires_at,
        revoked_at,
        replaced_by_jti,
        revoke_reason
     FROM refresh_tokens
     WHERE organization_id=$1 AND user_id=$2
     ORDER BY created_at DESC
     LIMIT $3`,
    [organizationId, userId, limit]
  );
  
  return rows;
}

/**
 * Clean up expired refresh tokens (cron job)
 */
async function cleanupExpiredRefreshTokens(batchSize = 1000) {
  const { rowCount } = await pool.query(
    `DELETE FROM refresh_tokens
     WHERE id IN (
       SELECT id
       FROM refresh_tokens
       WHERE expires_at < now() - INTERVAL '7 days' -- Keep expired tokens for a week for audit
          OR (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '30 days') -- Clean up old revoked tokens
       ORDER BY created_at ASC
       LIMIT $1
     )`,
    [batchSize]
  );

  return rowCount;
}


async function rotateRefreshToken({ token }) {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET, jwtOptions());
  } catch (e) {
    throw new AppError(401, "Invalid refresh token");
  }

  if (payload?.typ !== "refresh") throw new AppError(401, "Invalid refresh token");

  const userId = payload.sub;
  const organizationId = payload.organization_id;
  const email = payload.email;
  const jti = payload.jti;
  const familyId = payload.fid;

  if (!userId || !organizationId || !jti || !familyId) throw new AppError(401, "Invalid refresh token");

  // Fetch token record by jti
  const { rows } = await pool.query(
    `SELECT token_jti, family_id, revoked_at, replaced_by_jti, expires_at
       FROM refresh_tokens
      WHERE token_jti=$1 AND organization_id=$2 AND user_id=$3`,
    [jti, organizationId, userId]
  );

  if (!rows.length) throw new AppError(401, "Invalid refresh token");

  const rec = rows[0];

  // Expired?
  if (new Date(rec.expires_at).getTime() <= Date.now()) {
    throw new AppError(401, "Refresh token expired");
  }

  // If token already rotated/replaced, this is likely reuse -> revoke the whole family
  if (rec.replaced_by_jti) {
    await revokeRefreshTokenFamily({ familyId, organizationId, userId });
    throw new AppError(401, "Refresh token reuse detected");
  }

  if (rec.revoked_at) throw new AppError(401, "Refresh token revoked");

  // Rotate: mint new refresh token (same family) + revoke old token and mark replacement
   // Rotate: mint new refresh token (same family) + revoke old token and mark replacement
  const next = signRefreshToken({ userId, organizationId, email, familyId });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Insert new token
    await client.query(
      `INSERT INTO refresh_tokens
        (organization_id, user_id, family_id, token_jti, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [organizationId, userId, next.familyId, next.jti, sha256(next.token), next.expiresAt]
    );

    // Mark old token as replaced and revoke it (prevents reuse)
    await client.query(
      `UPDATE refresh_tokens
          SET replaced_by_jti=$1, revoked_at=now()
        WHERE token_jti=$2 AND organization_id=$3 AND user_id=$4 AND revoked_at IS NULL`,
      [next.jti, jti, organizationId, userId]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const accessToken = signAccessToken({ userId, organizationId, email });

  return { accessToken, refreshToken: next.token, organizationId, userId, email, familyId: next.familyId };
}

module.exports = {
  sha256,
  uuid,
  signAccessToken,
  signRefreshToken,
  persistRefreshToken,
  revokeRefreshTokenByJti,
  revokeRefreshTokenFamily, 
   revokeAllRefreshTokensForUser,
    revokeAllOtherRefreshTokens,
  getActiveRefreshTokens,
  cleanupExpiredRefreshTokens,
  rotateRefreshToken
};
