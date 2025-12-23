const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

function sum2(lines) {
  return lines.reduce(
    (acc, l) => {
      acc.debit += Number(l.debit || 0);
      acc.credit += Number(l.credit || 0);
      return acc;
    },
    { debit: 0, credit: 0 }
  );
}

async function getPeriodForUpdate(client, orgId, periodId) {
  const { rows } = await client.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2 FOR SHARE`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(400, "Invalid period");
  return rows[0];
}

function assertEntryDateWithinPeriod(entryDate, period) {
  const d = new Date(entryDate + "T00:00:00Z").getTime();
  const s = new Date(period.start_date + "T00:00:00Z").getTime();
  const e = new Date(period.end_date + "T00:00:00Z").getTime();
  if (d < s || d > e) throw new AppError(409, "entryDate must be within the selected period");
}

async function createDraftJournal({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // idempotency
    if (payload.idempotencyKey) {
      const { rows: existing } = await client.query(
        `SELECT id, status FROM journal_entries WHERE organization_id=$1 AND idempotency_key=$2`,
        [orgId, payload.idempotencyKey]
      );
      if (existing.length) {
        await client.query("COMMIT");
        return { journalId: existing[0].id, status: existing[0].status, idempotent: true };
      }
    }

    const period = await getPeriodForUpdate(client, orgId, payload.periodId);
    if (period.status !== "open") throw new AppError(409, "Period not open");
    assertEntryDateWithinPeriod(payload.entryDate, period);

    const { rows: tRows } = await client.query(
      `SELECT id FROM journal_entry_types WHERE code=$1`,
      [payload.typeCode || "GENERAL"]
    );
    if (!tRows.length) throw new AppError(400, "Invalid journal entry type");
    const typeId = tRows[0].id;

    const totals = sum2(payload.lines || []);
    if (totals.debit !== totals.credit) throw new AppError(400, "Journal not balanced");

    // Validate accounts exist and are postable+active up front
    for (const l of payload.lines) {
      const { rows: aRows } = await client.query(
        `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
        [orgId, l.accountId]
      );
      if (!aRows.length) throw new AppError(400, "Invalid accountId");
      if (!aRows[0].is_postable) throw new AppError(400, "Non-postable account used");
      if (aRows[0].status !== "active") throw new AppError(400, "Inactive account used");
    }

    const { rows: jRows } = await client.query(
      `
      INSERT INTO journal_entries
        (organization_id, journal_entry_type_id, period_id, entry_date, memo, status, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,'draft',$6)
      RETURNING id, status
      `,
      [orgId, typeId, payload.periodId, payload.entryDate, payload.memo || null, payload.idempotencyKey || null]
    );
    const journalId = jRows[0].id;

    for (let i = 0; i < payload.lines.length; i++) {
      const l = payload.lines[i];
      const debit = Number(l.debit || 0);
      const credit = Number(l.credit || 0);
      const amountBase = debit > 0 ? debit : credit;

      await client.query(
        `
        INSERT INTO journal_entry_lines
          (journal_entry_id, line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base)
        VALUES ($1,$2,$3,$4,$5,$6,'GHS',1,$7)
        `,
        [journalId, i + 1, l.accountId, l.description || null, debit, credit, amountBase]
      );
    }

    await client.query("COMMIT");
    return { journalId, status: "draft" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function postDraftJournal({ orgId, journalId, actorUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: jRows } = await client.query(
      `
      SELECT id, status, period_id, entry_date
      FROM journal_entries
      WHERE organization_id=$1 AND id=$2
      FOR UPDATE
      `,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const journal = jRows[0];
    if (journal.status !== "draft") throw new AppError(409, "Journal not in draft status");

    const period = await getPeriodForUpdate(client, orgId, journal.period_id);
    if (period.status !== "open") throw new AppError(409, "Period not open");
    assertEntryDateWithinPeriod(journal.entry_date, period);

    const { rows: lines } = await client.query(
      `
      SELECT jel.account_id, jel.debit, jel.credit, jel.currency_code,
             coa.is_postable, coa.status AS account_status
      FROM journal_entry_lines jel
      JOIN chart_of_accounts coa
        ON coa.id = jel.account_id AND coa.organization_id = $1
      WHERE jel.journal_entry_id = $2
      ORDER BY jel.line_no
      `,
      [orgId, journalId]
    );
    if (!lines.length) throw new AppError(400, "Journal has no lines");

    for (const l of lines) {
      if (l.currency_code !== "GHS") throw new AppError(400, "Phase 1 supports base currency only (GHS)");
      if (!l.is_postable) throw new AppError(400, "Non-postable account used");
      if (l.account_status !== "active") throw new AppError(400, "Inactive account used");
    }

    const totals = sum2(lines);
    if (totals.debit !== totals.credit) throw new AppError(400, "Journal not balanced");

    for (const l of lines) {
      const debit = Number(l.debit || 0);
      const credit = Number(l.credit || 0);

      await client.query(
        `
        INSERT INTO general_ledger_balances
          (organization_id, period_id, account_id, debit_total, credit_total)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id, period_id, account_id)
        DO UPDATE SET
          debit_total = general_ledger_balances.debit_total + EXCLUDED.debit_total,
          credit_total = general_ledger_balances.credit_total + EXCLUDED.credit_total
        `,
        [orgId, journal.period_id, l.account_id, debit, credit]
      );
    }

    await client.query(
      `
      UPDATE journal_entries
      SET status='posted', posted_at=NOW(), posted_by=$3
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, journalId, actorUserId]
    );

    await client.query("COMMIT");
    return { journalId, status: "posted" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Accounting-correct void: create and post a reversal journal.
 * - Requires original journal is POSTED and not already voided.
 * - Reversal journal is posted immediately in the SAME period.
 * - Original journal is marked voided with link via memo and void_reason.
 */
async function voidByReversal({ orgId, journalId, actorUserId, reason }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: jRows } = await client.query(
      `
      SELECT id, status, period_id, entry_date, memo, journal_entry_type_id
      FROM journal_entries
      WHERE organization_id=$1 AND id=$2
      FOR UPDATE
      `,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const orig = jRows[0];
    if (orig.status !== "posted") throw new AppError(409, "Only posted journals can be voided");

    const period = await getPeriodForUpdate(client, orgId, orig.period_id);
    if (period.status !== "open") throw new AppError(409, "Period not open; cannot create reversal in this period");

    const { rows: lines } = await client.query(
      `
      SELECT line_no, account_id, description, debit, credit, currency_code
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      ORDER BY line_no
      `,
      [journalId]
    );
    if (!lines.length) throw new AppError(400, "Journal has no lines");
    for (const l of lines) {
      if (l.currency_code !== "GHS") throw new AppError(400, "Phase 1 supports base currency only (GHS)");
    }

    // Create reversal journal (draft)
    const reversalMemo = `Reversal of JE ${journalId}. Reason: ${reason}`;
    const { rows: revRows } = await client.query(
      `
      INSERT INTO journal_entries
        (organization_id, journal_entry_type_id, period_id, entry_date, memo, status)
      VALUES ($1,$2,$3,$4,$5,'draft')
      RETURNING id
      `,
      [orgId, orig.journal_entry_type_id, orig.period_id, orig.entry_date, reversalMemo]
    );
    const reversalId = revRows[0].id;

    // Reverse lines: swap debit/credit
    for (const l of lines) {
      const debit = Number(l.debit || 0);
      const credit = Number(l.credit || 0);
      const newDebit = credit;
      const newCredit = debit;
      const amountBase = newDebit > 0 ? newDebit : newCredit;

      await client.query(
        `
        INSERT INTO journal_entry_lines
          (journal_entry_id, line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base)
        VALUES ($1,$2,$3,$4,$5,$6,'GHS',1,$7)
        `,
        [reversalId, l.line_no, l.account_id, `REV: ${l.description || ""}`.trim(), newDebit, newCredit, amountBase]
      );
    }

    // Post reversal (update GL)
    // Fetch reversal lines for posting
    const { rows: revLines } = await client.query(
      `
      SELECT account_id, debit, credit
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      ORDER BY line_no
      `,
      [reversalId]
    );

    const totals = sum2(revLines);
    if (totals.debit !== totals.credit) throw new AppError(500, "Reversal journal not balanced (unexpected)");

    for (const l of revLines) {
      await client.query(
        `
        INSERT INTO general_ledger_balances
          (organization_id, period_id, account_id, debit_total, credit_total)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id, period_id, account_id)
        DO UPDATE SET
          debit_total = general_ledger_balances.debit_total + EXCLUDED.debit_total,
          credit_total = general_ledger_balances.credit_total + EXCLUDED.credit_total
        `,
        [orgId, orig.period_id, l.account_id, Number(l.debit || 0), Number(l.credit || 0)]
      );
    }

    await client.query(
      `
      UPDATE journal_entries
      SET status='posted', posted_at=NOW(), posted_by=$2
      WHERE organization_id=$1 AND id=$3
      `,
      [orgId, actorUserId, reversalId]
    );

    // Mark original voided (for UX/reporting; GL is corrected by reversal)
    await client.query(
      `
      UPDATE journal_entries
      SET status='voided',
          voided_at=NOW(),
          voided_by=$3,
          void_reason=$4,
          memo = COALESCE(memo,'') || CASE WHEN memo IS NULL OR memo='' THEN '' ELSE ' | ' END || $5
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, journalId, actorUserId, reason, `Voided by reversal JE ${reversalId}`]
    );

    await client.query("COMMIT");
    return { journalId, status: "voided", reversalJournalId: reversalId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { createDraftJournal, postDraftJournal, voidByReversal };
