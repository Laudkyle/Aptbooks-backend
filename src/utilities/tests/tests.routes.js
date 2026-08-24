const { createModuleBodyContract } = require("../../shared/http/requestValidation");
const express = require("express");
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");
const { idempotency } = require("../../middleware/idempotency.middleware");
const svc = require("./tests.service");

const router = express.Router();
router.use(createModuleBodyContract(['pattern', 'testFile']));
router.use(authRequired);

// GET /utilities/tests/list
router.get(
  "/list",
  requirePermission("utilities.tests.run"),
  async (req, res, next) => {
    try {
      // Listing does not require ALLOW_TEST_RUN_API; this is safe metadata.
      res.json({ data: { files: svc.listTestFiles() } });
    } catch (err) {
      next(err);
    }
  }
);

// POST /utilities/tests/run
// body: { testFile?: "journal.kernel.test.js", pattern?: "some test name" }
router.post(
  "/run",
  idempotency({ required: true }),
  requirePermission("utilities.tests.run"),
  express.json({ limit: "64kb" }),
  async (req, res, next) => {
    try {
      const { testFile, pattern } = req.body || {};
      const result = await svc.runTest({ testFile, pattern });
      res.status(result.ok ? 200 : 500).json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
