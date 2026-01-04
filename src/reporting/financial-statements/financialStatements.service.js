const { AppError } = require("../../shared/errors/AppError");
const { trialBalance: trialBalanceSvc } = require("../../core/accounting/ledger/balances.service");
const repo = require("./financialStatements.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertPeriodId(periodId) {
  if (!periodId) throw new AppError(400, "periodId is required");
}

async function trialBalance({ orgId, periodId }) {
  assertPeriodId(periodId);
  return trialBalanceSvc({ orgId, periodId });
}

async function incomeStatement({ orgId, periodId }) {
  assertPeriodId(periodId);
  const tb = await trialBalanceSvc({ orgId, periodId });

  const revenueLines = tb.filter((r) => r.account_type === "REVENUE");
  const expenseLines = tb.filter((r) => r.account_type === "EXPENSE");

  const toAmount = (r) => {
    // For statement purposes: revenue is credit-normal, expense is debit-normal.
    const debit = Number(r.debit_total || 0);
    const credit = Number(r.credit_total || 0);
    if (r.account_type === "REVENUE") return credit - debit;
    if (r.account_type === "EXPENSE") return debit - credit;
    return debit - credit;
  };

  const revenue = revenueLines.map((r) => ({
    account_id: r.account_id,
    code: r.code,
    name: r.name,
    amount: toAmount(r),
  }));
  const expenses = expenseLines.map((r) => ({
    account_id: r.account_id,
    code: r.code,
    name: r.name,
    amount: toAmount(r),
  }));

  const totalRevenue = revenue.reduce((s, x) => s + x.amount, 0);
  const totalExpenses = expenses.reduce((s, x) => s + x.amount, 0);
  const netIncome = totalRevenue - totalExpenses;

  return {
    period_id: periodId,
    totals: { totalRevenue, totalExpenses, netIncome },
    revenue,
    expenses,
  };
}

async function balanceSheet({ orgId, periodId }) {
  assertPeriodId(periodId);
  const tb = await trialBalanceSvc({ orgId, periodId });

  const assetLines = tb.filter((r) => r.account_type === "ASSET");
  const liabilityLines = tb.filter((r) => r.account_type === "LIABILITY");
  const equityLines = tb.filter((r) => r.account_type === "EQUITY");

  const toAmount = (r) => {
    // Assets are debit-normal, liabilities/equity are credit-normal.
    const debit = Number(r.debit_total || 0);
    const credit = Number(r.credit_total || 0);
    if (r.account_type === "ASSET") return debit - credit;
    return credit - debit;
  };

  const assets = assetLines.map((r) => ({
    account_id: r.account_id,
    code: r.code,
    name: r.name,
    amount: toAmount(r),
  }));

  const liabilities = liabilityLines.map((r) => ({
    account_id: r.account_id,
    code: r.code,
    name: r.name,
    amount: toAmount(r),
  }));

  const equity = equityLines.map((r) => ({
    account_id: r.account_id,
    code: r.code,
    name: r.name,
    amount: toAmount(r),
  }));

  const totalAssets = assets.reduce((s, x) => s + x.amount, 0);
  const totalLiabilities = liabilities.reduce((s, x) => s + x.amount, 0);
  const totalEquity = equity.reduce((s, x) => s + x.amount, 0);

  return {
    period_id: periodId,
    totals: { totalAssets, totalLiabilities, totalEquity, check: totalAssets - (totalLiabilities + totalEquity) },
    assets,
    liabilities,
    equity,
  };
}

async function generateAndPersist({ orgId, periodId, statementType, actorUserId, req }) {
  assertPeriodId(periodId);
  if (!statementType) throw new AppError(400, "statementType is required");

  let payload;
  switch (statementType) {
    case "trial_balance":
      payload = await trialBalance({ orgId, periodId });
      break;
    case "income_statement":
      payload = await incomeStatement({ orgId, periodId });
      break;
    case "balance_sheet":
      payload = await balanceSheet({ orgId, periodId });
      break;
    default:
      throw new AppError(400, "Unsupported statementType");
  }

  const created = await repo.insertFinancialStatement({
    orgId,
    periodId,
    statementType,
    generatedBy: actorUserId,
    payload,
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.statement.generate",
    entityType: "financial_statement",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { periodId, statementType },
  });

  return created;
}

async function listGenerated({ orgId, periodId, statementType, limit }) {
  return repo.listFinancialStatements({ orgId, periodId, statementType, limit });
}

module.exports = {
  trialBalance,
  incomeStatement,
  balanceSheet,
  generateAndPersist,
  listGenerated,
};
