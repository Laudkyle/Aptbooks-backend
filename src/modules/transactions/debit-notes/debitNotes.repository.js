const { AppError } = require("../../../shared/errors/AppError");

async function getById({ orgId, id, client }) {
  const { rows } = await client.query(
    `SELECT * FROM debit_notes WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  return rows[0] || null;
}

async function getLines({ id, client }) {
  const { rows } = await client.query(
    `SELECT * FROM debit_note_lines WHERE debit_note_id=$1 ORDER BY line_no`,
    [id]
  );
  return rows;
}

async function getApplications({ orgId, id, client }) {
  const { rows } = await client.query(
    `SELECT dna.*, b.bill_no, b.bill_date, b.due_date
       FROM debit_note_applications dna
       JOIN bills b ON b.id = dna.bill_id
      WHERE dna.organization_id=$1 AND dna.debit_note_id=$2
      ORDER BY dna.applied_at ASC`,
    [orgId, id]
  );
  return rows;
}

async function nextDebitNoteNo({ orgId, client }) {
  await client.query(
    `INSERT INTO debit_note_sequences(organization_id, next_no)
     VALUES ($1, 1) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId]
  );
  const { rows } = await client.query(
    `UPDATE debit_note_sequences
        SET next_no = next_no + 1, updated_at=NOW()
      WHERE organization_id=$1
      RETURNING next_no`,
    [orgId]
  );
  const no = BigInt(rows[0].next_no) - 1n;
  return `DN-${String(no).padStart(6, "0")}`;
}

async function createDraft({ orgId, actorUserId, payload, totals, client }) {
  const debitNoteNo = await nextDebitNoteNo({ orgId, client });
  const { rows } = await client.query(
    `INSERT INTO debit_notes(
        organization_id, vendor_id, debit_note_no, debit_note_date,
        memo, subtotal, tax_total, total
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      orgId,
      payload.vendorId,
      debitNoteNo,
      payload.debitNoteDate,
      payload.memo || null,
      totals.subtotal,
      totals.tax_total,
      totals.total
    ]
  );
  const dn = rows[0];

  for (let i = 0;i < payload.lines.length;i++) {
    const l = payload.lines[i];
    await client.query(
      `INSERT INTO debit_note_lines(
          debit_note_id, line_no, description, quantity, unit_price, line_total,
          expense_account_id, tax_code_id, tax_amount
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        dn.id,
        i + 1,
        l.description,
        l.quantity ?? 1,
        l.unitPrice,
        l.lineTotal,
        l.expenseAccountId,
        l.taxCodeId || null,
        l.taxAmount || 0
      ]
    );
  }

  return dn;
}

async function list({ orgId, query, client }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;
  if (query?.status) { where.push(`status=$${i++}`);params.push(query.status);}
  if (query?.vendorId) { where.push(`vendor_id=$${i++}`);params.push(query.vendorId);}
  const { rows } = await client.query(
    `SELECT * FROM debit_notes WHERE ${where.join(" AND ")}
     ORDER BY debit_note_date DESC, created_at DESC
     LIMIT 200`,
    params
  );
  return rows;
}

async function setIssued({ orgId, id, periodId, journalEntryId, actorUserId, client }) {
  const { rows } = await client.query(
    `UPDATE debit_notes
        SET status='issued', period_id=$3, journal_entry_id=$4,
            issued_at=NOW(), issued_by=$5
      WHERE organization_id=$1 AND id=$2 AND status='draft'
      RETURNING *`,
    [orgId, id, periodId, journalEntryId, actorUserId]
  );
  if (!rows.length) throw new AppError(409, "Only draft debit notes can be issued");
  return rows[0];
}

async function insertApplication({ orgId, debitNoteId, billId, amountApplied, actorUserId, client }) {
  const { rows } = await client.query(
    `INSERT INTO debit_note_applications(
        organization_id, debit_note_id, bill_id, amount_applied, applied_by
     ) VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [orgId, debitNoteId, billId, amountApplied, actorUserId]
  );
  return rows[0];
}

async function setVoided({ orgId, id, reversalJournalEntryId, actorUserId, reason, client }) {
  const { rows } = await client.query(
    `UPDATE debit_notes
        SET status='voided', reversal_journal_entry_id=$3,
            voided_at=NOW(), voided_by=$4, void_reason=$5
      WHERE organization_id=$1 AND id=$2 AND status='issued'
      RETURNING *`,
    [orgId, id, reversalJournalEntryId, actorUserId, reason || null]
  );
  if (!rows.length) throw new AppError(409, "Only issued debit notes can be voided");
  return rows[0];
}

module.exports = {
  getById,
  getLines,
  getApplications,
  createDraft,
  list,
  setIssued,
  insertApplication,
  setVoided
};
