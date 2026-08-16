const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");

router.use(authRequired);

// =============================================================================
// NEW-ORGANIZATION ONBOARDING
// =============================================================================
// Only organizations created after migration 145 are marked as requiring this
// setup. Existing organizations remain unaffected. The setup writes the actual
// workflow/approval configuration used by journal posting; it is not a UI-only
// preference.

const ONBOARDING_SETTING_KEY = "organizationOnboarding";

function requireBoolean(body, key, fallback = undefined) {
  const value = body?.[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new AppError(400, `${key} must be a boolean`);
  return value;
}

async function readOnboardingState({ orgId, userId, client = pool }) {
  const { rows: orgRows } = await client.query(
    `SELECT id, name, base_currency_code, contact_email, contact_phone, address_json,
            onboarding_required, onboarding_completed_at, onboarding_completed_by_user_id
       FROM organizations
      WHERE id=$1
      LIMIT 1`,
    [orgId]
  );
  if (!orgRows.length) throw new AppError(404, "Organization not found");

  const { rows: userRows } = await client.query(
    `SELECT id, email, first_name, last_name, full_name
       FROM users
      WHERE organization_id=$1 AND id=$2
      LIMIT 1`,
    [orgId, userId]
  );
  if (!userRows.length) throw new AppError(404, "User not found");

  const { rows: invRows } = await client.query(
    `SELECT value_json
       FROM system_settings
      WHERE organization_id=$1 AND key='inventoryCostMethod'
      LIMIT 1`,
    [orgId]
  );

  const { rows: journalTypes } = await client.query(
    `SELECT id FROM document_types
      WHERE organization_id=$1 AND code='JOURNAL_ENTRY' AND is_active=TRUE
      LIMIT 1`,
    [orgId]
  );
  const journalDocumentTypeId = journalTypes[0]?.id || null;

  const { rows: ruleRows } = await client.query(
    `SELECT creator_can_approve, creator_can_post, allow_self_approval,
            require_comment_on_rejection, notify_creator_on_approval,
            notify_creator_on_rejection
       FROM document_workflow_statics
      WHERE organization_id=$1
        AND entity_type='journal_entry'
        AND ($2::uuid IS NULL OR document_type_id=$2 OR document_type_id IS NULL)
      ORDER BY CASE WHEN document_type_id=$2 THEN 0 ELSE 1 END, updated_at DESC, created_at DESC
      LIMIT 1`,
    [orgId, journalDocumentTypeId]
  );

  let approvalRequired = false;
  if (journalDocumentTypeId) {
    const { rows } = await client.query(
      `SELECT EXISTS(
         SELECT 1
           FROM document_type_approval_levels dtal
           JOIN approval_levels al ON al.id=dtal.approval_level_id
          WHERE dtal.document_type_id=$1
            AND al.organization_id=$2
            AND al.is_active=TRUE
       ) AS required`,
      [journalDocumentTypeId, orgId]
    );
    approvalRequired = Boolean(rows[0]?.required);
  }

  const rule = ruleRows[0] || {};
  const inv = invRows[0]?.value_json || {};
  const org = orgRows[0];
  const user = userRows[0];

  return {
    required: Boolean(org.onboarding_required),
    completed: !org.onboarding_required && Boolean(org.onboarding_completed_at),
    completedAt: org.onboarding_completed_at || null,
    organization: {
      id: org.id,
      name: org.name,
      baseCurrencyCode: org.base_currency_code,
      contactEmail: org.contact_email || user.email || "",
      contactPhone: org.contact_phone || "",
      address: org.address_json && typeof org.address_json === "object" ? org.address_json : {}
    },
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name || [user.first_name, user.last_name].filter(Boolean).join(" ") || ""
    },
    accounting: {
      inventoryCostMethod: ["FIFO", "WEIGHTED_AVERAGE"].includes(inv.method) ? inv.method : "WEIGHTED_AVERAGE"
    },
    journalWorkflow: {
      approvalRequired: org.onboarding_required && !ruleRows.length ? true : approvalRequired,
      creatorCanApprove: org.onboarding_required && !ruleRows.length ? true : Boolean(rule.creator_can_approve || rule.allow_self_approval),
      creatorCanPost: org.onboarding_required && !ruleRows.length ? true : Boolean(rule.creator_can_post),
      requireCommentOnRejection: rule.require_comment_on_rejection !== false,
      notifyCreatorOnApproval: rule.notify_creator_on_approval !== false,
      notifyCreatorOnRejection: rule.notify_creator_on_rejection !== false
    }
  };
}

router.get("/onboarding", async (req, res, next) => {
  try {
    res.json(await readOnboardingState({ orgId: req.user.organization_id, userId: req.user.id }));
  } catch (e) { next(e); }
});

router.put("/onboarding", requirePermission("settings.manage"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.user.organization_id;
    const userId = req.user.id;
    const body = req.body || {};
    const fullName = String(body.fullName || "").trim().replace(/\s+/g, " ");
    if (fullName.length < 2) throw new AppError(400, "fullName is required");
    if (fullName.length > 160) throw new AppError(400, "fullName is too long");

    const contactEmail = String(body.contactEmail || "").trim().toLowerCase();
    const contactPhone = String(body.contactPhone || "").trim();
    const addressLine1 = String(body.addressLine1 || "").trim();
    const city = String(body.city || "").trim();
    const country = String(body.country || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new AppError(400, "A valid organization contactEmail is required");
    if (!contactPhone) throw new AppError(400, "contactPhone is required");
    if (!addressLine1) throw new AppError(400, "addressLine1 is required");
    if (!city) throw new AppError(400, "city is required");
    if (!country) throw new AppError(400, "country is required");

    const inventoryCostMethod = String(body.inventoryCostMethod || "").trim().toUpperCase();
    if (!["FIFO", "WEIGHTED_AVERAGE"].includes(inventoryCostMethod)) {
      throw new AppError(400, "inventoryCostMethod must be FIFO or WEIGHTED_AVERAGE");
    }

    const approvalRequired = requireBoolean(body, "approvalRequired");
    const creatorCanApprove = requireBoolean(body, "creatorCanApprove");
    const creatorCanPost = requireBoolean(body, "creatorCanPost");
    const requireCommentOnRejection = requireBoolean(body, "requireCommentOnRejection", true);
    const notifyCreatorOnApproval = requireBoolean(body, "notifyCreatorOnApproval", true);
    const notifyCreatorOnRejection = requireBoolean(body, "notifyCreatorOnRejection", true);

    await client.query("BEGIN");

    const before = await readOnboardingState({ orgId, userId, client });
    const { rows: orgRows } = await client.query(
      `SELECT onboarding_required FROM organizations WHERE id=$1 FOR UPDATE`,
      [orgId]
    );
    if (!orgRows.length) throw new AppError(404, "Organization not found");
    if (!orgRows[0].onboarding_required) {
      throw new AppError(409, "Organization onboarding is already complete; use System Settings for later changes");
    }

    // The signed-in user's full name is mandatory because it is used on every
    // printed accounting document generated by that user.
    await client.query(
      `UPDATE users SET full_name=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, userId, fullName]
    );

    // Core organization identity/contact data is mandatory because it appears
    // on accounting documents and is needed before normal operation begins.
    await client.query(
      `UPDATE organizations
          SET contact_email=$2, contact_phone=$3,
              address_json=COALESCE(address_json, '{}'::jsonb) || $4::jsonb,
              updated_at=NOW()
        WHERE id=$1`,
      [orgId, contactEmail, contactPhone, JSON.stringify({ addressLine1, city, country })]
    );

    // Inventory costing is a real accounting policy. Do not permit onboarding
    // to mutate it after posting activity has started.
    const { rows: posted } = await client.query(
      `SELECT 1 FROM journal_entries WHERE organization_id=$1 AND status IN ('posted','voided') LIMIT 1`,
      [orgId]
    );
    const { rows: currentInv } = await client.query(
      `SELECT value_json FROM system_settings WHERE organization_id=$1 AND key='inventoryCostMethod' LIMIT 1`,
      [orgId]
    );
    const currentMethod = currentInv[0]?.value_json?.method;
    if (posted.length && currentMethod && currentMethod !== inventoryCostMethod) {
      throw new AppError(409, "Inventory costing method cannot be changed after accounting activity begins");
    }
    await client.query(
      `INSERT INTO system_settings(organization_id, key, value_json)
       VALUES($1,'inventoryCostMethod',$2::jsonb)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value_json=EXCLUDED.value_json`,
      [orgId, JSON.stringify({ method: inventoryCostMethod, locked: posted.length > 0 })]
    );

    const { rows: journalTypes } = await client.query(
      `SELECT id FROM document_types WHERE organization_id=$1 AND code='JOURNAL_ENTRY' AND is_active=TRUE LIMIT 1`,
      [orgId]
    );
    if (!journalTypes.length) throw new AppError(409, "Journal Entry document type is not initialized");
    const journalDocumentTypeId = journalTypes[0].id;

    // Maintain one precise journal rule instead of relying on an arbitrary
    // org-wide rule that could later be shadowed by another document type.
    await client.query(
      `DELETE FROM document_workflow_statics
        WHERE organization_id=$1
          AND entity_type='journal_entry'
          AND (document_type_id=$2 OR document_type_id IS NULL)`,
      [orgId, journalDocumentTypeId]
    );
    await client.query(
      `INSERT INTO document_workflow_statics(
         organization_id, document_type_id, entity_type,
         creator_can_approve, creator_can_post, allow_self_approval,
         require_comment_on_rejection, notify_creator_on_approval,
         notify_creator_on_rejection, created_by_user_id, updated_by_user_id
       ) VALUES ($1,$2,'journal_entry',$3,$4,$3,$5,$6,$7,$8,$8)`,
      [
        orgId, journalDocumentTypeId, creatorCanApprove, creatorCanPost,
        requireCommentOnRejection, notifyCreatorOnApproval, notifyCreatorOnRejection, userId
      ]
    );

    // Approval-required is represented by the real JOURNAL_ENTRY approval
    // ladder. With no ladder, posting can proceed without a workflow approval
    // (subject to creator_can_post and RBAC permissions).
    await client.query(`DELETE FROM document_type_approval_levels WHERE document_type_id=$1`, [journalDocumentTypeId]);
    if (approvalRequired) {
      let { rows: levels } = await client.query(
        `SELECT id FROM approval_levels WHERE organization_id=$1 AND code='JOURNAL_APPROVAL' LIMIT 1`,
        [orgId]
      );
      let levelId = levels[0]?.id;
      if (!levelId) {
        const { rows: seqRows } = await client.query(
          `SELECT COALESCE(MAX(sequence),0)+10 AS sequence FROM approval_levels WHERE organization_id=$1`,
          [orgId]
        );
        const created = await client.query(
          `INSERT INTO approval_levels(organization_id, code, name, sequence, is_active)
           VALUES($1,'JOURNAL_APPROVAL','Journal Approval',$2,TRUE)
           RETURNING id`,
          [orgId, seqRows[0].sequence]
        );
        levelId = created.rows[0].id;
      } else {
        await client.query(`UPDATE approval_levels SET is_active=TRUE WHERE id=$1 AND organization_id=$2`, [levelId, orgId]);
      }
      await client.query(
        `INSERT INTO document_type_approval_levels(document_type_id, approval_level_id, position)
         VALUES($1,$2,0)
         ON CONFLICT DO NOTHING`,
        [journalDocumentTypeId, levelId]
      );
    }

    const onboardingValue = {
      completed: true,
      completedAt: new Date().toISOString(),
      organizationProfile: { contactEmail, contactPhone, addressLine1, city, country },
      inventoryCostMethod,
      journalWorkflow: {
        approvalRequired,
        creatorCanApprove,
        creatorCanPost,
        requireCommentOnRejection,
        notifyCreatorOnApproval,
        notifyCreatorOnRejection
      }
    };
    await client.query(
      `INSERT INTO system_settings(organization_id, key, value_json)
       VALUES($1,$2,$3::jsonb)
       ON CONFLICT (organization_id, key) DO UPDATE SET value_json=EXCLUDED.value_json`,
      [orgId, ONBOARDING_SETTING_KEY, JSON.stringify(onboardingValue)]
    );

    await client.query(
      `UPDATE organizations
          SET onboarding_required=FALSE,
              onboarding_completed_at=COALESCE(onboarding_completed_at,NOW()),
              onboarding_completed_by_user_id=$2,
              updated_at=NOW()
        WHERE id=$1`,
      [orgId, userId]
    );

    const after = await readOnboardingState({ orgId, userId, client });
    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "organization.onboarding.completed",
      entityType: "organizations",
      entityId: orgId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before,
      after,
      client
    });

    await client.query("COMMIT");
    res.json(after);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    next(e);
  } finally {
    client.release();
  }
});

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

// router.get("/:key", requirePermission("settings.read"), async (req, res, next) => {
//   try {
//     const orgId = req.user.organization_id;
//     console.log(orgId,"This is the orgId for getting a setting----=-")
//     const { rows } = await pool.query(
//       `SELECT key, value_json FROM system_settings WHERE organization_id=$1 AND key=$2`,
//       [orgId, req.params.key]
//     );
//     if (!rows.length) throw new AppError(404, "Setting not found");
//     res.json(rows[0]);
//   } catch (e) { next(e); }
// });

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
      console.log(rows, "This is the list of workflow rules");
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

      // Start a transaction to ensure data consistency
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');

        // First, delete all existing rules with the same scope
        await client.query(
          `DELETE FROM document_workflow_statics
           WHERE organization_id = $1
             AND (
               (document_type_id IS NULL AND $2::uuid IS NULL AND $3::text IS NULL) OR
               (document_type_id = $2 AND entity_type IS NULL AND $3::text IS NULL) OR
               (document_type_id IS NULL AND $2::uuid IS NULL AND entity_type = $3) OR
               (document_type_id = $2 AND entity_type = $3)
             )`,
          [orgId, documentTypeId, entityType]
        );

        // Then insert the new rule
        const { rows } = await client.query(
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

        await client.query('COMMIT');

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
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (e) {
      // Note: The 23505 (unique violation) error won't occur anymore since we delete first,
      // but we'll keep this for safety in case something else triggers it
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