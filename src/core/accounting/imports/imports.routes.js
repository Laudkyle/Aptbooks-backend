const { createModuleBodyContract, z, validateBody } = require("../../../shared/http/requestValidation");
const express = require("express");
const { AppError } = require("../../../shared/errors/AppError");
const { authRequired } = require("../../../middleware/auth.middleware");
const { idempotency } = require("../../../middleware/idempotency.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const svc = require("./imports.service");

const router = express.Router();
router.use(createModuleBodyContract(['accountId', 'csvText', 'id']));
router.use(authRequired);
function validateCsvPayload(req, _res, next) {
  try {
    if (typeof req.body === "string") {
      if (!req.body.trim()) throw new AppError(422, "CSV body cannot be empty", { code: "validation_error" });
      return next();
    }
    return validateBody(z.object({ csvText: z.string().min(1).max(10 * 1024 * 1024) }).strict())(req, _res, next);
  } catch (error) { next(error); }
}
const requireMutationIdempotency = idempotency({ required: true });
router.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  return requireMutationIdempotency(req, res, next);
});

// Body is expected as raw text/csv; alternatively send JSON { csvText: "..." }
router.post("/coa", requirePermission("accounting.imports.run"), express.text({ type: ["text/*"], limit: "10mb" }), validateCsvPayload, async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const dryRun = String(req.query.dryRun || "false").toLowerCase() === "true";
    const csvText = typeof req.body === "string" ? req.body : (req.body.csvText || "");
    const data = await svc.importCoaCsv({ orgId, actorUserId, csvText, options: { dryRun } });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.post("/journals", requirePermission("accounting.imports.run"), express.text({ type: ["text/*"], limit: "10mb" }), validateCsvPayload, async (req, res, next) => {
  try {
    const { organization_id: orgId, id: actorUserId } = req.user;
    const dryRun = String(req.query.dryRun || "false").toLowerCase() === "true";
    const journalKeyField = req.query.journalKeyField || "journalKey";
    const csvText = typeof req.body === "string" ? req.body : (req.body.csvText || "");
    const data = await svc.importJournalsCsv({ orgId, actorUserId, csvText, options: { dryRun, journalKeyField } });
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
