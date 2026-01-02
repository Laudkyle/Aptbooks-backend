const router = require("express").Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");

// Minimal in-memory rate limiter (per IP + email).
// For horizontally scaled deployments, replace with a shared store (e.g., Redis).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function rateLimitKey(req, email) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  return `${ip}::${String(email || "").toLowerCase()}`;
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

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw new AppError(400, "email and password required");

    assertNotRateLimited(req, email);

    const { rows } = await pool.query(
      `SELECT id, organization_id, password_hash, status, is_system FROM users WHERE email=$1`,
      [email]
    );

    // Do not reveal which part failed.
    if (!rows.length || rows[0].status !== "active" || rows[0].is_system) {
      if (rows.length) {
        await writeAudit({
          organizationId: rows[0].organization_id,
          actorUserId: rows[0].id,
          action: "auth.login_failed",
          entityType: "users",
          entityId: rows[0].id,
          ip: req.audit?.ip,
          userAgent: req.audit?.userAgent,
          after: { reason: "invalid_credentials_or_disallowed_user" }
        });
      }
      throw new AppError(401, "Invalid credentials");
    }

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) {
      await writeAudit({
        organizationId: rows[0].organization_id,
        actorUserId: rows[0].id,
        action: "auth.login_failed",
        entityType: "users",
        entityId: rows[0].id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: { reason: "bad_password" }
      });
      throw new AppError(401, "Invalid credentials");
    }

    const token = jwt.sign(
      { id: rows[0].id, organization_id: rows[0].organization_id, email },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    clearAttempts(req, email);

    await writeAudit({
      organizationId: rows[0].organization_id,
      actorUserId: rows[0].id,
      action: "auth.login_success",
      entityType: "users",
      entityId: rows[0].id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { email }
    });

    res.json({ accessToken: token });
  } catch (e) { next(e); }
});

module.exports = router;
