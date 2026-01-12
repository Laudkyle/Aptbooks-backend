const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../../../config/env");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

function sha256(input) {
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

async function persistRefreshToken({ organizationId, userId, familyId, jti, token, expiresAt, ip, userAgent }) {
  const tokenHash = sha256(token);

  await pool.query(
    `INSERT INTO refresh_tokens
      (organization_id, user_id, family_id, token_jti, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [organizationId, userId, familyId, jti, tokenHash, expiresAt, ip || null, userAgent || null]
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
  await pool.query(
    `UPDATE refresh_tokens
       SET revoked_at = now()
     WHERE family_id=$1 AND organization_id=$2 AND user_id=$3 AND revoked_at IS NULL`,
    [familyId, organizationId, userId]
  );
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
  const next = signRefreshToken({ userId, organizationId, email, familyId });

  await pool.query("BEGIN");
  try {
    // Insert new token
    await persistRefreshToken({
      organizationId,
      userId,
      familyId: next.familyId,
      jti: next.jti,
      token: next.token,
      expiresAt: next.expiresAt
    });

    // Mark old token as replaced and revoke it (prevents reuse)
    await pool.query(
      `UPDATE refresh_tokens
          SET replaced_by_jti=$1, revoked_at=now()
        WHERE token_jti=$2 AND organization_id=$3 AND user_id=$4 AND revoked_at IS NULL`,
      [next.jti, jti, organizationId, userId]
    );

    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
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
  rotateRefreshToken
};
