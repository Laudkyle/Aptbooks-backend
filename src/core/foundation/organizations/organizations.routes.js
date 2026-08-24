const { createModuleBodyContract } = require("../../../shared/http/requestValidation");
const router = require("express").Router();
router.use(createModuleBodyContract(['address_json', 'address_line_1', 'address_line_2', 'branding_json', 'city', 'contact_email', 'contact_phone', 'country', 'logo_url', 'name', 'postal_code', 'primary_color', 'registration_number', 'secondary_color', 'state', 'tax_id', 'website']));
const { pool } = require("../../../db/pool");
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../audit-logs/audit.service");
const { parseMultipart } = require("../../../shared/http/multipart");
const docsRepo = require("../../../workflow/documents/documents.repository");
const docsSvc = require("../../../workflow/documents/documents.service");
// Org-scoped reads should be authenticated
router.get("/me", authRequired, async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(`SELECT * FROM organizations WHERE id=$1`, [orgId]);
    if (!rows.length) throw new AppError(404, "Org not found");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.patch(
  "/me",
  authRequired,
  requirePermission("settings.manage"),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;

      const { rows: before } = await pool.query(
        `SELECT * FROM organizations WHERE id = $1`,
        [orgId]
      );
      if (!before.length) throw new AppError(404, "Organization not found.");

      const current = before[0];

      const currentAddress =
        current.address_json && typeof current.address_json === "object"
          ? current.address_json
          : {};

      const currentBranding =
        current.branding_json && typeof current.branding_json === "object"
          ? current.branding_json
          : {};

      const nextAddress =
        req.body?.address_json !== undefined
          ? req.body.address_json
          : {
              ...currentAddress,
              ...(req.body?.address_line_1 !== undefined
                ? { addressLine1: req.body.address_line_1 }
                : {}),
              ...(req.body?.address_line_2 !== undefined
                ? { addressLine2: req.body.address_line_2 }
                : {}),
              ...(req.body?.city !== undefined ? { city: req.body.city } : {}),
              ...(req.body?.state !== undefined ? { state: req.body.state } : {}),
              ...(req.body?.postal_code !== undefined
                ? { postalCode: req.body.postal_code }
                : {}),
              ...(req.body?.country !== undefined
                ? { country: req.body.country }
                : {})
            };

      const nextBranding =
        req.body?.branding_json !== undefined
          ? req.body.branding_json
          : {
              ...currentBranding,
              ...(req.body?.website !== undefined
                ? { website: req.body.website }
                : {}),
              ...(req.body?.registration_number !== undefined
                ? { registrationNumber: req.body.registration_number }
                : {}),
              ...(req.body?.tax_id !== undefined
                ? { taxId: req.body.tax_id }
                : {}),
              ...(req.body?.primary_color !== undefined
                ? { primaryColor: req.body.primary_color }
                : {}),
              ...(req.body?.secondary_color !== undefined
                ? { secondaryColor: req.body.secondary_color }
                : {}),
              ...(req.body?.logo_url !== undefined
                ? { logoUrl: req.body.logo_url }
                : {})
            };

      const nextName =
        req.body?.name !== undefined ? req.body.name : current.name;

      const nextContactEmail =
        req.body?.contact_email !== undefined
          ? req.body.contact_email
          : current.contact_email;

      const nextContactPhone =
        req.body?.contact_phone !== undefined
          ? req.body.contact_phone
          : current.contact_phone;

      const { rows } = await pool.query(
        `
        UPDATE organizations
           SET name = $2,
               contact_email = $3,
               contact_phone = $4,
               address_json = $5::jsonb,
               branding_json = $6::jsonb,
               updated_at = NOW()
         WHERE id = $1
         RETURNING *
        `,
        [
          orgId,
          nextName,
          nextContactEmail,
          nextContactPhone,
          JSON.stringify(nextAddress || {}),
          JSON.stringify(nextBranding || {})
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
    } catch (e) {
      next(e);
    }
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
    } catch (e) { next(e); }
  }
);

module.exports = router;
