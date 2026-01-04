const { AppError } = require("../../shared/errors/AppError");
const { trialBalance } = require("../financial-statements/financialStatements.service");

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

module.exports = { exportTrialBalance };
