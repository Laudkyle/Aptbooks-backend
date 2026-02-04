const express = require("express");
const { requirePermission } = require("../../../middleware/permission.middleware");
const svc = require("./imports.service");

const router = express.Router();

// Body is expected as raw text/csv; alternatively send JSON { csvText: "..." }
router.post("/coa", requirePermission("accounting.imports.run"), express.text({ type: ["text/*"], limit: "10mb" }), async (req, res, next) => {
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

router.post("/journals", requirePermission("accounting.imports.run"), express.text({ type: ["text/*"], limit: "10mb" }), async (req, res, next) => {
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
