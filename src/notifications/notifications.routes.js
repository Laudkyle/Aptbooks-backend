const router = require("express").Router();
const { authRequired } = require("../middleware/auth.middleware");
const { requirePermission } = require("../middleware/permission.middleware");
const { writeAudit } = require("../core/foundation/audit-logs/audit.service");

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

module.exports = router;
