const exportsService = require("../reporting/exports/exports.service");

/**
 * Data Export Interface
 *
 * Exposes export helpers (CSV/JSON) without leaking route/controller details.
 */
async function exportTrialBalance({ orgId, periodId, format }) {
  return exportsService.exportTrialBalance({ orgId, periodId, format });
}

async function exportGeneralLedger({ orgId, periodId, format }) {
  return exportsService.exportGeneralLedger({ orgId, periodId, format });
}

async function exportAccountActivity({ orgId, accountId, fromDate, toDate, format }) {
  return exportsService.exportAccountActivity({ orgId, accountId, fromDate, toDate, format });
}

module.exports = { exportTrialBalance, exportGeneralLedger, exportAccountActivity };
