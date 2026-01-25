const repo = require("./statements.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const crypto = require("crypto");
const { withTransaction } = require("../../../db/tx");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const { parseCsvText } = require("../../../shared/utils/csv");

function normalizeText(v) {
  if (v == null) return "";
  return String(v).trim().replace(/\s+/g, " ");
}


function computeLineHash({ txnDate, amount, description, reference, externalId }) {
  const material = [
    txnDate,
    String(amount),
    normalizeText(reference),
    normalizeText(description),
    normalizeText(externalId)
  ].join("|");
  return crypto.createHash("sha256").update(material).digest("hex");
}

async function createStatement(orgId, userId, payload) {
  const req=["bankAccountId","statementDate"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);
  return withTransaction(async (client) => {
    // Validate bank account belongs to org
    const { rows: ba } = await client.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.bankAccountId]
    );
    if (!ba.length) throw new AppError(404, "Bank account not found");

    const created = await repo.createStatement(orgId, userId, payload, client);
    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "BANK_STATEMENT_CREATED",
      entityType: "bank_statement",
      entityId: created.id,
      after: { bank_account_id: payload.bankAccountId, statement_date: payload.statementDate }
    });
    return created;
  });
}

async function addLines(orgId, userId, statementId, lines) {
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, "lines[] required");
  // validate statement belongs to org
  return withTransaction(async (client) => {
    const stmt = await repo.getStatement(orgId, statementId, client);
    if (!stmt) throw new AppError(404, "Statement not found");

    const normalized = lines.map((l) => {
      if (!l.txnDate || l.amount == null) throw new AppError(400, "Each line requires txnDate and amount");
      const externalId = l.externalId || l.external_id || null;
      const lineHash = computeLineHash({
        txnDate: l.txnDate,
        amount: l.amount,
        description: l.description,
        reference: l.reference,
        externalId
      });
      return {
        txnDate: l.txnDate,
        description: l.description || null,
        amount: l.amount,
        reference: l.reference || null,
        externalId,
        lineHash
      };
    });

    const inserted = await repo.addLines(orgId, stmt.bank_account_id, statementId, normalized, userId, client);

    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "BANK_STATEMENT_LINES_IMPORTED",
      entityType: "bank_statement",
      entityId: statementId,
      after: { imported_count: inserted.length }
    });

    return inserted;
  });
}

async function importLinesCsv(orgId, userId, statementId, csvText) {
  const rows = parseCsvText(csvText);
  // Expected columns: txnDate, amount, description?, reference?, externalId?
  const lines = rows.map((r) => ({
    txnDate: r.txnDate || r.txn_date || r.date,
    amount: r.amount != null && r.amount !== "" ? Number(r.amount) : null,
    description: r.description || null,
    reference: r.reference || null,
    externalId: r.externalId || r.external_id || null
  }));
  return addLines(orgId, userId, statementId, lines);
}

async function listStatementLines(orgId, statementId, options) {
  return { data: await repo.listStatementLines(orgId, statementId, options) };
}

async function matchLine(orgId, userId, lineId, payload) {
  const journalEntryId = payload?.journalEntryId;
  if (!journalEntryId) throw new AppError(400, "journalEntryId is required");
  // validate journal is posted and belongs to org
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM journal_entries WHERE organization_id=$1 AND id=$2 AND status='posted'`,
      [orgId, journalEntryId]
    );
    if (!rows.length) throw new AppError(404, "Posted journal not found");

    let updated;
    try {
      updated = await repo.matchLine(orgId, lineId, {
        journalEntryId,
        matchedBy: userId,
        matchMethod: payload?.method || payload?.matchMethod || "manual",
        matchReason: payload?.reason || payload?.matchReason || null,
        matchRuleVersion: payload?.ruleVersion || payload?.matchRuleVersion || null
      }, client);
    } catch (e) {
      if (e && e.code === "BANK_LINE_ALREADY_MATCHED") {
        throw new AppError(409, "Statement line already matched to a different journal entry");
      }
      throw e;
    }

    if (!updated) throw new AppError(404, "Statement line not found");

    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "BANK_STATEMENT_LINE_MATCHED",
      entityType: "bank_statement_line",
      entityId: lineId,
      after: {
        matched_journal_entry_id: journalEntryId,
        method: payload?.method || "manual",
        rule_version: payload?.ruleVersion || null
      }
    });

    return updated;
  });
}

async function listStatements(orgId) { return repo.listStatements(orgId);}

module.exports = {
  createStatement,
  addLines,
  importLinesCsv,
  listStatementLines,
  matchLine,
  listStatements
};
