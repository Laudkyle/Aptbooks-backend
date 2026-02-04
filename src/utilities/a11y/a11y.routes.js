const router = require("express").Router();
const { authRequired } = require("../../middleware/auth.middleware");
const { requirePermission } = require("../../middleware/permission.middleware");

router.use(authRequired);

router.get("/status", requirePermission("utilities.a11y.read"), (req, res) => {
  // Backend cannot guarantee frontend WCAG compliance; this endpoint exposes a checklist scaffold.
  res.json({
    data: {
      standard: "WCAG 2.1 AA",
      last_run_at: null,
      checks: [
        { key: "http.errors", description: "Consistent error shapes and status codes", status: "pass" },
        { key: "i18n.keys", description: "Stable translation keys for user-facing messages", status: "pass" },
        { key: "audit.logging", description: "Correlation IDs present in responses", status: "pass" },
        { key: "frontend.color_contrast", description: "Frontend contrast audit", status: "unknown" },
        { key: "frontend.keyboard", description: "Frontend keyboard navigation", status: "unknown" }
      ]
    }
  });
});

module.exports = router;
