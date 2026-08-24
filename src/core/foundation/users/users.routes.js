const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require("express").Router();
router.use(createModuleBodyContract(['baseCurrencyCode', 'challengeId', 'displayName', 'display_name', 'email', 'fid', 'first_name', 'image', 'isActive', 'is_active', 'jti', 'last_name', 'newPassword', 'notes', 'organizationId', 'organizationName', 'organization_id', 'otp', 'password', 'phone', 'refreshToken', 'roleIds', 'signatureDisplayName', 'signatureImage', 'signatureIsActive', 'signatureNotes', 'signatureTitle', 'signature_display_name', 'signature_image', 'signature_is_active', 'signature_notes', 'signature_title', 'status', 'sub', 'title', 'token', 'typ', 'ver']));
const bcrypt = require("bcrypt"); 
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");
const {
  signAccessToken,
  signRefreshToken,
  persistRefreshToken,
  revokeAllRefreshTokensAcrossOrganizations,
} = require("./tokens.service");
router.use(authRequired);

function setRefreshCookie(res, token) {
  if (!env.REFRESH_TOKEN_USE_COOKIE) return;
  const opts = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: "/auth",
  };
  if (env.COOKIE_DOMAIN) opts.domain = env.COOKIE_DOMAIN;
  res.cookie(env.REFRESH_TOKEN_COOKIE_NAME, token, opts);
}

function normalizeSignaturePayload(body = {}) {
  const displayName = body.signature_display_name ?? body.display_name ?? body.displayName ?? null;
  const title = body.signature_title ?? body.title ?? null;
  const notes = body.signature_notes ?? body.notes ?? null;
  const image = body.signature_image ?? body.signatureImage ?? body.image ?? null;
  const isActiveInput = body.signature_is_active ?? body.is_active ?? body.isActive;
  const isActive = typeof isActiveInput === 'boolean' ? isActiveInput : undefined;

  if (image != null) {
    const s = String(image).trim();
    const looksValid = s === '' || s.startsWith('data:image/') || s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../');
    if (!looksValid) throw new AppError(400, 'signature_image must be a data URL, absolute URL, or app-relative path');
    if (s.length > 2_000_000) throw new AppError(400, 'signature_image is too large');
  }

  return {
    signatureDisplayName: displayName == null ? null : String(displayName).trim() || null,
    signatureTitle: title == null ? null : String(title).trim() || null,
    signatureNotes: notes == null ? null : String(notes).trim() || null,
    signatureImage: image == null ? null : String(image).trim() || null,
    signatureIsActive: isActive
  };
}

async function getUserSignatureRecord({ orgId, userId }) {
  const { rows } = await pool.query(
    `SELECT uo.user_id, uo.organization_id,
            COALESCE(uo.signature_display_name, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.full_name, u.email) AS signature_display_name,
            uo.signature_title,
            uo.signature_notes,
            uo.signature_image,
            uo.signature_is_active,
            uo.signature_updated_at,
            uo.signature_updated_by_user_id,
            u.email,
            u.first_name,
            u.last_name,
            u.full_name,
            u.phone,
            CASE WHEN COALESCE(uo.signature_image, '') <> '' AND uo.signature_is_active = TRUE THEN TRUE ELSE FALSE END AS has_signature
       FROM user_organizations uo
       JOIN users u ON u.id = uo.user_id
      WHERE uo.organization_id=$1 AND uo.user_id=$2
      LIMIT 1`,
    [orgId, userId]
  );
  if (!rows.length) throw new AppError(404, 'User membership not found for organization');
  return rows[0];
}

async function upsertUserSignature({ orgId, targetUserId, actorUserId, payload }) {
  const current = await getUserSignatureRecord({ orgId, userId: targetUserId });

  const signatureImage = payload.signatureImage !== null ? payload.signatureImage : current.signature_image;
  const signatureDisplayName = payload.signatureDisplayName !== null ? payload.signatureDisplayName : current.signature_display_name;
  const signatureTitle = payload.signatureTitle !== null ? payload.signatureTitle : current.signature_title;
  const signatureNotes = payload.signatureNotes !== null ? payload.signatureNotes : current.signature_notes;
  const signatureIsActive = typeof payload.signatureIsActive === 'boolean'
    ? payload.signatureIsActive
    : Boolean(signatureImage);

  const { rows } = await pool.query(
    `UPDATE user_organizations
        SET signature_image=$3,
            signature_display_name=$4,
            signature_title=$5,
            signature_notes=$6,
            signature_is_active=$7,
            signature_updated_at=NOW(),
            signature_updated_by_user_id=$8
      WHERE organization_id=$1 AND user_id=$2
      RETURNING user_id, organization_id, signature_image, signature_display_name, signature_title, signature_notes, signature_is_active, signature_updated_at, signature_updated_by_user_id`,
    [orgId, targetUserId, signatureImage, signatureDisplayName, signatureTitle, signatureNotes, signatureIsActive, actorUserId || null]
  );
  return { before: current, after: await getUserSignatureRecord({ orgId, userId: rows[0].user_id }) };
}

async function clearUserSignature({ orgId, targetUserId, actorUserId }) {
  const current = await getUserSignatureRecord({ orgId, userId: targetUserId });
  const { rowCount } = await pool.query(
    `UPDATE user_organizations
        SET signature_image=NULL,
            signature_display_name=NULL,
            signature_title=NULL,
            signature_notes=NULL,
            signature_is_active=FALSE,
            signature_updated_at=NOW(),
            signature_updated_by_user_id=$3
      WHERE organization_id=$1 AND user_id=$2`,
    [orgId, targetUserId, actorUserId || null]
  );
  if (!rowCount) throw new AppError(404, 'User membership not found for organization');
  return { before: current, after: await getUserSignatureRecord({ orgId, userId: targetUserId }) };
}


// Current user profile
// Returns the authenticated user's profile + roles + permissions in current org context.
router.get("/me", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;

    const { rows: uRows } = await pool.query(
      `
      SELECT id, organization_id, email, status, created_at, updated_at, first_name, last_name, full_name, phone, two_factor_enabled
      FROM users
      WHERE organization_id=$1 AND id=$2 AND COALESCE(is_system,FALSE)=FALSE
      LIMIT 1
      `,
      [orgId, userId]
    );
    if (!uRows.length) throw new AppError(404, "User not found");

    const { rows: roleRows } = await pool.query(
      `
      SELECT r.id, r.name
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id=$1 AND r.organization_id=$2
      ORDER BY r.name
      `,
      [userId, orgId]
    );

    const { rows: permRows } = await pool.query(
      `
      SELECT DISTINCT p.code
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id=$1 AND r.organization_id=$2
      ORDER BY p.code
      `,
      [userId, orgId]
    );

    const signature = await getUserSignatureRecord({ orgId, userId });

    res.json({
      user: uRows[0],
      signature,
      roles: roleRows,
      permissions: permRows.map((p) => p.code)
    });
  } catch (e) {
    next(e);
  }
});


// Current user signature for the active organization context
router.get('/me/signature', async (req, res, next) => {
  try {
    const out = await getUserSignatureRecord({ orgId: req.user.organization_id, userId: req.user.id });
    res.json(out);
  } catch (e) { next(e); }
});

router.put('/me/signature', async (req, res, next) => {
  try {
    const patch = normalizeSignaturePayload(req.body || {});
    const out = await upsertUserSignature({
      orgId: req.user.organization_id,
      targetUserId: req.user.id,
      actorUserId: req.user.id,
      payload: patch
    });

    await writeAudit({
      organizationId: req.user.organization_id,
      actorUserId: req.user.id,
      action: 'user.signature.updated',
      entityType: 'user_organizations',
      entityId: req.user.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) { next(e); }
});

router.delete('/me/signature', async (req, res, next) => {
  try {
    const out = await clearUserSignature({ orgId: req.user.organization_id, targetUserId: req.user.id, actorUserId: req.user.id });
    await writeAudit({
      organizationId: req.user.organization_id,
      actorUserId: req.user.id,
      action: 'user.signature.cleared',
      entityType: 'user_organizations',
      entityId: req.user.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });
    res.json(out.after);
  } catch (e) { next(e); }
});

// Login history for current user
router.get("/me/login-history", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
    const { rows } = await pool.query(
      `SELECT id, created_at, success, ip, user_agent, failure_reason
         FROM login_history
        WHERE organization_id=$1 AND user_id=$2
        ORDER BY created_at DESC
        LIMIT $3`,
      [orgId, req.user.id, limit]
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// Admin: login history with filtering
router.get("/:userId/login-history", requirePermission("users.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
    const userId = req.query.userId || null;
    const email = req.query.email || null;

    const params = [orgId];
    let where = `WHERE organization_id=$1`;
    if (userId) {
      params.push(userId);
      where += ` AND user_id=$${params.length}`;
    }
    if (email) {
      params.push(String(email));
      where += ` AND email=$${params.length}`;
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT id, created_at, user_id, email, success, ip, user_agent, failure_reason
         FROM login_history
         ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.post("/create/", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { email, password } = req.body || {};

    if (!email || !password) throw new AppError(400, "email and password required");
    if (String(password).length < 10) throw new AppError(400, "password must be at least 10 characters");

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

    const { rows } = await pool.query(
      `
      INSERT INTO users(organization_id, email, password_hash, status)
      VALUES ($1,$2,$3,'active')
      RETURNING id, organization_id, email, status, created_at
      `,
      [orgId, email, passwordHash]
    );
    // Ensure multi-org membership record exists
    await pool.query(
      `INSERT INTO user_organizations(user_id, organization_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [rows[0].id, orgId]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.created",
      entityType: "users",
      entityId: rows[0].id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: rows[0]
    });

    res.status(201).json(rows[0]);
  } catch (e) {
    // Global unique email constraint
    if (e && e.code === "23505") {
      return next(new AppError(409, "Email already exists"));
    }
    next(e);
  }
});

router.get("/", requirePermission("users.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.status, u.created_at,
              COALESCE(uo.signature_is_active, FALSE) AS signature_is_active,
              CASE WHEN COALESCE(uo.signature_image, '') <> '' AND COALESCE(uo.signature_is_active, FALSE) = TRUE THEN TRUE ELSE FALSE END AS has_signature
         FROM users u
    LEFT JOIN user_organizations uo ON uo.user_id = u.id AND uo.organization_id = u.organization_id
        WHERE u.organization_id=$1
          AND COALESCE(u.is_system,FALSE)=FALSE
          AND LOWER(u.email) <> 'system@aptbooks.local'
        ORDER BY u.created_at DESC`,
      [orgId]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});


router.get('/:id/signature', requirePermission('users.read'), async (req, res, next) => {
  try {
    const out = await getUserSignatureRecord({ orgId: req.user.organization_id, userId: req.params.id });
    res.json(out);
  } catch (e) { next(e); }
});

router.put('/:id/signature', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const patch = normalizeSignaturePayload(req.body || {});
    const out = await upsertUserSignature({
      orgId: req.user.organization_id,
      targetUserId: req.params.id,
      actorUserId: req.user.id,
      payload: patch
    });
    await writeAudit({
      organizationId: req.user.organization_id,
      actorUserId: req.user.id,
      action: 'user.signature.updated',
      entityType: 'user_organizations',
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });
    res.json(out.after);
  } catch (e) { next(e); }
});

router.delete('/:id/signature', requirePermission('users.manage'), async (req, res, next) => {
  try {
    const out = await clearUserSignature({ orgId: req.user.organization_id, targetUserId: req.params.id, actorUserId: req.user.id });
    await writeAudit({
      organizationId: req.user.organization_id,
      actorUserId: req.user.id,
      action: 'user.signature.cleared',
      entityType: 'user_organizations',
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });
    res.json(out.after);
  } catch (e) { next(e); }
});

// Read single user (with roles)
router.get("/:id", requirePermission("users.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;

    const { rows: uRows } = await pool.query(
      `SELECT id, organization_id, email, status, first_name, last_name, phone, full_name, created_at, updated_at
       FROM users
       WHERE organization_id=$1 AND id=$2 AND COALESCE(is_system,FALSE)=FALSE
       LIMIT 1`,
      [orgId, userId]
    );
    if (!uRows.length) throw new AppError(404, "User not found");

    const { rows: roleRows } = await pool.query(
      `SELECT r.id, r.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id=$1 AND r.organization_id=$2
        ORDER BY r.name`,
      [userId, orgId]
    );

    const signature = await getUserSignatureRecord({ orgId, userId });

    res.json({ ...uRows[0], roles: roleRows, signature });
  } catch (e) { next(e); }
});

// Update user fields
router.patch("/:id", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;

    if (userId === req.user.id && req.body?.status === "deleted") {
      throw new AppError(409, "You cannot delete your own account");
    }

    const { rows: before } = await pool.query(
      `SELECT id, email, status, first_name, last_name, full_name, phone FROM users WHERE organization_id=$1 AND id=$2`,
      [orgId, userId]
    );
    if (!before.length) throw new AppError(404, "User not found");

    const email = req.body?.email || null;
    const firstName = req.body?.first_name ?? null;
    const lastName = req.body?.last_name ?? null;
    const phone = req.body?.phone ?? null;
    const status = req.body?.status || null;

    let passwordHash = null;
    if (req.body?.password) {
      if (String(req.body.password).length < 10) throw new AppError(400, "password must be at least 10 characters");
      passwordHash = await bcrypt.hash(req.body.password, env.BCRYPT_ROUNDS);
    }

    const { rows: after } = await pool.query(
      `
      UPDATE users
         SET email = COALESCE($3, email),
             first_name = COALESCE($4, first_name),
             last_name = COALESCE($5, last_name),
             phone = COALESCE($6, phone),
             status = COALESCE($7, status),
             password_hash = COALESCE($8, password_hash),
             auth_version = auth_version + CASE WHEN $7 IS NOT NULL OR $8 IS NOT NULL THEN 1 ELSE 0 END,
             updated_at = NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING id, email, status, first_name, last_name, full_name, phone, updated_at
      `,
      [orgId, userId, email, firstName, lastName, phone, status, passwordHash]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.updated",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0],
      after: after[0]
    });

    res.json(after[0]);
  } catch (e) {
    if (e && e.code === "23505") return next(new AppError(409, "Email already exists"));
    next(e);
  }
});

// Reactivate a disabled user
router.post("/:id/enable", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;
    const { rows: before } = await pool.query(
      `SELECT id, email, status FROM users WHERE organization_id=$1 AND id=$2`,
      [orgId, userId]
    );
    if (!before.length) throw new AppError(404, "User not found");

    const { rows: after } = await pool.query(
      `UPDATE users SET status='active', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id, email, status`,
      [orgId, userId]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.enabled",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0],
      after: after[0]
    });

    res.json(after[0]);
  } catch (e) { next(e); }
});

// Remove role assignment(s)
router.delete("/:id/roles", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;
    const roleIds = req.body?.roleIds;
    if (!Array.isArray(roleIds) || roleIds.length === 0) throw new AppError(400, "roleIds required");

    await client.query("BEGIN");
    const { rows: u } = await client.query(`SELECT id FROM users WHERE organization_id=$1 AND id=$2`, [orgId, userId]);
    if (!u.length) throw new AppError(404, "User not found");

    // ensure roles belong to org
    const { rows: r } = await client.query(
      `SELECT id FROM roles WHERE organization_id=$1 AND id=ANY($2::uuid[])`,
      [orgId, roleIds]
    );
    if (r.length !== roleIds.length) throw new AppError(400, "One or more roleIds invalid");

    await client.query(
      `DELETE FROM user_roles WHERE user_id=$1 AND role_id = ANY($2::uuid[])`,
      [userId, roleIds]
    );
    await client.query("COMMIT");

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.roles.removed",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { roleIds }
    });

    res.json({ userId, removed: roleIds });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    next(e);
  } finally {
    client.release();
  }
});

// Soft delete user (status=deleted and tombstone email)
router.delete("/:id", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;
    if (userId === req.user.id) throw new AppError(409, "You cannot delete your own account");

    const { rows: before } = await pool.query(`SELECT id, email, status FROM users WHERE organization_id=$1 AND id=$2`, [orgId, userId]);
    if (!before.length) throw new AppError(404, "User not found");

    const tombstone = `${before[0].email}.deleted.${userId}`;
    const { rows: after } = await pool.query(
      `UPDATE users SET status='deleted', email=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id, email, status`,
      [orgId, userId, tombstone]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.deleted",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0],
      after: after[0]
    });

    res.json(after[0]);
  } catch (e) { next(e); }
});

router.patch("/:id/disable", requirePermission("users.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;

    // Optional safety: prevent disabling yourself
    if (userId === req.user.id) throw new AppError(409, "You cannot disable your own account");

    const { rows: before } = await pool.query(
      `SELECT id, email, status FROM users WHERE organization_id=$1 AND id=$2`,
      [orgId, userId]
    );
    if (!before.length) throw new AppError(404, "User not found");

    const { rows: after } = await pool.query(
      `UPDATE users SET status='disabled', auth_version=auth_version+1, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id, email, status`,
      [orgId, userId]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.disabled",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0],
      after: after[0]
    });

    res.json(after[0]);
  } catch (e) {
    next(e);
  }
});

// Assign roles: { roleIds: ["..."] }
router.post("/:id/roles", requirePermission("rbac.roles.manage"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;
    const roleIds = req.body?.roleIds || [];

    if (!Array.isArray(roleIds) || roleIds.length === 0) throw new AppError(400, "roleIds required");

    await client.query("BEGIN");

    const { rows: u } = await client.query(
      `SELECT id FROM users WHERE organization_id=$1 AND id=$2`,
      [orgId, userId]
    );
    if (!u.length) throw new AppError(404, "User not found");

    const { rows: roles } = await client.query(
      `SELECT id FROM roles WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
      [orgId, roleIds]
    );
    if (roles.length !== roleIds.length) throw new AppError(400, "One or more roleIds invalid");

    for (const r of roles) {
      await client.query(
        `INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, r.id]
      );
    }

    await client.query("COMMIT");

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "user.roles.assigned",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { userId, roleIds }
    });

    res.json({ userId, assigned: roleIds });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});
router.get("/me/organizations", async (req, res, next) => {
  try {
    const userId = req.user.id;

    const { rows } = await pool.query(
      `
      SELECT o.id, o.name, o.base_currency_code, (o.id = u.organization_id) AS is_current
        FROM user_organizations uo
        JOIN organizations o ON o.id = uo.organization_id
        JOIN users u ON u.id = uo.user_id
       WHERE uo.user_id=$1
       ORDER BY is_current DESC, o.name ASC
      `,
      [userId]
    );

    res.json({ userId, organizations: rows });
  } catch (e) { next(e); }
});

router.post("/me/switch-organization", async (req, res, next) => {
  let client = null;
  let inTransaction = false;
  try {
    client = await pool.connect();
    const userId = req.user.id;
    const { organizationId } = req.body || {};
    if (!organizationId) throw new AppError(400, "organizationId required");

    await client.query("BEGIN");
    inTransaction = true;

    // Lock the user context so concurrent organization switches cannot interleave.
    const { rows: users } = await client.query(
      `SELECT id, email, organization_id, status, is_system, auth_version
         FROM users
        WHERE id=$1
        FOR UPDATE`,
      [userId]
    );
    if (!users.length || users[0].status !== "active" || users[0].is_system) {
      throw new AppError(403, "User is not active");
    }

    const { rows: mem } = await client.query(
      `SELECT 1
         FROM user_organizations
        WHERE user_id=$1 AND organization_id=$2
        FOR UPDATE`,
      [userId, organizationId]
    );
    if (!mem.length) throw new AppError(403, "Not a member of that organization");

    const { rows: updated } = await client.query(
      `UPDATE users
          SET organization_id=$1, auth_version=auth_version+1, updated_at=NOW()
        WHERE id=$2
        RETURNING id, email, organization_id, auth_version`,
      [organizationId, userId]
    );
    const user = updated[0];

    // A refresh token is scoped to an organization context. Revoke every prior
    // refresh session so an old token cannot become valid again after switching back.
    await revokeAllRefreshTokensAcrossOrganizations({
      userId,
      reason: "organization_switch",
      client,
    });

    const accessToken = signAccessToken({
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      authVersion: user.auth_version,
    });
    const refresh = signRefreshToken({
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      authVersion: user.auth_version,
    });

    await persistRefreshToken({
      organizationId: user.organization_id,
      userId: user.id,
      tokenJti: refresh.jti,
      familyId: refresh.familyId,
      token: refresh.token,
      expiresAt: refresh.expiresAt,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      client,
    });

    await writeAudit({
      organizationId: user.organization_id,
      actorUserId: userId,
      action: "user.organization.switched",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: { organizationId: users[0].organization_id },
      after: { organizationId: user.organization_id },
      client,
    });

    await client.query("COMMIT");
    inTransaction = false;

    setRefreshCookie(res, refresh.token);
    res.json({
      user: { id: user.id, email: user.email, organization_id: user.organization_id },
      tokens: {
        accessToken,
        refreshToken: env.REFRESH_TOKEN_USE_COOKIE ? undefined : refresh.token,
      },
    });
  } catch (e) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    next(e);
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
