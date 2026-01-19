const { AppError } = require("../../shared/errors/AppError");
const crypto = require("crypto");
const { trialBalance } = require("../financial-statements/financialStatements.service");
const balances = require("../../interfaces/balanceInquiry.interface");

function getExportEncryptionKey() {
  const raw = process.env.EXPORT_ENCRYPTION_KEY;
  if (!raw) return null;
  // Accept base64 or hex.
  let key = null;
  try {
    key = Buffer.from(raw, /[^0-9a-f]/i.test(raw) ? "base64" : "hex");
  } catch (e) {
    key = null;
  }
  if (!key || key.length !== 32) {
    throw new AppError(500, "EXPORT_ENCRYPTION_KEY must be 32 bytes (base64 or hex)");
  }
  return key;
}

function encryptExportBody({ body, originalContentType }) {
  const key = getExportEncryptionKey();
  if (!key) throw new AppError(400, "Export encryption key not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(originalContentType || "application/octet-stream")));
  const plaintext = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Output format: iv(12) + tag(16) + ciphertext
  const out = Buffer.concat([iv, tag, ciphertext]);
  return {
    contentType: "application/octet-stream",
    body: out,
    headers: {
      "X-Encrypted": "aes-256-gcm",
      "X-Original-Content-Type": String(originalContentType || "application/octet-stream"),
    },
  };
}

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

async function exportTrialBalance({ orgId, periodId, format = "json", encrypt = false }) {
  assertPeriodId(periodId);
  const data = await trialBalance({ orgId, periodId });
  if (String(format).toLowerCase() === "csv") {
    const out = { contentType: "text/csv", body: toCsv(data) };
    return encrypt ? encryptExportBody({ body: out.body, originalContentType: out.contentType }) : out;
  }
  if (String(format).toLowerCase() === "json") {
    const out = { contentType: "application/json", body: JSON.stringify({ data }, null, 2) };
    return encrypt ? encryptExportBody({ body: out.body, originalContentType: out.contentType }) : out;
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

async function exportGeneralLedger({ orgId, periodId, format = "json", encrypt = false }) {
  assertPeriodId(periodId);
  const data = await balances.glBalances({ orgId, periodId });
  if (String(format).toLowerCase() === "csv") {
    const header = ["code", "name", "debit_total", "credit_total"];
    const out = { contentType: "text/csv", body: toCsvGeneric({ header, rows: data }) };
    return encrypt ? encryptExportBody({ body: out.body, originalContentType: out.contentType }) : out;
  }
  if (String(format).toLowerCase() === "json") {
    const out = { contentType: "application/json", body: JSON.stringify({ data }, null, 2) };
    return encrypt ? encryptExportBody({ body: out.body, originalContentType: out.contentType }) : out;
  }
  throw new AppError(400, "format must be json or csv");
}

async function exportAccountActivity({ orgId, accountId, fromDate, toDate, format = "json", encrypt = false }) {
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
    const out = { contentType: "text/csv", body: toCsvGeneric({ header, rows: data }) };
    return encrypt ? encryptExportBody({ body: out.body, originalContentType: out.contentType }) : out;
  }
  if (String(format).toLowerCase() === "json") {
    const out = { contentType: "application/json", body: JSON.stringify({ data }, null, 2) };
    return encrypt ? encryptExportBody({ body: out.body, originalContentType: out.contentType }) : out;
  }
  throw new AppError(400, "format must be json or csv");
}

module.exports = {
  exportTrialBalance,
  exportGeneralLedger,
  exportAccountActivity,
  encryptExportBody,
};
