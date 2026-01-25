const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");

router.use(authRequired);

// --- Admin convenience endpoints (bulk/list) ---

// List settings (optionally filtered by prefix)
router.get(
  "/",
  requirePermission("settings.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const prefix = (req.query.prefix || "").toString();
      const limit = Math.min(Number.parseInt(String(req.query.limit || "200"), 10) || 200, 500);

      const { rows } = await pool.query(
        `SELECT key, value_json
           FROM system_settings
          WHERE organization_id=$1
            AND ($2 = '' OR key LIKE ($2 || '%'))
          ORDER BY key
          LIMIT $3`,
        [orgId, prefix, limit]
      );

      res.json({ ok: true, data: rows });
    } catch (e) {
      next(e);
    }
  }
);

// Bulk upsert settings
router.put(
  "/bulk",
  requirePermission("settings.manage"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      const orgId = req.user.organization_id;
      const items = req.body?.settings;
      if (!Array.isArray(items) || items.length === 0) {
        throw new AppError(400, "Body must be { settings: [{ key, value_json }] }");
      }

      // Basic validation to prevent accidental corrupt payloads
      for (const it of items) {
        if (!it || typeof it.key !== "string" || !it.key.trim()) {
          throw new AppError(400, "Each setting requires a non-empty string key");
        }
        if (it.value_json === undefined) {
          throw new AppError(400, `Setting '${it.key}' is missing value_json`);
        }
      }

      await client.query("BEGIN");
      const updated = [];

      for (const it of items) {
        const key = it.key.trim();
        const valueJson = it.value_json;

        const { rows: before } = await client.query(
          `SELECT key, value_json FROM system_settings WHERE organization_id=$1 AND key=$2`,
          [orgId, key]
        );

        const { rows: after } = await client.query(
          `INSERT INTO system_settings(organization_id, key, value_json)
           VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (organization_id, key)
           DO UPDATE SET value_json=EXCLUDED.value_json
           RETURNING key, value_json`,
          [orgId, key, JSON.stringify(valueJson)]
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

        updated.push(after[0]);
      }

      await client.query("COMMIT");
      res.json({ ok: true, data: updated });
    } catch (e) {
      try { await client.query("ROLLBACK");} catch (_) { /* ignore */ }
      next(e);
    } finally {
      client.release();
    }
  }
);

router.get("/:key", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT key, value_json FROM system_settings WHERE organization_id=$1 AND key=$2`,
      [orgId, req.params.key]
    );
    if (!rows.length) throw new AppError(404, "Setting not found");
    res.json(rows[0]);
  } catch (e) { next(e);}
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

// Inventory cost method immutability (Phase 4)
if (key === "inventoryCostMethod") {
  const current = before[0]?.value_json || null;
  if (current?.locked) throw new AppError(409, "inventoryCostMethod is locked once accounting starts");
  // If any posted journal exists, lock and prevent change
  const { rows: posted } = await pool.query(
    `SELECT 1 FROM journal_entries WHERE organization_id=$1 AND status='posted' LIMIT 1`,
    [orgId]
  );
  if (posted.length) {
    // lock to current or requested method, but reject changing once started
    const method = current?.method || value?.method || "WEIGHTED_AVERAGE";
    await pool.query(
      `INSERT INTO system_settings(organization_id, key, value_json)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (organization_id, key) DO UPDATE SET value_json=EXCLUDED.value_json`,
      [orgId, key, JSON.stringify({ method, locked: true })]
    );
    throw new AppError(409, "inventoryCostMethod is now locked;cannot be changed after accounting activity begins");
  }
  // Validate payload
  if (!value?.method || !["WEIGHTED_AVERAGE","FIFO"].includes(value.method)) throw new AppError(400, "inventoryCostMethod.method must be WEIGHTED_AVERAGE or FIFO");
  value.locked = false;
}

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
  } catch (e) { next(e);}
});

module.exports = router;
