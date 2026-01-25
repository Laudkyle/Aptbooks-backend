const router = require("express").Router();
const { pool } = require("../../../db/pool");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");
const { parseMultipart } = require("../../../shared/http/multipart");
const docsRepo = require("../../../workflow/documents/documents.repository");
const docsSvc = require("../../../workflow/documents/documents.service");

router.post("/", async (req, res, next) => {
  try {
    // If you want org creation locked down, add an admin bootstrap rule later.
    const { name, baseCurrencyCode } = req.body || {};
    if (!name) throw new AppError(400, "name required");

    const currencyCode = (baseCurrencyCode || "GHS").toUpperCase();
    const { rows: cRows } = await pool.query(`SELECT code FROM currencies WHERE code=$1`, [currencyCode]);
    if (!cRows.length) throw new AppError(400, "Invalid baseCurrencyCode");

    const { rows } = await pool.query(
      `INSERT INTO organizations(name, base_currency_code) VALUES ($1,$2) RETURNING *`,
      [name, currencyCode]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e);}
});

// Org-scoped reads should be authenticated
router.get("/me", authRequired, async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(`SELECT * FROM organizations WHERE id=$1`, [orgId]);
    if (!rows.length) throw new AppError(404, "Org not found");
    res.json(rows[0]);
  } catch (e) { next(e);}
});

// Update organization profile fields
router.patch(
  "/me",
  authRequired,
  requirePermission("settings.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const allowed = {
        name: req.body?.name,
        contact_email: req.body?.contact_email,
        contact_phone: req.body?.contact_phone,
        address_json: req.body?.address_json,
        branding_json: req.body?.branding_json
      };

      const { rows: before } = await pool.query(`SELECT * FROM organizations WHERE id=$1`, [orgId]);
      if (!before.length) throw new AppError(404, "Org not found");

      const { rows } = await pool.query(
        `
        UPDATE organizations
           SET name = COALESCE($2, name),
               contact_email = COALESCE($3, contact_email),
               contact_phone = COALESCE($4, contact_phone),
               address_json = COALESCE($5::jsonb, address_json),
               branding_json = COALESCE($6::jsonb, branding_json),
               updated_at = NOW()
         WHERE id=$1
         RETURNING *
        `,
        [
          orgId,
          allowed.name || null,
          allowed.contact_email || null,
          allowed.contact_phone || null,
          allowed.address_json !== undefined ? JSON.stringify(allowed.address_json) : null,
          allowed.branding_json !== undefined ? JSON.stringify(allowed.branding_json) : null
        ]
      );

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "organization.updated",
        entityType: "organizations",
        entityId: orgId,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        before: before[0],
        after: rows[0]
      });

      res.json(rows[0]);
    } catch (e) { next(e);}
  }
);

// Upload organization logo (multipart/form-data, field name: file)
router.post(
  "/me/logo",
  authRequired,
  requirePermission("settings.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      const { files } = await parseMultipart(req, { maxBytes: 5 * 1024 * 1024 });
      const file = files?.file;
      if (!file) throw new AppError(400, "file is required (multipart/form-data field 'file')");

      // Ensure document type exists
      const { rows: dtRows } = await pool.query(
        `SELECT id FROM document_types WHERE (organization_id=$1 OR organization_id IS NULL) AND code='ORG_LOGO' LIMIT 1`,
        [orgId]
      );
      let documentTypeId = dtRows[0]?.id || null;
      if (!documentTypeId) {
        const dt = await docsRepo.createDocumentType({
          orgId,
          payload: { code: "ORG_LOGO", name: "Organization Logo", description: "Organization branding logo" }
        });
        documentTypeId = dt.id;
      }

      // Create document bound to the organization
      const doc = await docsSvc.createDocument({
        orgId,
        userId: req.user.id,
        payload: {
          document_type_id: documentTypeId,
          title: "Organization Logo",
          description: "Organization logo upload",
          entity_type: "organization",
          entity_id: orgId,
          entity_ref: null
        }
      });

      const { version } = await docsSvc.addVersionFromBuffer({
        orgId,
        documentId: doc.id,
        userId: req.user.id,
        originalFilename: file.filename,
        mimeType: file.contentType,
        buffer: file.buffer
      });

      const { rows: before } = await pool.query(`SELECT logo_document_id FROM organizations WHERE id=$1`, [orgId]);

      const { rows: after } = await pool.query(
        `UPDATE organizations SET logo_document_id=$2, updated_at=NOW() WHERE id=$1 RETURNING id, logo_document_id`,
        [orgId, doc.id]
      );

      await writeAudit({
        organizationId: orgId,
        actorUserId: req.user.id,
        action: "organization.logo_uploaded",
        entityType: "organizations",
        entityId: orgId,
        ip: req.audit?.ip,
        userAgent: req.audit?.userAgent,
        before: { logo_document_id: before[0]?.logo_document_id || null },
        after: { logo_document_id: after[0]?.logo_document_id || null, document_id: doc.id, version_no: version.version_no }
      });

      res.status(201).json({ document: doc, version, organization: after[0] });
    } catch (e) { next(e);}
  }
);

module.exports = router;
