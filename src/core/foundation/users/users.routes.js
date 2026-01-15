const router = require("express").Router();
const bcrypt = require("bcrypt"); 
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");
const { signAccessToken, signRefreshToken, persistRefreshToken } = require("./tokens.service");
router.use(authRequired);

// Current user profile
// Returns the authenticated user's profile + roles + permissions in current org context.
router.get("/me", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;

    const { rows: uRows } = await pool.query(
      `
      SELECT id, organization_id, email, status, created_at, updated_at
      FROM users
      WHERE organization_id=$1 AND id=$2
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

    res.json({
      user: uRows[0],
      roles: roleRows,
      permissions: permRows.map((p) => p.code)
    });
  } catch (e) {
    next(e);
  }
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
router.get("/login-history", requirePermission("users.read"), async (req, res, next) => {
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

router.post("/", requirePermission("users.manage"), async (req, res, next) => {
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
      `SELECT id, email, status, created_at FROM users WHERE organization_id=$1 ORDER BY created_at DESC`,
      [orgId]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Read single user (with roles)
router.get("/:id", requirePermission("users.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.params.id;

    const { rows: uRows } = await pool.query(
      `SELECT id, organization_id, email, status, first_name, last_name, phone, created_at, updated_at
       FROM users
       WHERE organization_id=$1 AND id=$2
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

    res.json({ ...uRows[0], roles: roleRows });
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
      `SELECT id, email, status, first_name, last_name, phone FROM users WHERE organization_id=$1 AND id=$2`,
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
             updated_at = NOW()
       WHERE organization_id=$1 AND id=$2
       RETURNING id, email, status, first_name, last_name, phone, updated_at
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
      `UPDATE users SET status='disabled', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id, email, status`,
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
  try {
    const userId = req.user.id;
    const { organizationId } = req.body || {};
    if (!organizationId) throw new AppError(400, "organizationId required");

    // Ensure membership exists
    const { rows: mem } = await pool.query(
      `SELECT 1 FROM user_organizations WHERE user_id=$1 AND organization_id=$2`,
      [userId, organizationId]
    );
    if (!mem.length) throw new AppError(403, "Not a member of that organization");

    // Update current org context
    const { rows: updated } = await pool.query(
      `UPDATE users SET organization_id=$1, updated_at=NOW() WHERE id=$2 RETURNING id, email, organization_id`,
      [organizationId, userId]
    );

    // Issue fresh tokens scoped to the selected organization
    const user = updated[0];
    const accessToken = signAccessToken({ userId: user.id, organizationId: user.organization_id, email: user.email });
    const refresh = signRefreshToken({ userId: user.id, organizationId: user.organization_id, email: user.email });

    await persistRefreshToken({
      organizationId: user.organization_id,
      userId: user.id,
      tokenJti: refresh.jti,
      familyId: refresh.familyId,
      expiresAt: refresh.expiresAt,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent
    });

    await writeAudit({
      organizationId: user.organization_id,
      actorUserId: userId,
      action: "user.organization.switched",
      entityType: "users",
      entityId: userId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { organizationId: user.organization_id }
    });

    res.json({
      user: { id: user.id, email: user.email, organization_id: user.organization_id },
      tokens: { accessToken, refreshToken: refresh.token }
    });
  } catch (e) { next(e); }
});

module.exports = router;
