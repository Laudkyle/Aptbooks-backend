const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");

router.use(authRequired);

// =============================================================================
// SYSTEM SETTINGS
// =============================================================================

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
      try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
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

    // Inventory cost method immutability (Phase 4)
    if (key === "inventoryCostMethod") {
      const current = before[0]?.value_json || null;
      if (current?.locked) throw new AppError(409, "inventoryCostMethod is locked once accounting starts");
      const { rows: posted } = await pool.query(
        `SELECT 1 FROM journal_entries WHERE organization_id=$1 AND status='posted' LIMIT 1`,
        [orgId]
      );
      if (posted.length) {
        const method = current?.method || value?.method || "WEIGHTED_AVERAGE";
        await pool.query(
          `INSERT INTO system_settings(organization_id, key, value_json)
           VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (organization_id, key) DO UPDATE SET value_json=EXCLUDED.value_json`,
          [orgId, key, JSON.stringify({ method, locked: true })]
        );
        throw new AppError(409, "inventoryCostMethod is now locked; cannot be changed after accounting activity begins");
      }
      if (!value?.method || !["WEIGHTED_AVERAGE", "FIFO"].includes(value.method))
        throw new AppError(400, "inventoryCostMethod.method must be WEIGHTED_AVERAGE or FIFO");
      value.locked = false;
    }

    const { rows: after } = await pool.query(
      `INSERT INTO system_settings(organization_id, key, value_json)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value_json=EXCLUDED.value_json
       RETURNING key, value_json`,
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


// =============================================================================
// DOCUMENT WORKFLOW STATICS
// Resolution order (most → least specific):
//   1. org + document_type_id + entity_type
//   2. org + document_type_id + NULL entity_type
//   3. org + NULL document_type_id + entity_type
//   4. org + NULL document_type_id + NULL entity_type  (org-wide fallback)
// =============================================================================

// ── Helpers ───────────────────────────────────────────────────────────────────

const DWS_COLUMNS = `
  id,
  organization_id,
  document_type_id,
  entity_type,
  creator_can_approve,
  creator_can_post,
  allow_self_approval,
  require_comment_on_rejection,
  notify_creator_on_approval,
  notify_creator_on_rejection,
  created_by_user_id,
  updated_by_user_id,
  created_at,
  updated_at
`;

// Validates and extracts only the known boolean rule fields from a request body
function extractRuleFields(body) {
  const BOOLEAN_FIELDS = [
    "creator_can_approve",
    "creator_can_post",
    "allow_self_approval",
    "require_comment_on_rejection",
    "notify_creator_on_approval",
    "notify_creator_on_rejection"
  ];

  const fields = {};
  for (const f of BOOLEAN_FIELDS) {
    if (body[f] !== undefined) {
      if (typeof body[f] !== "boolean") {
        throw new AppError(400, `Field '${f}' must be a boolean`);
      }
      fields[f] = body[f];
    }
  }
  return fields;
}

// ── List all rules for the org ────────────────────────────────────────────────

router.get(
  "/workflow-statics",
  requirePermission("settings.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;

      const { rows } = await pool.query(
        `SELECT ${DWS_COLUMNS}
         FROM document_workflow_statics
         WHERE organization_id = $1
         ORDER BY
           document_type_id NULLS LAST,
           entity_type       NULLS LAST,
           created_at        ASC`,
        [orgId]
      );

      res.json({ ok: true, data: rows });
    } catch (e) { next(e); }
  }
);

// ── Resolve — most specific rule for a given context ─────────────────────────
// GET /workflow-statics/resolve?document_type_id=<uuid>&entity_type=<string>
// Returns the single most specific matching rule, or 404 if none configured.

router.get(
  "/workflow-statics/resolve",
  requirePermission("settings.read"),
  async (req, res, next) => {
    try {
      const orgId         = req.user.organization_id;
      const documentTypeId = req.query.document_type_id || null;
      const entityType     = req.query.entity_type     || null;

      // Walk specificity order — return the first row found
      const candidates = [
        // 1. exact match on both
        {
          sql:    `WHERE organization_id=$1 AND document_type_id=$2 AND entity_type=$3`,
          params: [orgId, documentTypeId, entityType]
        },
        // 2. exact doc type, any entity
        {
          sql:    `WHERE organization_id=$1 AND document_type_id=$2 AND entity_type IS NULL`,
          params: [orgId, documentTypeId]
        },
        // 3. any doc type, exact entity
        {
          sql:    `WHERE organization_id=$1 AND document_type_id IS NULL AND entity_type=$2`,
          params: [orgId, entityType]
        },
        // 4. org-wide fallback
        {
          sql:    `WHERE organization_id=$1 AND document_type_id IS NULL AND entity_type IS NULL`,
          params: [orgId]
        }
      ];

      let match = null;
      for (const c of candidates) {
        const { rows } = await pool.query(
          `SELECT ${DWS_COLUMNS} FROM document_workflow_statics ${c.sql} LIMIT 1`,
          c.params
        );
        if (rows.length) { match = rows[0]; break; }
      }

      if (!match) throw new AppError(404, "No workflow rule configured for this context");
      res.json(match);
    } catch (e) { next(e); }
  }
);

// ── Get one rule by ID ────────────────────────────────────────────────────────

router.get(
  "/workflow-statics/:id",
  requirePermission("settings.read"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;

      const { rows } = await pool.query(
        `SELECT ${DWS_COLUMNS}
         FROM document_workflow_statics
         WHERE id = $1 AND organization_id = $2`,
        [req.params.id, orgId]
      );

      if (!rows.length) throw new AppError(404, "Workflow rule not found");
      res.json(rows[0]);
    } catch (e) { next(e); }
  }
);

// ── Create a new rule ─────────────────────────────────────────────────────────

router.post(
  "/workflow-statics",
  requirePermission("settings.manage"),
  async (req, res, next) => {
    try {
      const orgId          = req.user.organization_id;
      const documentTypeId = req.body.document_type_id || null;
      const entityType     = req.body.entity_type      || null;
      const fields         = extractRuleFields(req.body);

      const { rows } = await pool.query(
        `INSERT INTO document_workflow_statics
           (organization_id, document_type_id, entity_type,
            creator_can_approve, creator_can_post, allow_self_approval,
            require_comment_on_rejection,
            notify_creator_on_approval, notify_creator_on_rejection,
            created_by_user_id, updated_by_user_id)
         VALUES
           ($1, $2, $3,
            $4, $5, $6,
            $7,
            $8, $9,
            $10, $10)
         RETURNING ${DWS_COLUMNS}`,
        [
          orgId,
          documentTypeId,
          entityType,
          fields.creator_can_approve          ?? false,
          fields.creator_can_post             ?? false,
          fields.allow_self_approval          ?? false,
          fields.require_comment_on_rejection ?? true,
          fields.notify_creator_on_approval   ?? true,
          fields.notify_creator_on_rejection  ?? true,
          req.user.id
        ]
      );

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "workflow_static.created",
        entityType: "document_workflow_statics",
        entityId: rows[0].id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        after: rows[0]
      });

      res.status(201).json(rows[0]);
    } catch (e) {
      if (e?.code === "23505") {
        return next(new AppError(409, "A rule already exists for this organisation / document type / entity type combination"));
      }
      next(e);
    }
  }
);

// ── Update an existing rule ───────────────────────────────────────────────────

router.patch(
  "/workflow-statics/:id",
  requirePermission("settings.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const fields = extractRuleFields(req.body);

      if (Object.keys(fields).length === 0) {
        throw new AppError(400, "No valid fields provided for update");
      }

      // Fetch before-state for audit
      const { rows: before } = await pool.query(
        `SELECT ${DWS_COLUMNS} FROM document_workflow_statics WHERE id=$1 AND organization_id=$2`,
        [req.params.id, orgId]
      );
      if (!before.length) throw new AppError(404, "Workflow rule not found");

      // Build SET clause dynamically from only the fields provided
      const setClauses = Object.keys(fields).map((f, i) => `${f} = $${i + 3}`);
      setClauses.push(`updated_by_user_id = $${setClauses.length + 3}`);
      const values = [
        req.params.id,
        orgId,
        ...Object.values(fields),
        req.user.id
      ];

      const { rows: after } = await pool.query(
        `UPDATE document_workflow_statics
         SET ${setClauses.join(", ")}
         WHERE id = $1 AND organization_id = $2
         RETURNING ${DWS_COLUMNS}`,
        values
      );

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "workflow_static.updated",
        entityType: "document_workflow_statics",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        before: before[0],
        after: after[0]
      });

      res.json(after[0]);
    } catch (e) { next(e); }
  }
);

// ── Delete a rule ─────────────────────────────────────────────────────────────

router.delete(
  "/workflow-statics/:id",
  requirePermission("settings.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;

      const { rows } = await pool.query(
        `DELETE FROM document_workflow_statics
         WHERE id = $1 AND organization_id = $2
         RETURNING ${DWS_COLUMNS}`,
        [req.params.id, orgId]
      );

      if (!rows.length) throw new AppError(404, "Workflow rule not found");

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "workflow_static.deleted",
        entityType: "document_workflow_statics",
        entityId: req.params.id,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        before: rows[0],
        after: null
      });

      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);


module.exports = router;