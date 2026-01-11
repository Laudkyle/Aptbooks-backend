const { pool } = require("../../../db/pool");

function db(client) { return client || pool; }

async function createStatement(orgId, createdBy, payload, client = null) {
  const { bankAccountId, statementDate, openingBalance, closingBalance } = payload;
  const { rows } = await db(client).query(
    `INSERT INTO bank_statements(organization_id, bank_account_id, statement_date, opening_balance, closing_balance, created_by)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, bankAccountId, statementDate, openingBalance || 0, closingBalance || 0, createdBy || null]
  );
  return rows[0];
}

async function addLines(statementId, lines, client = null) {
  const conn = db(client);
  const results = [];

  for (const l of lines) {
    try {
      const { rows } = await conn.query(
        `INSERT INTO bank_statement_lines(statement_id, txn_date, description, amount, reference, external_id, line_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          statementId,
          l.txnDate,
          l.description || null,
          l.amount,
          l.reference || null,
          l.externalId || null,
          l.lineHash || null
        ]
      );
      results.push(rows[0]);
    } catch (e) {
      // Handle repeat imports: if unique identity already exists, return the existing row.
      if (e && e.code === "23505") {
        if (l.externalId) {
          const { rows } = await conn.query(
            `SELECT * FROM bank_statement_lines WHERE statement_id=$1 AND external_id=$2 LIMIT 1`,
            [statementId, l.externalId]
          );
          if (rows.length) { results.push(rows[0]); continue; }
        }
        if (l.lineHash) {
          const { rows } = await conn.query(
            `SELECT * FROM bank_statement_lines WHERE statement_id=$1 AND line_hash=$2 LIMIT 1`,
            [statementId, l.lineHash]
          );
          if (rows.length) { results.push(rows[0]); continue; }
        }
      }
      throw e;
    }
  }

  return results;
}

async function matchLine(orgId, lineId, { journalEntryId, matchedBy, matchMethod, matchReason, matchRuleVersion }, client = null) {
  // validate line belongs to org
  const conn = db(client);
  const { rows: lineRows } = await conn.query(
    `SELECT l.id, l.matched, l.matched_journal_entry_id
     FROM bank_statement_lines l
     JOIN bank_statements s ON s.id=l.statement_id
     WHERE s.organization_id=$1 AND l.id=$2
     FOR UPDATE`,
    [orgId, lineId]
  );
  if (!lineRows.length) return null;

  // Prevent accidental rematching to a different journal
  if (lineRows[0].matched && lineRows[0].matched_journal_entry_id && lineRows[0].matched_journal_entry_id !== journalEntryId) {
    const err = new Error("Statement line already matched to a different journal entry");
    err.code = "BANK_LINE_ALREADY_MATCHED";
    throw err;
  }

  await conn.query(
    `UPDATE bank_statement_lines
     SET matched=true,
         matched_journal_entry_id=$2,
         matched_by=$3,
         matched_at=now(),
         match_method=$4,
         match_reason=$5,
         match_rule_version=$6
     WHERE id=$1`,
    [lineId, journalEntryId, matchedBy || null, matchMethod || null, matchReason || null, matchRuleVersion || null]
  );
  const { rows } = await conn.query(`SELECT * FROM bank_statement_lines WHERE id=$1`, [lineId]);
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
