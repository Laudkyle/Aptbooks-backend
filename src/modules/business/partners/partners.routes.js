const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

const svc = require("./partners.service");
const {
  createPartnerSchema,
  updatePartnerSchema,
  listPartnersQuerySchema,
  createContactSchema,
  updateContactSchema,
  createAddressSchema,
  updateAddressSchema
} = require("../../../shared/validators/business/partners.validators");

router.use(authRequired);

// PARTNERS
router.post("/", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createPartnerSchema, req.body);
    const created = await svc.createPartner({ orgId, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.created",
      entityType: "business_partners",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Partner already exists"));
    next(e);
  }
});

router.get("/", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const query = validate(listPartnersQuerySchema, req.query);
    res.json(await svc.listPartners({ orgId, query }));
  } catch (e) { next(e); }
});

router.get("/:id", requirePermission("partners.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    res.json(await svc.getPartnerDetails({ orgId, partnerId: req.params.id }));
  } catch (e) { next(e); }
});

router.patch("/:id", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updatePartnerSchema, req.body);
    const out = await svc.updatePartner({ orgId, partnerId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.updated",
      entityType: "business_partners",
      entityId: req.params.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) {
    if (e?.code === "23505") return next(new AppError(409, "Partner already exists"));
    next(e);
  }
});

// CONTACTS
router.post("/:id/contacts", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createContactSchema, req.body);
    const created = await svc.addContact({ orgId, partnerId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.contact.created",
      entityType: "business_partner_contacts",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.patch("/:id/contacts/:contactId", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updateContactSchema, req.body);
    const out = await svc.updateContact({
      orgId,
      partnerId: req.params.id,
      contactId: req.params.contactId,
      payload
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.contact.updated",
      entityType: "business_partner_contacts",
      entityId: req.params.contactId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) { next(e); }
});

// ADDRESSES
router.post("/:id/addresses", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(createAddressSchema, req.body);
    const created = await svc.addAddress({ orgId, partnerId: req.params.id, payload });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.address.created",
      entityType: "business_partner_addresses",
      entityId: created.id,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      after: created
    });

    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.patch("/:id/addresses/:addressId", requirePermission("partners.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const payload = validate(updateAddressSchema, req.body);
    const out = await svc.updateAddress({
      orgId,
      partnerId: req.params.id,
      addressId: req.params.addressId,
      payload
    });

    await writeAudit({
      organizationId: orgId,
      actorUserId: req.user.id,
      action: "partner.address.updated",
      entityType: "business_partner_addresses",
      entityId: req.params.addressId,
      ip: req.audit?.ip,
      userAgent: req.audit?.userAgent,
      before: out.before,
      after: out.after
    });

    res.json(out.after);
  } catch (e) { next(e); }
});

module.exports = router;
