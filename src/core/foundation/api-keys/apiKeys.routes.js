const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");
const { generatePrefix, generateSecret, hashSecret, makeApiKey } = require("../../../shared/security/apiKeys");

router.use(authRequired);

// List API keys (secrets never returned)
router.get("/", requirePermission("settings.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(
      `SELECT id, name, prefix, is_active, created_at, revoked_at, user_id
         FROM api_keys
        WHERE organization_id=$1
        ORDER BY created_at DESC`,
      [orgId]
    );
    res.json({ data: rows });
  } catch (e) { next(e); }
});

// Create API key
router.post("/", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const name = String(req.body?.name || "").trim();
    if (!name) throw new AppError(400, "name required");

    const prefix = generatePrefix();
    const secret = generateSecret();
    const secretHash = hashSecret(secret);
    const apiKey = makeApiKey(prefix, secret);

    const { rows } = await pool.query(
      `INSERT INTO api_keys(organization_id, user_id, name, prefix, secret_hash)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, prefix, is_active, created_at`,
      [orgId, req.user.id, name, prefix, secretHash]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "api_key.created",
      entityType: "api_keys",
      entityId: rows[0].id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: rows[0]
    });

    // Return secret only once
    res.status(201).json({ ...rows[0], apiKey });
  } catch (e) { next(e); }
});

// Revoke API key
router.post("/:id/revoke", requirePermission("settings.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const id = req.params.id;
    const { rows: before } = await pool.query(
      `SELECT id, name, prefix, is_active FROM api_keys WHERE organization_id=$1 AND id=$2`,
      [orgId, id]
    );
    if (!before.length) throw new AppError(404, "API key not found");

    const { rows } = await pool.query(
      `UPDATE api_keys SET is_active=FALSE, revoked_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING id, name, prefix, is_active, revoked_at`,
      [orgId, id]
    );

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "api_key.revoked",
      entityType: "api_keys",
      entityId: id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: before[0],
      after: rows[0]
    });

    res.json(rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
