const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { validate } = require("../../../shared/validators/validate");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const { AppError } = require("../../../shared/errors/AppError");

const {
  createPaystackIntentSchema,
  createMtnRequestToPaySchema
} = require("./payments.validators");

const svc = require("./payments.service");
const repo = require("./payments.repository");
const paystack = require("./providers/paystack.provider");
const mtnMomo = require("./providers/mtnMomo.provider");

// Authenticated endpoints
router.post("/paystack/initialize", authRequired, requirePermission("payments.integrations.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createPaystackIntentSchema, req.body);
    const out = await svc.createPaystackInboundIntent({ orgId, actorUserId, payload });
    await writeAudit({ organizationId: orgId, actorUserId, action: "payments.paystack.intent_created", entityType: "payment_intents", entityId: out.intentId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.post("/mtn/request-to-pay", authRequired, requirePermission("payments.integrations.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const payload = validate(createMtnRequestToPaySchema, req.body);
    const out = await svc.createMtnInboundIntent({ orgId, actorUserId, payload });
    await writeAudit({ organizationId: orgId, actorUserId, action: "payments.mtn.intent_created", entityType: "payment_intents", entityId: out.intentId, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

router.get("/intents/:id", authRequired, requirePermission("payments.integrations.read"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const intent = await repo.getIntentById({ orgId, id: req.params.id });
    if (!intent) throw new AppError(404, "Payment intent not found");
    res.json(intent);
  } catch (e) { next(e); }
});

router.post("/intents/:id/verify", authRequired, requirePermission("payments.integrations.manage"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.verifyIntent({ orgId, id: req.params.id });
    await writeAudit({ organizationId: orgId, actorUserId, action: "payments.intent_verified", entityType: "payment_intents", entityId: req.params.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.json(out);
  } catch (e) { next(e); }
});

router.post("/intents/:id/post-to-ledger", authRequired, requirePermission("transactions.customer_receipt.post"), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const actorUserId = req.user.id;
    const out = await svc.postInboundIntentToLedger({ orgId, actorUserId, id: req.params.id });
    await writeAudit({ organizationId: orgId, actorUserId, action: "payments.intent_posted_to_ledger", entityType: "payment_intents", entityId: req.params.id, ip: req.audit?.ip, userAgent: req.audit?.userAgent, after: out });
    res.json(out);
  } catch (e) { next(e); }
});

// Webhooks (no auth; verified per provider)
router.post("/webhooks/paystack", async (req, res, next) => {
  try {
    const sig = req.header("x-paystack-signature") || "";
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
    const ok = paystack.verifyWebhookSignature({ rawBody: raw, signatureHeader: sig });
    if (!ok) throw new AppError(401, "Invalid Paystack signature");

    const ev = await repo.recordWebhookEvent({ providerCode: "paystack", externalEventId: req.body?.event, signature: sig, payload: req.body || {} });
    try {
      const ref = req.body?.data?.reference;
      if (ref) {
        const intent = await repo.findIntentByProviderReference({ providerCode: "paystack", reference: ref });
        if (intent) {
          const status = req.body?.event === "charge.success" ? "success" : (req.body?.event === "charge.failed" ? "failed" : "pending");
          await repo.updateIntentStatus({ id: intent.id, orgId: intent.organization_id, status, rawLastResponse: req.body?.data || req.body, providerTransactionId: String(req.body?.data?.id || "") });
        }
      }
      await repo.markWebhookProcessed({ id: ev.id, error: null });
    } catch (inner) {
      await repo.markWebhookProcessed({ id: ev.id, error: inner.message || String(inner) });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/webhooks/mtn", async (req, res, next) => {
  try {
    // MTN callbacks are not trusted as proof of payment. Treat the callback as
    // a notification only, then verify the reference directly against MTN.
    const referenceId = String(
      req.body?.referenceId || req.header("x-reference-id") || ""
    ).trim();
    if (!referenceId) throw new AppError(400, "Missing MTN reference id");

    // Reject arbitrary callback probes before making an outbound provider call.
    const intent = await repo.findIntentByProviderTransactionId({
      providerCode: "mtn_momo",
      providerTransactionId: referenceId,
    });
    if (!intent) throw new AppError(404, "Unknown MTN payment reference");

    const verified = await mtnMomo.getRequestToPayStatus({ referenceId });
    const providerStatus = String(verified?.status || "").toUpperCase();
    const mappedStatus = providerStatus === "SUCCESSFUL"
      ? "success"
      : (providerStatus === "FAILED" ? "failed" : "pending");

    const ev = await repo.recordWebhookEvent({
      providerCode: "mtn_momo",
      externalEventId: referenceId,
      signature: null,
      payload: {
        callback: req.body || {},
        verifiedProviderStatus: verified || {},
      },
    });

    try {
      await repo.updateIntentStatus({
        id: intent.id,
        orgId: intent.organization_id,
        status: mappedStatus,
        rawLastResponse: verified,
        providerTransactionId: referenceId,
      });
      await repo.markWebhookProcessed({ id: ev.id, error: null });
    } catch (inner) {
      await repo.markWebhookProcessed({ id: ev.id, error: inner.message || String(inner) });
      throw inner;
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
