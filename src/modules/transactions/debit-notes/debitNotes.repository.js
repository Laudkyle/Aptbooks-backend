const { insertLineTaxDetails } = require("../../../shared/tax/multiTax");
const { AppError } = require("../../../shared/errors/AppError");

async function getById({ orgId, id, currentUserId, client }) {
  const { rows } = await client.query(
    `SELECT 
      dn.*,
      bp.name AS vendor_name,
      bp.code AS vendor_code,
      bp.email AS vendor_email,
      bp.phone AS vendor_phone,
      LOWER(d.workflow_state_code) AS workflow_status,
      COALESCE(app.applied_amount, 0) AS applied_amount,
      GREATEST(dn.total - COALESCE(app.applied_amount, 0), 0) AS remaining_amount,
      (GREATEST(dn.total - COALESCE(app.applied_amount, 0), 0) > 0) AS is_available_for_application,
      CASE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_approve, FALSE)
        ELSE FALSE
      END AS can_approve,
      CASE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_post, FALSE)
        ELSE FALSE
      END AS can_post
     FROM debit_notes dn
     LEFT JOIN business_partners bp
       ON dn.vendor_id = bp.id
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(dna.amount_applied), 0) AS applied_amount
       FROM debit_note_applications dna
       WHERE dna.organization_id = dn.organization_id
         AND dna.debit_note_id = dn.id
     ) app ON TRUE
     LEFT JOIN documents d
       ON d.id = dn.workflow_document_id
      AND d.organization_id = dn.organization_id
     LEFT JOIN LATERAL (
       SELECT
         s.creator_can_approve,
         s.creator_can_post
       FROM document_workflow_statics s
       WHERE s.organization_id = dn.organization_id
         AND (
           s.document_type_id = d.document_type_id
           OR s.document_type_id IS NULL
         )
       ORDER BY
         CASE
           WHEN s.document_type_id = d.document_type_id THEN 0
           ELSE 1
         END
       LIMIT 1
     ) dws ON TRUE
     WHERE dn.organization_id = $1
       AND dn.id = $2`,
    [orgId, id, currentUserId]
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

  for (let i = 0; i < payload.lines.length; i++) {
    const l = payload.lines[i];
    const { rows } = await client.query(
      `INSERT INTO debit_note_lines(
          debit_note_id, line_no, description, quantity, unit_price, line_total,
          expense_account_id, tax_code_id, tax_amount
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
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
    await insertLineTaxDetails({ client, tableName: "debit_note_line_tax_details", lineId: rows[0].id, details: l.taxDetails || [] });
  }

  return dn;
}

async function list({ orgId, query, client }) {
  const params = [orgId];
  const where = ["dn.organization_id=$1"];
  let i = 2;

  if (query?.status) {
    where.push(`dn.status=$${i++}`);
    params.push(query.status);
  }

  if (query?.vendor_id) {
    where.push(`dn.vendor_id=$${i++}`);
    params.push(query.vendor_id);
  }

  const availableOnly = [true, "true", 1, "1", "yes"].includes(query?.available_only) || [true, "true", 1, "1", "yes"].includes(query?.availableOnly);
  if (availableOnly) {
    where.push(`GREATEST(dn.total - COALESCE(app.applied_amount, 0), 0) > 0`);
    if (!query?.status) where.push(`dn.status='issued'`);
  }

  const { rows } = await client.query(
    `SELECT 
      dn.*,
      bp.name as vendor_name,
      bp.code as vendor_code,
      bp.email as vendor_email,
      bp.phone as vendor_phone,
      COALESCE(app.applied_amount, 0) AS applied_amount,
      GREATEST(dn.total - COALESCE(app.applied_amount, 0), 0) AS remaining_amount,
      (GREATEST(dn.total - COALESCE(app.applied_amount, 0), 0) > 0) AS is_available_for_application
     FROM debit_notes dn
     LEFT JOIN business_partners bp ON dn.vendor_id = bp.id
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(dna.amount_applied), 0) AS applied_amount
       FROM debit_note_applications dna
       WHERE dna.organization_id = dn.organization_id
         AND dna.debit_note_id = dn.id
     ) app ON TRUE
     WHERE ${where.join(" AND ")}
     ORDER BY dn.debit_note_date DESC, dn.created_at DESC
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
      WHERE organization_id=$1 AND id=$2 AND status='approved'
      RETURNING *`,
    [orgId, id, periodId, journalEntryId, actorUserId]
  );
  if (!rows.length) throw new AppError(409, "Only approved debit notes can be issued");
  return rows[0];
}

async function insertApplication({ orgId, debitNoteId, billId, amountApplied, actorUserId, client }) {
  const { rows } = await client.query(
    `INSERT INTO debit_note_applications(
        organization_id, debit_note_id, bill_id, amount_applied, applied_by
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::numeric(18,2),$5::uuid)
     RETURNING *, amount_applied AS "amountApplied", bill_id AS "billId"`,
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
