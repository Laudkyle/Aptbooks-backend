const router = require("express").Router();
const { authRequired } = require("../middleware/auth.middleware");
const { requirePermission } = require("../middleware/permission.middleware");
const { writeAudit } = require("../core/foundation/audit-logs/audit.service");
const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

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
    res.json(rows[0]?.value_json || null);
  } catch (e) { next(e);}
});

router.put("/smtp", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const cfg = req.body || {};
    // minimal validation for Gmail SMTP
    if (!cfg.host) cfg.host = "smtp.gmail.com";
    if (!cfg.port) cfg.port = 587;
    if (!cfg.from) throw new AppError(400, "from required");
    if (!cfg.username) throw new AppError(400, "username required");
    if (!cfg.appPassword) throw new AppError(400, "appPassword required");

    await pool.query(
      `INSERT INTO system_settings(organization_id, key, value_json)
       VALUES ($1,'smtp',$2::jsonb)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=NOW()`,
      [orgId, JSON.stringify(cfg)]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "smtp.updated",
      entityType: "system_settings",
      entityId: "smtp",
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: { ...cfg, appPassword: "***" }
    });

    res.json({ ok: true });
  } catch (e) { next(e);}
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
    // Return a placeholder response;integrate nodemailer or Gmail API in deployment.
    res.json({ ok: true, message: "SMTP configuration found. Test delivery is not executed in this build.", to });
  } catch (e) { next(e);}
});

module.exports = router;
