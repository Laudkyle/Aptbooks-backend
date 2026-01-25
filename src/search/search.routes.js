const router = require("express").Router();
const { authRequired } = require("../middleware/auth.middleware");
const svc = require("./search.service");

router.use(authRequired);

// Global search API
// GET /search?q=...&limit=10
router.get("/", async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const q = req.query?.q;
    const limit = req.query?.limit;
    const out = await svc.globalSearch({ orgId, q, limitPerType: limit });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
