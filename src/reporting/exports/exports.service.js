const { AppError } = require("../../shared/errors/AppError");
const { trialBalance } = require("../financial-statements/financialStatements.service");
const balances = require("../../interfaces/balanceInquiry.interface");

function assertPeriodId(periodId) {
  if (!periodId) throw new AppError(400, "periodId is required");
}

function toCsv(rows) {
  const header = ["code","name","account_type","debit_total","credit_total","net_debit_minus_credit"];
  const escape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes("\n") || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      escape(r.code),
      escape(r.name),
      escape(r.account_type),
      escape(r.debit_total),
      escape(r.credit_total),
      escape(r.net_debit_minus_credit),
    ].join(","));
  }
  return lines.join("\n");
}

async function exportTrialBalance({ orgId, periodId, format = "json" }) {
  assertPeriodId(periodId);
  const data = await trialBalance({ orgId, periodId });
  if (String(format).toLowerCase() === "csv") {
    return { contentType: "text/csv", body: toCsv(data) };
  }
  if (String(format).toLowerCase() === "json") {
    return { contentType: "application/json", body: JSON.stringify({ data }, null, 2) };
  }
  throw new AppError(400, "format must be json or csv");
}

function toCsvGeneric({ header, rows }) {
  const escape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes("\n") || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map((h) => escape(r[h])).join(","));
  }
  return lines.join("\n");
}

async function exportGeneralLedger({ orgId, periodId, format = "json" }) {
  assertPeriodId(periodId);
  const data = await balances.glBalances({ orgId, periodId });
  if (String(format).toLowerCase() === "csv") {
    const header = ["code", "name", "debit_total", "credit_total"];
    return { contentType: "text/csv", body: toCsvGeneric({ header, rows: data }) };
  }
  if (String(format).toLowerCase() === "json") {
    return { contentType: "application/json", body: JSON.stringify({ data }, null, 2) };
  }
  throw new AppError(400, "format must be json or csv");
}

async function exportAccountActivity({ orgId, accountId, fromDate, toDate, format = "json" }) {
  if (!accountId) throw new AppError(400, "accountId is required");
  if (!fromDate || !toDate) throw new AppError(400, "fromDate and toDate are required");
  const data = await balances.accountActivity({ orgId, accountId, fromDate, toDate });
  if (String(format).toLowerCase() === "csv") {
    const header = [
      "journal_id",
      "entry_no",
      "entry_date",
      "status",
      "line_no",
      "description",
      "debit",
      "credit",
      "currency_code",
      "fx_rate",
      "amount_base",
    ];
    return { contentType: "text/csv", body: toCsvGeneric({ header, rows: data }) };
  }
  if (String(format).toLowerCase() === "json") {
    return { contentType: "application/json", body: JSON.stringify({ data }, null, 2) };
  }
  throw new AppError(400, "format must be json or csv");
}

module.exports = { exportTrialBalance, exportGeneralLedger, exportAccountActivity };
