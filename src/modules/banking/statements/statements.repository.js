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

async function getStatement(orgId, statementId, client = null) {
  const { rows } = await db(client).query(
    `SELECT s.*, ba.code AS bank_account_code, ba.name AS bank_account_name
       FROM bank_statements s
       JOIN bank_accounts ba ON ba.id=s.bank_account_id AND ba.organization_id=s.organization_id
      WHERE s.organization_id=$1 AND s.id=$2`,
    [orgId, statementId]
  );
  return rows[0] || null;
}

async function listStatementLines(orgId, statementId, { limit = 200, offset = 0, matched } = {}, client = null) {
  const params = [orgId, statementId, limit, offset];
  let matchedClause = "";
  if (typeof matched === "boolean") {
    params.splice(2, 0, matched);
    matchedClause = ` AND l.matched=$3`;
    // shift limit/offset positions
    params[3] = limit;
    params[4] = offset;
  }

  const { rows } = await db(client).query(
    `
    SELECT
      l.*,
      m.journal_entry_id AS match_journal_entry_id,
      je.entry_no AS match_journal_entry_no,
      m.matched_amount AS match_amount,
      m.matched_at AS match_at,
      m.matched_by AS match_by
    FROM bank_statement_lines l
    JOIN bank_statements s ON s.id = l.statement_id
    LEFT JOIN bank_matches m ON m.bank_statement_line_id = l.id
    LEFT JOIN journal_entries je ON je.id=m.journal_entry_id AND je.organization_id=s.organization_id
    WHERE s.organization_id=$1 AND s.id=$2${matchedClause}
    ORDER BY l.txn_date DESC, l.created_at DESC
    LIMIT $${typeof matched === "boolean" ? 4 : 3} OFFSET $${typeof matched === "boolean" ? 5 : 4}
    `,
    params
  );
  return rows;
}

async function addLines(orgId, bankAccountId, statementId, lines, userId, client = null) {
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

      // Create a corresponding bank transaction for cashbook view.
      // Use a deterministic external_id so repeated imports do not duplicate.
      await conn.query(
        `
        INSERT INTO bank_transactions(
          organization_id, bank_account_id, txn_date, amount, description, reference,
          source_type, source_id, statement_line_id, created_by, external_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,'statement_line',$7,$7,$8,$9)
        ON CONFLICT (organization_id, bank_account_id, external_id) DO NOTHING
        `,
        [
          orgId,
          bankAccountId,
          rows[0].txn_date,
          rows[0].amount,
          rows[0].description,
          rows[0].reference,
          rows[0].id,
          userId || null,
          `stmtline:${rows[0].id}`
        ]
      );
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

  // Record explicit match row (idempotent) + link the bank_transaction row.
  await conn.query(
    `INSERT INTO bank_matches(
        organization_id, bank_statement_line_id, journal_entry_id, matched_amount, matched_by
      )
     SELECT s.organization_id, l.id, $2, l.amount, $3
     FROM bank_statement_lines l
     JOIN bank_statements s ON s.id = l.statement_id
     WHERE l.id=$1
     ON CONFLICT (bank_statement_line_id)
     DO UPDATE SET journal_entry_id=EXCLUDED.journal_entry_id, matched_amount=EXCLUDED.matched_amount,
                  matched_at=NOW(), matched_by=EXCLUDED.matched_by`,
    [lineId, journalEntryId, matchedBy || null]
  );

  await conn.query(
    `UPDATE bank_transactions
     SET journal_entry_id=$2, source_type='journal', source_id=$2
     WHERE statement_line_id=$1`,
    [lineId, journalEntryId]
  );
  const { rows } = await conn.query(`SELECT * FROM bank_statement_lines WHERE id=$1`, [lineId]);
  return rows[0];
}

async function listStatements(orgId) {
  const { rows } = await pool.query(
    `SELECT s.*, ba.code AS bank_account_code, ba.name AS bank_account_name
       FROM bank_statements s
       JOIN bank_accounts ba ON ba.id=s.bank_account_id AND ba.organization_id=s.organization_id
      WHERE s.organization_id=$1 ORDER BY s.statement_date DESC LIMIT 200`,
    [orgId]
  );
  return rows;
}

module.exports = {
  createStatement,
  getStatement,
  listStatementLines,
  addLines,
  matchLine,
  listStatements
};
