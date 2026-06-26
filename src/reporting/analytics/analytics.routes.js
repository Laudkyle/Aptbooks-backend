const express = require("express");
const { requirePermission } = require("../../middleware/permission.middleware");
const { AppError } = require("../../shared/errors/AppError");
const svc = require("./analytics.service");

const router = express.Router();
const { resolveOrgId } = require("../_util");

router.get("/time-series", requirePermission("reporting.analytics.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { fromPeriodId, toPeriodId, accountId, dimensionJson } = req.query;
    const series = await svc.timeSeries({ orgId, fromPeriodId, toPeriodId, accountId, dimensionJson });
    const window = Number(req.query.maWindow || 0);
    const withMa = window ? svc.movingAverage(series, 'net', window) : series;
    res.json({ data: withMa });
  } catch (e) { next(e); }
});

router.get("/anomalies", requirePermission("reporting.analytics.read"), async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { fromPeriodId, toPeriodId, accountId, dimensionJson } = req.query;
    const series = await svc.timeSeries({ orgId, fromPeriodId, toPeriodId, accountId, dimensionJson });
    const threshold = Number(req.query.threshold || 3);
    const anomalies = svc.zScoreAnomalies(series, 'net', threshold);
    res.json({ data: anomalies, meta: { threshold } });
  } catch (e) { next(e); }
});

router.post("/monte-carlo", requirePermission("reporting.analytics.read"), async (req, res, next) => {
  try {
    const { baseValue, mean, stddev, iterations } = req.body || {};
    if (baseValue == null) throw new AppError(400, 'baseValue required');
    const out = svc.monteCarlo({ baseValue, mean, stddev, iterations });
    res.json({ data: out });
  } catch (e) { next(e); }
});

module.exports = router;
