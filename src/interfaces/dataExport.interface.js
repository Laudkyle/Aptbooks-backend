const exportsService = require("../reporting/exports/exports.service");

/**
 * Data Export Interface
 *
 * Exposes export helpers (CSV/JSON) without leaking route/controller details.
 */
async function exportTrialBalance({ orgId, periodId, format }) {
  return exportsService.exportTrialBalance({ orgId, periodId, format });
}

module.exports = { exportTrialBalance };
