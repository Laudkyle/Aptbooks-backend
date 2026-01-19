const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./exports.service");

const router = express.Router();

router.get("/trial-balance", requirePermission("reporting.exports.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, format = "json", encrypt = "0" } = req.query;
    const out = await svc.exportTrialBalance({ orgId, periodId, format, encrypt: String(encrypt) === "1" });
    if (out.headers) {
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    }
    if (out.contentType) res.setHeader("Content-Type", out.contentType);
    res.send(out.body);
  } catch (err) {
    next(err);
  }
});

router.get("/general-ledger", requirePermission("reporting.exports.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { periodId, format = "json", encrypt = "0" } = req.query;
    const out = await svc.exportGeneralLedger({ orgId, periodId, format, encrypt: String(encrypt) === "1" });
    if (out.headers) {
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    }
    if (out.contentType) res.setHeader("Content-Type", out.contentType);
    res.send(out.body);
  } catch (err) {
    next(err);
  }
});

router.get("/account-activity", requirePermission("reporting.exports.run"), async (req, res, next) => {
  try {
    const { organization_id: orgId } = req.user;
    const { accountId, fromDate, toDate, format = "json", encrypt = "0" } = req.query;
    const out = await svc.exportAccountActivity({
      orgId,
      accountId,
      fromDate,
      toDate,
      format,
      encrypt: String(encrypt) === "1",
    });
    if (out.headers) {
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    }
    if (out.contentType) res.setHeader("Content-Type", out.contentType);
    res.send(out.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
