const { pool } = require("../../../db/pool");

async function createStatement(orgId, createdBy, payload) {
  const { bankAccountId, statementDate, openingBalance, closingBalance } = payload;
  const { rows } = await pool.query(
    `INSERT INTO bank_statements(organization_id, bank_account_id, statement_date, opening_balance, closing_balance, created_by)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, bankAccountId, statementDate, openingBalance || 0, closingBalance || 0, createdBy || null]
  );
  return rows[0];
}

async function addLines(statementId, lines) {
  const inserted = [];
  for (const l of lines) {
    const { rows } = await pool.query(
      `INSERT INTO bank_statement_lines(statement_id, txn_date, description, amount, reference)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [statementId, l.txnDate, l.description || null, l.amount, l.reference || null]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

async function matchLine(orgId, lineId, journalEntryId) {
  // validate line belongs to org
  const { rows: lineRows } = await pool.query(
    `SELECT l.id
     FROM bank_statement_lines l
     JOIN bank_statements s ON s.id=l.statement_id
     WHERE s.organization_id=$1 AND l.id=$2`,
    [orgId, lineId]
  );
  if (!lineRows.length) return null;

  await pool.query(
    `UPDATE bank_statement_lines
     SET matched=true, matched_journal_entry_id=$2
     WHERE id=$1`,
    [lineId, journalEntryId]
  );
  const { rows } = await pool.query(`SELECT * FROM bank_statement_lines WHERE id=$1`, [lineId]);
  return rows[0];
}

async function listStatements(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM bank_statements WHERE organization_id=$1 ORDER BY statement_date DESC LIMIT 200`,
    [orgId]
  );
  return rows;
}

module.exports = { createStatement, addLines, matchLine, listStatements };
