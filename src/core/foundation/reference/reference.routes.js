const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const referenceService = require("./reference.service");

router.use(authRequired);

/**
 * GET /core/reference/currencies
 * Permission: settings.read (re-uses existing permission in your system)
 * Query:
 *  - q (optional): search by code prefix or name contains
 *  - limit (optional): default 500, max 1000
 *
 * Response:
 *  { data: [{ code: "GHS", name: "Ghana Cedi" }, ...] }
 */
router.get(
  "/currencies",
  requirePermission("settings.read"),
  async (req, res, next) => {
    try {
      const { q, limit } = req.query;
      const data = await referenceService.listCurrencies({ q, limit });
      res.json({ data });
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
