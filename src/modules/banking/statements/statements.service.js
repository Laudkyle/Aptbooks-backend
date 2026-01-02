const repo = require("./statements.repository");
const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

async function createStatement(orgId, userId, payload) {
  const req=["bankAccountId","statementDate"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);
  return repo.createStatement(orgId, userId, payload);
}

async function addLines(orgId, statementId, lines) {
  if (!Array.isArray(lines) || !lines.length) throw new AppError(400, "lines[] required");
  // validate statement belongs to org
  const { rows } = await pool.query(
    `SELECT id FROM bank_statements WHERE organization_id=$1 AND id=$2`,
    [orgId, statementId]
  );
  if (!rows.length) throw new AppError(404, "Statement not found");
  for (const l of lines) {
    if (!l.txnDate || l.amount == null) throw new AppError(400, "Each line requires txnDate and amount");
  }
  return repo.addLines(statementId, lines);
}

async function matchLine(orgId, lineId, journalEntryId) {
  // validate journal is posted and belongs to org
  const { rows } = await pool.query(
    `SELECT id FROM journal_entries WHERE organization_id=$1 AND id=$2 AND status='posted'`,
    [orgId, journalEntryId]
  );
  if (!rows.length) throw new AppError(404, "Posted journal not found");
  const updated = await repo.matchLine(orgId, lineId, journalEntryId);
  if (!updated) throw new AppError(404, "Statement line not found");
  return updated;
}

async function listStatements(orgId) { return repo.listStatements(orgId); }

module.exports = { createStatement, addLines, matchLine, listStatements };
