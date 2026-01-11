const router = require("express").Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");
const {
  signAccessToken,
  signRefreshToken,
  persistRefreshToken,
  rotateRefreshToken,
  revokeRefreshTokenByJti,
  revokeRefreshTokenFamily
} = require("./tokens.service");

// Minimal in-memory rate limiter (per IP + email) for the login endpoint.
// For horizontally scaled deployments, replace with a shared store (e.g., Redis).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function rateLimitKey(req, email) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  return `${ip}:${String(email || "").toLowerCase()}`;
}

function assertNotRateLimited(req, email) {
  const key = rateLimitKey(req, email);
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, resetAt: now + WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + WINDOW_MS;
  }

  entry.count += 1;
  attempts.set(key, entry);

  if (entry.count > MAX_ATTEMPTS) {
    throw new AppError(429, "Too many login attempts. Please try again later.");
  }
}

function clearAttempts(req, email) {
  attempts.delete(rateLimitKey(req, email));
}

function getRefreshTokenFromRequest(req) {
  // 1) body
  const bodyToken = req.body?.refreshToken;
  if (bodyToken && typeof bodyToken === "string") return bodyToken;

  // 2) header
  const hdr = req.headers["x-refresh-token"];
  if (hdr && typeof hdr === "string") return hdr;

  // 3) cookie (manual parse to avoid external dependency)
  const cookieHeader = req.headers["cookie"];
  if (cookieHeader && typeof cookieHeader === "string") {
    const parts = cookieHeader.split(";").map((p) => p.trim());
    for (const p of parts) {
      if (p.startsWith(`${env.REFRESH_TOKEN_COOKIE_NAME}=`)) {
        return decodeURIComponent(p.substring(env.REFRESH_TOKEN_COOKIE_NAME.length + 1));
      }
    }
  }

  return null;
}

function setRefreshCookie(res, token) {
  if (!env.REFRESH_TOKEN_USE_COOKIE) return;

  const opts = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: "/auth/refresh"
  };
  if (env.COOKIE_DOMAIN) opts.domain = env.COOKIE_DOMAIN;

  // Express has res.cookie built-in; no cookie-parser required for setting.
  res.cookie(env.REFRESH_TOKEN_COOKIE_NAME, token, opts);
}

function clearRefreshCookie(res) {
  if (!env.REFRESH_TOKEN_USE_COOKIE) return;
  const opts = { path: "/auth/refresh" };
  if (env.COOKIE_DOMAIN) opts.domain = env.COOKIE_DOMAIN;
  res.clearCookie(env.REFRESH_TOKEN_COOKIE_NAME, opts);
}
}


function jwtVerifyOpts() {
  const opts = {};
  if (env.JWT_ISSUER) opts.issuer = env.JWT_ISSUER;
  if (env.JWT_AUDIENCE) opts.audience = env.JWT_AUDIENCE;
  return opts;
}

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw new AppError(400, "email and password required");

    assertNotRateLimited(req, email);

    const { rows } = await pool.query(
      `SELECT id, organization_id, password_hash, status, is_system FROM users WHERE email=$1`,
      [email]
    );

    if (!rows.length) {
      await writeAudit({
        organizationId: null,
        actorUserId: null,
        action: "auth.login_failed",
        entityType: "users",
        entityId: null,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: { email, reason: "not_found" }
      });
      throw new AppError(401, "Invalid credentials");
    }

    const user = rows[0];

    if (user.is_system) throw new AppError(403, "System user cannot login");
    if (user.status !== "active") throw new AppError(403, "User is not active");

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await writeAudit({
        organizationId: user.organization_id,
        actorUserId: user.id,
        action: "auth.login_failed",
        entityType: "users",
        entityId: user.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: { reason: "bad_password" }
      });
      throw new AppError(401, "Invalid credentials");
    }

    const accessToken = signAccessToken({
      userId: user.id,
      organizationId: user.organization_id,
      email
    });

    const refresh = signRefreshToken({
      userId: user.id,
      organizationId: user.organization_id,
      email
    });

    await persistRefreshToken({
      organizationId: user.organization_id,
      userId: user.id,
      familyId: refresh.familyId,
      jti: refresh.jti,
      token: refresh.token,
      expiresAt: refresh.expiresAt,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent
    });

    setRefreshCookie(res, refresh.token);

    clearAttempts(req, email);

    await writeAudit({
      organizationId: user.organization_id,
      actorUserId: user.id,
      action: "auth.login_success",
      entityType: "users",
      entityId: user.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { email }
    });

    res.json({
      accessToken,
      refreshToken: env.REFRESH_TOKEN_USE_COOKIE ? undefined : refresh.token
    });
  } catch (e) { next(e); }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const rt = getRefreshTokenFromRequest(req);
    if (!rt) throw new AppError(400, "refreshToken required");

    const rotated = await rotateRefreshToken({ token: rt });

    setRefreshCookie(res, rotated.refreshToken);

    await writeAudit({
      organizationId: rotated.organizationId,
      actorUserId: rotated.userId,
      action: "auth.refresh_success",
      entityType: "users",
      entityId: rotated.userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { familyId: rotated.familyId }
    });

    res.json({
      accessToken: rotated.accessToken,
      refreshToken: env.REFRESH_TOKEN_USE_COOKIE ? undefined : rotated.refreshToken
    });
  } catch (e) { next(e); }
});

router.post("/logout", async (req, res, next) => {
  try {
    const rt = getRefreshTokenFromRequest(req);
    if (!rt) throw new AppError(400, "refreshToken required");

    let payload;
    try {
      payload = jwt.verify(rt, env.JWT_REFRESH_SECRET, (env.JWT_ISSUER||env.JWT_AUDIENCE)?{ issuer: env.JWT_ISSUER || undefined, audience: env.JWT_AUDIENCE || undefined }: undefined);
    } catch (e) {
      // Even if token is invalid, clear cookie for client hygiene
      clearRefreshCookie(res);
      throw new AppError(401, "Invalid refresh token");
    }

    if (payload?.typ !== "refresh") throw new AppError(401, "Invalid refresh token");

    const userId = payload.sub;
    const organizationId = payload.organization_id;
    const jti = payload.jti;

    if (!userId || !organizationId || !jti) throw new AppError(401, "Invalid refresh token");

    await revokeRefreshTokenByJti({ jti, organizationId, userId, reason: "logout" });

    clearRefreshCookie(res);

    await writeAudit({
      organizationId,
      actorUserId: userId,
      action: "auth.logout",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: {}
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/logout-all", async (req, res, next) => {
  try {
    const rt = getRefreshTokenFromRequest(req);
    if (!rt) throw new AppError(400, "refreshToken required");

    let payload;
    try {
      payload = jwt.verify(rt, env.JWT_REFRESH_SECRET, (env.JWT_ISSUER||env.JWT_AUDIENCE)?{ issuer: env.JWT_ISSUER || undefined, audience: env.JWT_AUDIENCE || undefined }: undefined);
    } catch (e) {
      clearRefreshCookie(res);
      throw new AppError(401, "Invalid refresh token");
    }

    if (payload?.typ !== "refresh") throw new AppError(401, "Invalid refresh token");

    const userId = payload.sub;
    const organizationId = payload.organization_id;
    const familyId = payload.fid;

    if (!userId || !organizationId || !familyId) throw new AppError(401, "Invalid refresh token");

    await revokeRefreshTokenFamily({ familyId, organizationId, userId });

    clearRefreshCookie(res);

    await writeAudit({
      organizationId,
      actorUserId: userId,
      action: "auth.logout_all",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { familyId }
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
