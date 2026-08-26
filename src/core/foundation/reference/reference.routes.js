const router = require("express").Router();
const referenceService = require("./reference.service");

/**
 * Currency codes are public reference data and are required before a user has
 * authenticated (for example on organization registration). Keep this route
 * ahead of authentication middleware; it exposes no tenant data.
 */
router.get("/currencies", async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    const data = await referenceService.listCurrencies({ q, limit });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});


module.exports = router;
