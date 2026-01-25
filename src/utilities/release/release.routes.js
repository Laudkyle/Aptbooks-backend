const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const svc = require("./release.service");

const router = express.Router();
router.use(authRequired);

// GET /utilities/release/info
router.get(
  "/info",
  requirePermission("utilities.release.read"),
  async (req, res, next) => {
    try {
      res.json({ data: svc.getReleaseInfo() });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
