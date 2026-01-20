const { pool } = require("../../../db/pool");

function db(client) { return client || pool; }

async function listRules(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM bank_matching_rules WHERE organization_id=$1 ORDER BY is_active DESC, priority ASC, created_at DESC`,
    [orgId]
  );
  return rows;
}

async function createRule(orgId, userId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO bank_matching_rules(
      organization_id, name, is_active, amount_tolerance, date_window_days, description_similarity_min, priority, created_by
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *`,
    [
      orgId,
      payload.name,
      payload.is_active !== false,
      payload.amount_tolerance ?? 0,
      payload.date_window_days ?? 3,
      payload.description_similarity_min ?? 0.3,
      payload.priority ?? 100,
      userId || null
    ]
  );
  return rows[0];
}

async function updateRule(orgId, ruleId, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE bank_matching_rules
     SET name=COALESCE($3,name),
         is_active=COALESCE($4,is_active),
         amount_tolerance=COALESCE($5,amount_tolerance),
         date_window_days=COALESCE($6,date_window_days),
         description_similarity_min=COALESCE($7,description_similarity_min),
         priority=COALESCE($8,priority),
         updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [
      orgId,
      ruleId,
      payload.name ?? null,
      typeof payload.is_active === "boolean" ? payload.is_active : null,
      payload.amount_tolerance ?? null,
      payload.date_window_days ?? null,
      payload.description_similarity_min ?? null,
      payload.priority ?? null
    ]
  );
  return rows[0] || null;
}

async function getStatementLine(orgId, lineId, client = null) {
  const { rows } = await db(client).query(
    `
    SELECT
      l.*, s.bank_account_id, s.organization_id
    FROM bank_statement_lines l
    JOIN bank_statements s ON s.id = l.statement_id
    WHERE s.organization_id=$1 AND l.id=$2
    `,
    [orgId, lineId]
  );
  return rows[0] || null;
}

async function getBankAccount(orgId, bankAccountId, client = null) {
  const { rows } = await db(client).query(
    `SELECT * FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, bankAccountId]
  );
  return rows[0] || null;
}

async function findCandidateJournalLines({ orgId, bankGlAccountId, txnDate, amount, dateWindowDays, amountTolerance, limit = 20 }, client = null) {
  const params = [orgId, bankGlAccountId, txnDate, dateWindowDays, amount, amountTolerance, limit];
  const { rows } = await db(client).query(
    `
    WITH candidates AS (
      SELECT
        je.id AS journal_entry_id,
        je.entry_date,
        je.memo,
        jel.id AS journal_entry_line_id,
        jel.description AS line_description,
        (jel.debit - jel.credit) AS signed_amount
      FROM journal_entries je
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.organization_id=$1
        AND je.status='posted'
        AND jel.account_id=$2
        AND je.entry_date BETWEEN ($3::date - $4::int) AND ($3::date + $4::int)
        AND ABS((jel.debit - jel.credit) - $5::numeric) <= $6::numeric
    )
    SELECT * FROM candidates
    ORDER BY ABS(signed_amount - $5::numeric) ASC, ABS(entry_date - $3::date) ASC
    LIMIT $7
    `,
    params
  );
  return rows;
}

module.exports = {
  listRules,
  createRule,
  updateRule,
  getStatementLine,
  getBankAccount,
  findCandidateJournalLines
};
