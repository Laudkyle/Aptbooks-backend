const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");

router.use(authRequired);

router.get("/:key", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT key, value_json FROM system_settings WHERE organization_id=$1 AND key=$2`,
      [orgId, req.params.key]
    );
    if (!rows.length) throw new AppError(404, "Setting not found");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.put("/:key", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const key = req.params.key;
    const value = req.body;
    if (value === undefined) throw new AppError(400, "Body required (JSON)");

    const { rows: before } = await pool.query(
      `SELECT key, value_json FROM system_settings WHERE organization_id=$1 AND key=$2`,
      [orgId, key]
    );

    const { rows: after } = await pool.query(
      `
      INSERT INTO system_settings(organization_id, key, value_json)
      VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (organization_id, key)
      DO UPDATE SET value_json=EXCLUDED.value_json
      RETURNING key, value_json
      `,
      [orgId, key, JSON.stringify(value)]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "settings.updated",
      entityType: "system_settings",
      entityId: null,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0] || null,
      after: after[0]
    });

    res.json(after[0]);
  } catch (e) { next(e); }
});

module.exports = router;
