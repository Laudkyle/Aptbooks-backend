const router = require("express").Router();
const { authRequired } = require("../middleware/auth.middleware");
const { requirePermission } = require("../middleware/permission.middleware");
const { writeAudit } = require("../core/foundation/audit-logs/audit.service");
const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");
const { encryptSecret, decryptSecret } = require("../shared/security/secrets");

const svc = require("./notifications.service");

router.use(authRequired);

// List current user's notifications
router.get("/", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const out = await svc.listNotifications({ orgId, userId, query: req.query });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Create a notification (admin/system use)
// If payload.userId is omitted, broadcasts to all active users in the org.
router.post("/", requirePermission("notifications.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const created = await svc.createNotification({
      orgId,
      actorUserId: req.user.id,
      payload: req.body
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "notifications.created",
      entityType: "notifications",
      entityId: created?.id || null,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

// Mark a single notification as read
router.patch("/:id/read", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const out = await svc.markRead({ orgId, userId, notificationId: req.params.id });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// Mark multiple notifications as read
router.post("/mark-read", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const out = await svc.markReadBulk({ orgId, userId, ids: req.body?.ids });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// SMTP configuration (stored in system_settings key='smtp')
router.get("/smtp", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key='smtp' LIMIT 1`,
      [orgId]
    );
    if (!rows.length) return res.json(null);

    // Never return the SMTP credential. The UI only needs to know whether one exists.
    const stored = rows[0].value_json || {};
    const { appPassword, ...safe } = stored;
    res.json({ ...safe, hasPassword: Boolean(appPassword) });
  } catch (e) { next(e); }
});

router.put("/smtp", requirePermission("settings.manage"), async (req, res, next) => {
  let client = null;
  try {
    client = await pool.connect();
    const orgId = req.user.organization_id;
    const incoming = { ...(req.body || {}) };
    await client.query("BEGIN");

    const { rows: existingRows } = await client.query(
      `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key='smtp' LIMIT 1 FOR UPDATE`,
      [orgId]
    );
    const existing = existingRows[0]?.value_json || {};

    const cfg = {
      host: String(incoming.host || "smtp.gmail.com").trim(),
      port: Number(incoming.port || 587),
      from: String(incoming.from || "").trim(),
      username: String(incoming.username || "").trim(),
    };

    if (!cfg.from) throw new AppError(400, "from required");
    if (!cfg.username) throw new AppError(400, "username required");
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
      throw new AppError(400, "port must be between 1 and 65535");
    }

    const suppliedPassword = typeof incoming.appPassword === "string" ? incoming.appPassword.trim() : "";
    const storedPassword = suppliedPassword
      ? encryptSecret(suppliedPassword, { context: `smtp:${orgId}` })
      : existing.appPassword;
    if (!storedPassword) throw new AppError(400, "appPassword required");

    // Opportunistically migrate a legacy plaintext credential even when the user
    // edits only non-secret fields.
    cfg.appPassword = encryptSecret(
      decryptSecret(storedPassword, { context: `smtp:${orgId}`, allowPlaintextLegacy: true }),
      { context: `smtp:${orgId}` }
    );

    await client.query(
      `INSERT INTO system_settings(organization_id, key, value_json)
       VALUES ($1,'smtp',$2::jsonb)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value_json=EXCLUDED.value_json`,
      [orgId, JSON.stringify(cfg)]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "smtp.updated",
      entityType: "system_settings",
      entityId: null,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { host: cfg.host, port: cfg.port, from: cfg.from, username: cfg.username, hasPassword: true },
      client,
    });

    await client.query("COMMIT");
    res.json({ ok: true, hasPassword: true });
  } catch (e) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    next(e);
  } finally {
    if (client) client.release();
  }
});

// SMTP test endpoint (configuration only). The repo does not ship an SMTP client dependency.
router.post("/smtp/test", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const to = String(req.body?.to || "").trim();
    if (!to) throw new AppError(400, "to required");
    const { rows } = await pool.query(
      `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key='smtp' LIMIT 1`,
      [orgId]
    );
    if (!rows.length) throw new AppError(409, "SMTP not configured");
    const storedPassword = rows[0]?.value_json?.appPassword;
    if (!storedPassword) throw new AppError(409, "SMTP password not configured");
    // Ensure the stored credential can be decrypted without ever returning it.
    decryptSecret(storedPassword, { context: `smtp:${orgId}`, allowPlaintextLegacy: true });
    // Return a placeholder response; integrate nodemailer or Gmail API in deployment.
    res.json({ ok: true, message: "SMTP configuration found. Test delivery is not executed in this build.", to });
  } catch (e) { next(e); }
});

module.exports = router;
