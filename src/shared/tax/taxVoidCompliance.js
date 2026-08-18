const { AppError } = require('../errors/AppError');

/**
 * A posted source may be cancelled while its statutory return is still open,
 * but a finalized return is a frozen filing snapshot. Rewriting the source
 * after finalization would make live books diverge from the filed return.
 *
 * The source tax-ledger rows are intentionally retained for audit/history;
 * reportability is controlled by the source business status.
 */
async function assertSourceNotInFinalizedTaxReturn({
  client,
  orgId,
  sourceType,
  sourceId,
  documentDate = null,
}) {
  if (!client || !orgId || !sourceType || !sourceId) return;

  const { rows: taxRows } = await client.query(
    `SELECT MIN(document_date)::date AS first_date, MAX(document_date)::date AS last_date
       FROM tax_ledger_entries
      WHERE organization_id=$1 AND source_type=$2 AND source_id=$3`,
    [orgId, sourceType, sourceId]
  );
  const firstDate = taxRows[0]?.first_date || null;
  const lastDate = taxRows[0]?.last_date || firstDate || null;
  // A source that never reached the canonical tax ledger was not part of a tax return.
  // Do not block voiding merely because its business date falls inside a finalized period.
  if (!firstDate) return;

  const { rows } = await client.query(
    `SELECT id, tax_type, from_date, to_date, status, finalized_at
       FROM tax_returns
      WHERE organization_id=$1
        AND status IN ('queued','submitted','accepted','finalized')
        AND from_date <= $3::date
        AND to_date >= $2::date
      ORDER BY finalized_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [orgId, firstDate, lastDate]
  );

  if (rows.length) {
    throw new AppError(
      409,
      `This transaction is included in a ${rows[0].status} tax return (${rows[0].tax_type} ${rows[0].from_date} to ${rows[0].to_date}). Do not void it in place; use the statutory adjustment/credit/debit-note or return-amendment workflow so the filed/submitted history remains intact.`
    );
  }
}

module.exports = { assertSourceNotInFinalizedTaxReturn };
