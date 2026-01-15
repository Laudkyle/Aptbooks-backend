const router = require("express").Router();
const { requirePermission } = require("../../middleware/permission.middleware");
const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");
const svc = require("./audit.service");

router.use(requirePermission("reporting.audit.read"));

// User activity + audit log stream
router.get("/activity", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.listActivity({ orgId, query: req.query });
    res.json({ data: out });
  } catch (e) { next(e); }
});

// Reporting definition changes (triggered audit table from Stage 5)
router.get("/definition-changes", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const out = await svc.listDefinitionChanges({ orgId, query: req.query });
    res.json({ data: out });
  } catch (e) { next(e); }
});

// Period close audit pack summary
router.get("/period-close", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { periodId } = req.query;
    const out = await svc.periodCloseAudit({ orgId, periodId });
    res.json({ data: out });
  } catch (e) { next(e); }
});

// CSV export for activity logs
router.get("/export", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const rows = await svc.listActivity({ orgId, query: req.query });

    const header = ["created_at","action","entity_type","entity_id","actor_user_id","ip","user_agent"]; 
    const lines = [header.join(",")];
    for (const r of rows) {
      const vals = [
        r.created_at,
        r.action,
        r.entity_type,
        r.entity_id,
        r.actor_user_id,
        r.ip,
        (r.user_agent || "")
      ].map((v) => {
        const s = v === null || v === undefined ? "" : String(v);
        // CSV quote
        const esc = s.replace(/"/g, '""');
        return /[\n",]/.test(esc) ? `"${esc}"` : esc;
      });
      lines.push(vals.join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit_activity_${Date.now()}.csv"`);
    res.send(lines.join("\n"));
  } catch (e) { next(e); }
});

// Schedule audit exports (stored configuration; actual delivery can be implemented via scheduler later)
router.post("/export/schedule", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { name, filters, cron, is_enabled } = req.body || {};
    if (!name) throw new AppError(400, "name required");
    if (!cron) throw new AppError(400, "cron required");
    const { rows } = await pool.query(
      `INSERT INTO audit_export_schedules(organization_id, created_by_user_id, name, filters_json, cron, is_enabled)
       VALUES ($1,$2,$3,$4::jsonb,$5,COALESCE($6, TRUE))
       RETURNING *`,
      [orgId, req.user.id, name, JSON.stringify(filters || {}), cron, is_enabled]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
