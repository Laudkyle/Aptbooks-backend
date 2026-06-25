const router = require("express").Router();
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const {
  initializeOrganizationDefaults,
} = require("../organizations/organizations.service");

const jwt = require("jsonwebtoken");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");
const {
  verifyTotp,
  generateSecretBase32,
  buildOtpauthUrl,
} = require("../../../shared/security/totp");
const {
  signAccessToken,
  signRefreshToken,
  persistRefreshToken,
  rotateRefreshToken,
  revokeRefreshTokenByJti,
  revokeRefreshTokenFamily,
  revokeAllRefreshTokensForUser,
} = require("./tokens.service");

// Minimal in-memory rate limiter (per IP + email) for the login endpoint.
// For horizontally scaled deployments, replace with a shared store (e.g., Redis).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function rateLimitKey(req, email) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
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
        return decodeURIComponent(
          p.substring(env.REFRESH_TOKEN_COOKIE_NAME.length + 1),
        );
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
    path: "/auth/refresh",
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

function jwtVerifyOpts() {
  const opts = {};
  if (env.JWT_ISSUER) opts.issuer = env.JWT_ISSUER;
  if (env.JWT_AUDIENCE) opts.audience = env.JWT_AUDIENCE;
  return opts;
}

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      throw new AppError(400, "email and password required");

    assertNotRateLimited(req, email);

    const { rows } = await pool.query(
      `SELECT id, organization_id, password_hash, status, is_system, two_factor_enabled, two_factor_secret
         FROM users WHERE email=$1`,
      [email],
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
        after: { email, reason: "not_found" },
      });
      throw new AppError(401, "Invalid credentials");
    }

    const user = rows[0];

    if (user.is_system) throw new AppError(403, "System user cannot login");
    if (user.status !== "active") throw new AppError(403, "User is not active");

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      // login history (failure)
      await pool
        .query(
          `INSERT INTO login_history(organization_id, user_id, email, success, ip, user_agent, failure_reason)
         VALUES ($1,$2,$3,FALSE,$4,$5,$6)`,
          [
            user.organization_id,
            user.id,
            email,
            req.audit?.ip || null,
            req.audit?.userAgent || null,
            "bad_password",
          ],
        )
        .catch(() => {});
      await writeAudit({
        organizationId: user.organization_id,
        actorUserId: user.id,
        action: "auth.login_failed",
        entityType: "users",
        entityId: user.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: { reason: "bad_password" },
      });
      throw new AppError(401, "Invalid credentials");
    }

    // 2FA check if enabled
    if (user.two_factor_enabled) {
      const otp = req.body?.otp;
      if (!otp) throw new AppError(401, "2FA code required");
      const secret = user.two_factor_secret;
      if (!secret || !verifyTotp(secret, otp, { window: 1 })) {
        await pool
          .query(
            `INSERT INTO login_history(organization_id, user_id, email, success, ip, user_agent, failure_reason)
           VALUES ($1,$2,$3,FALSE,$4,$5,$6)`,
            [
              user.organization_id,
              user.id,
              email,
              req.audit?.ip || null,
              req.audit?.userAgent || null,
              "bad_2fa",
            ],
          )
          .catch(() => {});
        throw new AppError(401, "Invalid 2FA code");
      }
    }

    const accessToken = signAccessToken({
      userId: user.id,
      organizationId: user.organization_id,
      email,
    });

    const refresh = signRefreshToken({
      userId: user.id,
      organizationId: user.organization_id,
      email,
    });

    await persistRefreshToken({
      organizationId: user.organization_id,
      userId: user.id,
      familyId: refresh.familyId,
      tokenJti: refresh.jti,
      token: refresh.token,
      expiresAt: refresh.expiresAt,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
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
      after: { email },
    });

    // login history (success) and user last login markers
    await pool
      .query(
        `INSERT INTO login_history(organization_id, user_id, email, success, ip, user_agent)
       VALUES ($1,$2,$3,TRUE,$4,$5)`,
        [
          user.organization_id,
          user.id,
          email,
          req.audit?.ip || null,
          req.audit?.userAgent || null,
        ],
      )
      .catch(() => {});
    await pool
      .query(
        `UPDATE users SET last_login_at=NOW(), last_login_ip=$2, last_login_user_agent=$3 WHERE id=$1`,
        [user.id, req.audit?.ip || null, req.audit?.userAgent || null],
      )
      .catch(() => {});

    res.json({
      accessToken,
      refreshToken: env.REFRESH_TOKEN_USE_COOKIE ? undefined : refresh.token,
    });
  } catch (e) {
    next(e);
  }
});

// 2FA enrollment (generate secret)
router.post(
  "/2fa/enroll",
  require("../../../middleware/auth.middleware").authRequired,
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const userId = req.user.id;
      const { rows } = await pool.query(
        `SELECT email, two_factor_enabled FROM users WHERE organization_id=$1 AND id=$2`,
        [orgId, userId],
      );
      if (!rows.length) throw new AppError(404, "User not found");
      if (rows[0].two_factor_enabled)
        throw new AppError(409, "2FA already enabled");
      const secret = generateSecretBase32();
      const issuer = env.APP_NAME || "ERP";
      const otpauth = buildOtpauthUrl({ issuer, email: rows[0].email, secret });
      // store as pending secret (two_factor_secret) until enabled
      await pool.query(
        `UPDATE users SET two_factor_secret=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
        [orgId, userId, secret],
      );
      res.json({ secret, otpauth });
    } catch (e) {
      next(e);
    }
  },
);

// 2FA enable (verify TOTP)
router.post(
  "/2fa/verify",
  require("../../../middleware/auth.middleware").authRequired,
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const userId = req.user.id;
      const otp = req.body?.otp;
      if (!otp) throw new AppError(400, "otp required");
      const { rows } = await pool.query(
        `SELECT two_factor_secret, two_factor_enabled FROM users WHERE organization_id=$1 AND id=$2`,
        [orgId, userId],
      );
      if (!rows.length) throw new AppError(404, "User not found");
      if (rows[0].two_factor_enabled)
        throw new AppError(409, "2FA already enabled");
      if (!rows[0].two_factor_secret) throw new AppError(409, "Enroll first");
      if (!verifyTotp(rows[0].two_factor_secret, otp, { window: 1 }))
        throw new AppError(400, "Invalid otp");
      await pool.query(
        `UPDATE users SET two_factor_enabled=TRUE, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
        [orgId, userId],
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// 2FA disable (verify password + TOTP)
router.post(
  "/2fa/disable",
  require("../../../middleware/auth.middleware").authRequired,
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const userId = req.user.id;
      const password = req.body?.password;
      const otp = req.body?.otp;
      if (!password || !otp)
        throw new AppError(400, "password and otp required");
      const { rows } = await pool.query(
        `SELECT password_hash, two_factor_secret, two_factor_enabled FROM users WHERE organization_id=$1 AND id=$2`,
        [orgId, userId],
      );
      if (!rows.length) throw new AppError(404, "User not found");
      if (!rows[0].two_factor_enabled)
        throw new AppError(409, "2FA not enabled");
      const ok = await bcrypt.compare(password, rows[0].password_hash);
      if (!ok) throw new AppError(401, "Invalid credentials");
      if (!verifyTotp(rows[0].two_factor_secret, otp, { window: 1 }))
        throw new AppError(400, "Invalid otp");
      await pool.query(
        `UPDATE users SET two_factor_enabled=FALSE, two_factor_secret=NULL, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
        [orgId, userId],
      );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Public registration (org + initial admin user provisioning)
 * NOTE: In production you may want to gate this (invite-only) via env.PUBLIC_REGISTRATION_ENABLED=false.
 */
router.post("/register", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (env.PUBLIC_REGISTRATION_ENABLED === false)
      throw new AppError(403, "Public registration disabled");

    const { organizationName, baseCurrencyCode, email, password } =
      req.body || {};
    if (!organizationName) throw new AppError(400, "organizationName required");
    if (!email || !password)
      throw new AppError(400, "email and password required");
    if (String(password).length < 10)
      throw new AppError(400, "password must be at least 10 characters");

    const currencyCode = (baseCurrencyCode || "GHS").toUpperCase();
    const { rows: cRows } = await client.query(
      `SELECT code FROM currencies WHERE code=$1`,
      [currencyCode],
    );
    if (!cRows.length) throw new AppError(400, "Invalid baseCurrencyCode");

    await client.query("BEGIN");

    // 1) Create org
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations(name, base_currency_code) VALUES ($1,$2) RETURNING id, name, base_currency_code`,
      [organizationName, currencyCode],
    );
    const org = orgRows[0];

    // 2) Initialize all organization defaults (COA, periods, payment config, partners, inventory, banking, etc.)
    const defaults = await initializeOrganizationDefaults({
      client,
      orgId: org.id,
      adminEmail: email,
      adminPassword: password,
      baseCurrencyCode: currencyCode,
    });

    // 3) Create default document types for the new organization
    // More complete set of default document types
    await client.query(
      `INSERT INTO document_types (organization_id, code, name, description, is_active)
   VALUES 
     -- Sales documents
     ($1, 'QUOTATION', 'Quotation', 'Customer price quotation / estimate', TRUE),
     ($1, 'SALES_ORDER', 'Sales Order', 'Customer order confirmation', TRUE),
     ($1, 'INVOICE', 'Invoice', 'Customer invoice for goods/services', TRUE),
     ($1, 'CREDIT_NOTE', 'Credit Note', 'Customer credit/refund document', TRUE),
     ($1, 'DEBIT_NOTE', 'Debit Note', 'Customer debit/adjustment document', TRUE),
     ($1, 'DELIVERY_NOTE', 'Delivery Note', 'Goods delivery confirmation', TRUE),
     ($1, 'PROFORMA_INVOICE', 'Proforma Invoice', 'Preliminary invoice before final', TRUE),
     ($1, 'RECEIPT', 'Receipt', 'Payment receipt confirmation', TRUE),
     
     -- Purchase documents
     ($1, 'PURCHASE_ORDER', 'Purchase Order', 'Order to suppliers', TRUE),
     ($1, 'BILL', 'Bill', 'Supplier invoice / bill', TRUE),
     ($1, 'PURCHASE_RECEIPT', 'Purchase Receipt', 'Goods received from supplier', TRUE),
     ($1, 'SUPPLIER_CREDIT', 'Supplier Credit', 'Credit from supplier', TRUE),
     ($1, 'SUPPLIER_DEBIT', 'Supplier Debit', 'Debit from supplier', TRUE),
     ($1, 'PURCHASE_QUOTATION', 'Purchase Quotation', 'Supplier price request', TRUE),
     ($1, 'PURCHASE_RETURN', 'Purchase Return', 'Return to supplier', TRUE),
     
     -- Inventory/Stock documents
     ($1, 'STOCK_ADJUSTMENT', 'Stock Adjustment', 'Inventory count adjustment', TRUE),
     ($1, 'STOCK_TRANSFER', 'Stock Transfer', 'Stock movement between warehouses', TRUE),
     ($1, 'STOCK_ISSUE', 'Stock Issue', 'Material issued for use', TRUE),
     ($1, 'STOCK_RECEIVE', 'Stock Receive', 'Stock received into inventory', TRUE),
     
     -- Financial documents
     ($1, 'JOURNAL_ENTRY', 'Journal Entry', 'General journal entry', TRUE),
     ($1, 'PAYMENT_IN', 'Payment In', 'Customer payment received', TRUE),
     ($1, 'PAYMENT_OUT', 'Payment Out', 'Supplier payment made', TRUE),
     ($1, 'EXPENSE', 'Expense', 'Expense claim/report', TRUE),
     ($1, 'DEPOSIT', 'Deposit', 'Bank deposit', TRUE),
     ($1, 'WITHDRAWAL', 'Withdrawal', 'Bank withdrawal', TRUE),
     ($1, 'TRANSFER', 'Transfer', 'Money transfer between accounts', TRUE),
     
     -- HR/Payroll documents
     ($1, 'PAYROLL_RUN', 'Payroll Run', 'Payroll batch/run approval document', TRUE),
     ($1, 'PAYSLIP', 'Payslip', 'Employee salary slip', TRUE),
     ($1, 'SALARY_ADVANCE', 'Salary Advance', 'Employee salary advance', TRUE),
     ($1, 'REIMBURSEMENT', 'Reimbursement', 'Employee expense reimbursement', TRUE),
     
     -- Tax documents
     ($1, 'TAX_INVOICE', 'Tax Invoice', 'Tax compliant invoice', TRUE),
     ($1, 'TAX_CREDIT', 'Tax Credit', 'Tax credit note', TRUE),
     ($1, 'TAX_RETURN', 'Tax Return', 'Tax filing document', TRUE),
     
     -- Other common documents
     ($1, 'CONTRACT', 'Contract', 'Agreement/contract document', TRUE),
     ($1, 'PROJECT', 'Project', 'Project/document', TRUE),
     ($1, 'BUDGET', 'Budget', 'Budget document', TRUE),
     ($1, 'FORECAST', 'Forecast', 'Financial forecast', TRUE)
   ON CONFLICT (organization_id, code) DO NOTHING`,
      [org.id],
    );

    // Get the user that was created by initializeOrganizationDefaults
    const { rows: userRows } = await client.query(
      `SELECT id, email, organization_id, status, created_at FROM users WHERE organization_id=$1 AND email=$2`,
      [org.id, email],
    );
    const user = userRows[0];

    // Ensure user_organizations entry exists (should be created by initializeOrganizationDefaults)
    await client.query(
      `INSERT INTO user_organizations(user_id, organization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [user.id, org.id],
    );

    await client.query("COMMIT");

    // Fetch the created document types for audit/response
    const { rows: documentTypes } = await client.query(
      `SELECT id, code, name FROM document_types WHERE organization_id = $1`,
      [org.id],
    );

    await writeAudit({
      organizationId: org.id,
      actorUserId: user.id,
      action: "auth.register",
      entityType: "organizations",
      entityId: org.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: {
        organization: org,
        user: { id: user.id, email: user.email },
        defaults: {
          accounts: defaults.accounts,
          periodId: defaults.periodId,
          demoCustomerId: defaults.demoCustomerId,
          demoVendorId: defaults.demoVendorId,
          inventory: defaults.inventory,
          banking: defaults.banking,
          documentTypes: documentTypes,
        },
      },
    });

    // Auto-login after registration
    const accessToken = signAccessToken({
      userId: user.id,
      organizationId: org.id,
      email: user.email,
    });
    const refresh = signRefreshToken({
      userId: user.id,
      organizationId: org.id,
      email: user.email,
    });
    await persistRefreshToken({
      organizationId: org.id,
      userId: user.id,
      token: refresh.token,
      tokenJti: refresh.jti,
      familyId: refresh.familyId,
      expiresAt: refresh.expiresAt,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
    });

    // Return enhanced response with defaults info including document types
    res.status(201).json({
      organization: org,
      user: {
        id: user.id,
        email: user.email,
        organization_id: user.organization_id,
      },
      tokens: { accessToken, refreshToken: refresh.token },
      defaults: {
        accounts: defaults.accounts,
        periodId: defaults.periodId,
        demoCustomerId: defaults.demoCustomerId,
        demoVendorId: defaults.demoVendorId,
        inventory: defaults.inventory,
        banking: defaults.banking,
        documentTypes: documentTypes,
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});

/**
 * Forgot password: create an expiring, single-use reset token.
 * Returns 200 even if the email does not exist to avoid user enumeration.
 */
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) throw new AppError(400, "email required");

    const { rows: users } = await pool.query(
      `SELECT id, email, organization_id, status, is_system FROM users WHERE email=$1`,
      [email],
    );

    // Always respond OK (anti-enumeration)
    if (!users.length) return res.json({ ok: true });

    const eligible = users.filter((u) => !u.is_system && u.status === "active");
    if (!eligible.length) return res.json({ ok: true });

    const ttlMinutes = env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 30;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    // One token per user record (handles the rare case of same email across orgs)
    const issued = [];
    for (const u of eligible) {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto
        .createHash("sha256")
        .update(token + String(env.PASSWORD_RESET_TOKEN_PEPPER || ""))
        .digest("hex");

      await pool.query(
        `
        INSERT INTO password_reset_tokens(user_id, token_hash, expires_at, ip, user_agent)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          u.id,
          tokenHash,
          expiresAt,
          req.audit?.ip || null,
          req.audit?.userAgent || null,
        ],
      );

      await writeAudit({
        organizationId: u.organization_id,
        actorUserId: null,
        action: "auth.forgot_password",
        entityType: "users",
        entityId: u.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: { email: u.email, expiresAt },
      });

      if (env.RETURN_RESET_TOKEN_IN_RESPONSE) {
        issued.push({ organization_id: u.organization_id, token, expiresAt });
      }
    }

    // In production you'd send tokens via email; here we optionally return them for dev/test.
    res.json(
      env.RETURN_RESET_TOKEN_IN_RESPONSE ? { ok: true, issued } : { ok: true },
    );
  } catch (e) {
    next(e);
  }
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token) throw new AppError(400, "token required");
    if (!newPassword) throw new AppError(400, "newPassword required");
    if (String(newPassword).length < 10)
      throw new AppError(400, "newPassword must be at least 10 characters");

    const tokenHash = crypto
      .createHash("sha256")
      .update(String(token) + String(env.PASSWORD_RESET_TOKEN_PEPPER || ""))
      .digest("hex");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `
        SELECT prt.id AS prt_id, prt.user_id, prt.expires_at, u.organization_id, u.email
          FROM password_reset_tokens prt
          JOIN users u ON u.id = prt.user_id
         WHERE prt.token_hash=$1
           AND prt.used_at IS NULL
           AND prt.expires_at > NOW()
         LIMIT 1
        `,
        [tokenHash],
      );

      if (!rows.length) throw new AppError(400, "Invalid or expired token");

      const rec = rows[0];
      const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);

      await client.query(
        `UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`,
        [passwordHash, rec.user_id],
      );
      await client.query(
        `UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1`,
        [rec.prt_id],
      );

      // Revoke all refresh tokens so a stolen refresh token cannot be used after reset.
      await revokeAllRefreshTokensForUser({
        organizationId: rec.organization_id,
        userId: rec.user_id,
        reason: "User forot password",
      });

      await client.query("COMMIT");

      await writeAudit({
        organizationId: rec.organization_id,
        actorUserId: rec.user_id,
        action: "auth.reset_password",
        entityType: "users",
        entityId: rec.user_id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: { email: rec.email },
      });

      res.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    next(e);
  }
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
      after: { familyId: rotated.familyId },
    });

    res.json({
      accessToken: rotated.accessToken,
      refreshToken: env.REFRESH_TOKEN_USE_COOKIE
        ? undefined
        : rotated.refreshToken,
    });
  } catch (e) {
    next(e);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const rt = getRefreshTokenFromRequest(req);
    if (!rt) throw new AppError(400, "refreshToken required");

    let payload;
    try {
      payload = jwt.verify(
        rt,
        env.JWT_REFRESH_SECRET,
        env.JWT_ISSUER || env.JWT_AUDIENCE
          ? {
              issuer: env.JWT_ISSUER || undefined,
              audience: env.JWT_AUDIENCE || undefined,
            }
          : undefined,
      );
    } catch (e) {
      // Even if token is invalid, clear cookie for client hygiene
      clearRefreshCookie(res);
      throw new AppError(401, "Invalid refresh token");
    }

    if (payload?.typ !== "refresh")
      throw new AppError(401, "Invalid refresh token");

    const userId = payload.sub;
    const organizationId = payload.organization_id;
    const jti = payload.jti;

    if (!userId || !organizationId || !jti)
      throw new AppError(401, "Invalid refresh token");

    await revokeRefreshTokenByJti({
      jti,
      organizationId,
      userId,
      reason: "logout",
    });

    clearRefreshCookie(res);

    await writeAudit({
      organizationId,
      actorUserId: userId,
      action: "auth.logout",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: {},
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post("/logout-all", async (req, res, next) => {
  try {
    const rt = getRefreshTokenFromRequest(req);
    if (!rt) throw new AppError(400, "refreshToken required");

    let payload;
    try {
      payload = jwt.verify(
        rt,
        env.JWT_REFRESH_SECRET,
        env.JWT_ISSUER || env.JWT_AUDIENCE
          ? {
              issuer: env.JWT_ISSUER || undefined,
              audience: env.JWT_AUDIENCE || undefined,
            }
          : undefined,
      );
    } catch (e) {
      clearRefreshCookie(res);
      throw new AppError(401, "Invalid refresh token");
    }

    if (payload?.typ !== "refresh")
      throw new AppError(401, "Invalid refresh token");

    const userId = payload.sub;
    const organizationId = payload.organization_id;
    const familyId = payload.fid;

    if (!userId || !organizationId || !familyId)
      throw new AppError(401, "Invalid refresh token");

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
      after: { familyId },
    });

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
