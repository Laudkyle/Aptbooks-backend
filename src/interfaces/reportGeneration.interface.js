const financialStatements = require("../reporting/financial-statements/financialStatements.service");

/**
 * Report Generation Interface
 *
 * This provides a stable boundary for other modules to request read-only reports
 * without taking a dependency on reporting internals.
 */
async function generateStatement({ orgId, periodId, statementType }) {
  switch (statementType) {
    case "trial_balance":
      return financialStatements.trialBalance({ orgId, periodId });
    case "income_statement":
      return financialStatements.incomeStatement({ orgId, periodId });
    case "balance_sheet":
      return financialStatements.balanceSheet({ orgId, periodId });
    default:
      throw new Error("Unsupported statementType");
  }
}

module.exports = { generateStatement };
