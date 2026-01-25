const financialStatements = require("../reporting/financial-statements/financialStatements.service");

/**
 * Report Generation Interface
 *
 * This provides a stable boundary for other modules to request read-only reports
 * without taking a dependency on reporting internals.
 */
async function generateStatement({ orgId, periodId, statementType, comparePeriodId, mode }) {
  switch (statementType) {
    case "trial_balance":
      return financialStatements.trialBalance({ orgId, periodId });
    case "income_statement":
      return financialStatements.incomeStatement({ orgId, periodId, comparePeriodId, mode });
    case "balance_sheet":
      return financialStatements.balanceSheet({ orgId, periodId, comparePeriodId });
    case "cash_flow":
      return financialStatements.cashFlowStatement({ orgId, periodId, comparePeriodId });
    case "changes_in_equity":
      return financialStatements.changesInEquityStatement({ orgId, periodId, comparePeriodId });
    default:
      throw new Error("Unsupported statementType");
  }
}

module.exports = { generateStatement };
