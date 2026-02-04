const { AppError } = require("../../../shared/errors/AppError");

/**
 * Bank Transactions (cashbook ledger)
 *
 * Purpose:
 * - Keep bank_transactions up to date not only from statement imports, but also from
 *   posted operational journals (customer receipts, vendor payments, bank journals, reversals, etc.)
 *
 * Notes:
 * - bank_transactions.amount is stored in the bank account currency (best effort).
 * - If a journal line affecting a bank account has a currency_code that does not match the
 *   bank account currency and the org base currency differs, we skip that line to avoid
 *   polluting reconciliation with wrong-currency amounts.
 */

async function upsertFromPostedJournal(client, { orgId, journalId, entryDate, actorUserId }) {
  if (!client) throw new AppError(500, "DB client required");
  if (!orgId || !journalId) throw new AppError(400, "orgId and journalId required");

  // Get org base currency.
  const { rows: orgRows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  if (!orgRows.length) throw new AppError(400, "Invalid organization");
  const baseCurrency = String(orgRows[0].base_currency_code || "").toUpperCase();

  // Pull posted journal lines joined to bank_accounts by gl_account_id.
  // We compute per bank_account_id: amount = SUM(debit-credit) in the bank currency.
  const { rows } = await client.query(
    `
    SELECT
      ba.id AS bank_account_id,
      ba.currency_code AS bank_currency,
      SUM(
        CASE
          WHEN UPPER(COALESCE(jel.currency_code, $3)) = UPPER(ba.currency_code) THEN (COALESCE(jel.debit,0) - COALESCE(jel.credit,0))
          WHEN UPPER(ba.currency_code) = UPPER($3) AND UPPER(COALESCE(jel.currency_code, $3)) = UPPER($3) THEN (COALESCE(jel.debit,0) - COALESCE(jel.credit,0))
          ELSE 0
        END
      ) AS amount,
      COUNT(*) FILTER (
        WHERE NOT (
          UPPER(COALESCE(jel.currency_code, $3)) = UPPER(ba.currency_code)
          OR (UPPER(ba.currency_code)=UPPER($3) AND UPPER(COALESCE(jel.currency_code, $3))=UPPER($3))
        )
      ) AS skipped_lines
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    JOIN bank_accounts ba ON ba.gl_account_id = jel.account_id AND ba.organization_id = je.organization_id
    WHERE je.organization_id=$1
      AND je.id=$2
      AND je.status='posted'
    GROUP BY ba.id, ba.currency_code
    `,
    [orgId, journalId, baseCurrency]
  );

  if (!rows.length) return { created: 0, updated: 0, skippedLines: 0 };

  let created = 0;
  let updated = 0;
  let skippedLines = 0;

  for (const r of rows) {
    const bankAccountId = r.bank_account_id;
    const amount = Number(r.amount || 0);
    const skipped = Number(r.skipped_lines || 0);
    skippedLines += skipped;

    // If net amount is zero, do not create a bank transaction row.
    if (Math.abs(amount) < 1e-12) continue;

    const externalId = `journal:${journalId}:${bankAccountId}`;
    const description = `Journal ${journalId}`;

    const res = await client.query(
      `
      INSERT INTO bank_transactions (
        organization_id, bank_account_id, txn_date, amount, description,
        reference, source_type, source_id, journal_entry_id,
        external_id, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,'journal',$7,$7,$8,$9)
      ON CONFLICT (organization_id, bank_account_id, external_id)
      DO UPDATE SET
        txn_date=EXCLUDED.txn_date,
        amount=EXCLUDED.amount,
        description=EXCLUDED.description,
        reference=EXCLUDED.reference,
        journal_entry_id=EXCLUDED.journal_entry_id
      RETURNING (xmax = 0) AS inserted
      `,
      [orgId, bankAccountId, entryDate, amount, description, externalId, journalId, externalId, actorUserId || null]
    );

    if (res.rows?.[0]?.inserted) created += 1;
    else updated += 1;
  }

  return { created, updated, skippedLines };
}

module.exports = {
  upsertFromPostedJournal,
};
