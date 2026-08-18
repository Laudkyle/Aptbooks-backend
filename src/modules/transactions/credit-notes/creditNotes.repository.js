const { insertLineTaxDetails } = require("../../../shared/tax/multiTax");
const { AppError } = require("../../../shared/errors/AppError");



async function getById({ orgId, id, currentUserId, client }) {
  const { rows } = await client.query(
    `SELECT 
      cn.*,
      bp.name AS customer_name,
      bp.code AS customer_code,
      bp.email AS customer_email,
      bp.phone AS customer_phone,
      LOWER(d.workflow_state_code) AS workflow_status,
      COALESCE(app.applied_amount, 0) AS applied_amount,
      GREATEST(cn.total - COALESCE(app.applied_amount, 0), 0) AS remaining_amount,
      (GREATEST(cn.total - COALESCE(app.applied_amount, 0), 0) > 0) AS is_available_for_application,
      CASE
        WHEN d.id IS NOT NULL
         AND LOWER(d.workflow_state_code) = 'submitted'
         AND (
           d.created_by_user_id IS NULL
           OR d.created_by_user_id IS DISTINCT FROM $3::uuid
           OR COALESCE(dws.allow_self_approval, FALSE)
           OR COALESCE(dws.creator_can_approve, FALSE)
         )
         AND EXISTS (
           SELECT 1
           FROM document_approvals da
           WHERE da.document_id = d.id
             AND da.status = 'PENDING'
             AND (
               NOT EXISTS (
                 SELECT 1
                 FROM approval_level_users alu_any
                 WHERE alu_any.approval_level_id = da.approval_level_id
               )
               OR EXISTS (
                 SELECT 1
                 FROM approval_level_users alu_me
                 WHERE alu_me.approval_level_id = da.approval_level_id
                   AND alu_me.user_id = $3::uuid
               )
             )
         )
        THEN TRUE
        ELSE FALSE
      END AS "canApprove",
      CASE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_post, FALSE)
        ELSE FALSE
      END AS "canPost"
     FROM credit_notes cn
     LEFT JOIN business_partners bp
       ON cn.customer_id = bp.id
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(cna.amount_applied), 0) AS applied_amount
       FROM credit_note_applications cna
       WHERE cna.organization_id = cn.organization_id
         AND cna.credit_note_id = cn.id
     ) app ON TRUE
     LEFT JOIN documents d
       ON d.id = cn.workflow_document_id
      AND d.organization_id = cn.organization_id
     LEFT JOIN LATERAL (
       SELECT
         s.creator_can_approve,
         s.creator_can_post,
         s.allow_self_approval
       FROM document_workflow_statics s
       WHERE s.organization_id = cn.organization_id
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
     WHERE cn.organization_id = $1
       AND cn.id = $2`,
    [orgId, id, currentUserId]
  );

  return rows[0] || null;
}



async function getLines({ id, client }) {
  const { rows } = await client.query(
    `SELECT * FROM credit_note_lines WHERE credit_note_id=$1 ORDER BY line_no`,
    [id]
  );
  return rows;
}

async function getApplications({ orgId, id, client }) {
  const { rows } = await client.query(
    `SELECT cna.*,
            inv.invoice_no,
            inv.invoice_date,
            inv.due_date,
            inv.total AS invoice_total,
            inv.currency_code,
            GREATEST(
              inv.total
              - COALESCE((
                  SELECT SUM(cra.amount_applied + COALESCE(cra.discount_taken, 0))
                  FROM customer_receipt_allocations cra
                  JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
                  WHERE cra.invoice_id = inv.id
                    AND cr.organization_id = inv.organization_id
                    AND cr.status = 'posted'
                ), 0)
              - COALESCE((
                  SELECT SUM(cna2.amount_applied)
                  FROM credit_note_applications cna2
                  JOIN credit_notes cn2 ON cn2.id = cna2.credit_note_id
                  WHERE cna2.invoice_id = inv.id
                    AND cna2.organization_id = inv.organization_id
                    AND cn2.status = 'issued'
                ), 0),
              0
            ) AS invoice_outstanding
       FROM credit_note_applications cna
       JOIN invoices inv ON inv.id = cna.invoice_id
      WHERE cna.organization_id=$1 AND cna.credit_note_id=$2
      ORDER BY cna.applied_at ASC`,
    [orgId, id]
  );
  return rows;
}

async function nextCreditNoteNo({ orgId, client }) {
  await client.query(
    `INSERT INTO credit_note_sequences(organization_id, next_no)
     VALUES ($1, 1) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId]
  );
  const { rows } = await client.query(
    `UPDATE credit_note_sequences
        SET next_no = next_no + 1, updated_at=NOW()
      WHERE organization_id=$1
      RETURNING next_no`,
    [orgId]
  );
  const no = BigInt(rows[0].next_no) - 1n;
  return `CN-${String(no).padStart(6, "0")}`;
}

async function createDraft({ orgId, actorUserId, payload, totals, client }) {
  const creditNoteNo = await nextCreditNoteNo({ orgId, client });
  const { rows } = await client.query(
    `INSERT INTO credit_notes(
        organization_id, customer_id, credit_note_no, credit_note_date,
        memo, subtotal, tax_total, total
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      orgId,
      payload.customerId,
      creditNoteNo,
      payload.creditNoteDate,
      payload.memo || null,
      totals.subtotal,
      totals.tax_total,
      totals.total
    ]
  );
  const cn = rows[0];

  for (let i = 0; i < payload.lines.length; i++) {
    const l = payload.lines[i];
    const { rows } = await client.query(
      `INSERT INTO credit_note_lines(
          credit_note_id, line_no, description, quantity, unit_price, line_total,
          revenue_account_id, tax_code_id, tax_amount
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        cn.id,
        i + 1,
        l.description,
        l.quantity ?? 1,
        l.unitPrice,
        l.lineTotal,
        l.revenueAccountId,
        l.taxCodeId || null,
        l.taxAmount || 0
      ]
    );
    await insertLineTaxDetails({ client, tableName: "credit_note_line_tax_details", lineId: rows[0].id, details: l.taxDetails || [] });
  }

  return cn;
}

async function list({ orgId, query, client }) {
  const params = [orgId];
  const where = ["cn.organization_id=$1"];
  let i = 2;

  if (query?.status) {
    where.push(`cn.status=$${i++}`);
    params.push(query.status);
  }

  if (query?.customer_id) {
    where.push(`cn.customer_id=$${i++}`);
    params.push(query.customer_id);
  }

  const availableOnly = [true, "true", 1, "1", "yes"].includes(query?.available_only) || [true, "true", 1, "1", "yes"].includes(query?.availableOnly);
  if (availableOnly) {
    where.push(`GREATEST(cn.total - COALESCE(app.applied_amount, 0), 0) > 0`);
    if (!query?.status) where.push(`cn.status='issued'`);
  }

  const { rows } = await client.query(
    `SELECT 
      cn.*,
      bp.name as customer_name,
      bp.code as customer_code,
      bp.email as customer_email,
      bp.phone as customer_phone,
      COALESCE(app.applied_amount, 0) AS applied_amount,
      GREATEST(cn.total - COALESCE(app.applied_amount, 0), 0) AS remaining_amount,
      (GREATEST(cn.total - COALESCE(app.applied_amount, 0), 0) > 0) AS is_available_for_application
     FROM credit_notes cn
     LEFT JOIN business_partners bp ON cn.customer_id = bp.id
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(cna.amount_applied), 0) AS applied_amount
       FROM credit_note_applications cna
       WHERE cna.organization_id = cn.organization_id
         AND cna.credit_note_id = cn.id
     ) app ON TRUE
     WHERE ${where.join(" AND ")}
     ORDER BY cn.credit_note_date DESC, cn.created_at DESC
     LIMIT 200`,
    params
  );
  return rows;
}
async function setIssued({ orgId, id, periodId, journalEntryId, actorUserId, client }) {
  const { rows } = await client.query(
    `UPDATE credit_notes
        SET status='issued', period_id=$3, journal_entry_id=$4,
            issued_at=NOW(), issued_by=$5
      WHERE organization_id=$1 AND id=$2 AND status='approved'
      RETURNING *`,
    [orgId, id, periodId, journalEntryId, actorUserId]
  );
  if (!rows.length) throw new AppError(409, "Only approved credit notes can be issued");
  return rows[0];
}

async function insertApplication({ orgId, creditNoteId, invoiceId, amountApplied, actorUserId, client }) {
  const { rows } = await client.query(
    `INSERT INTO credit_note_applications(
        organization_id, credit_note_id, invoice_id, amount_applied, applied_by
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::numeric(18,2),$5::uuid)
     RETURNING *, amount_applied AS "amountApplied", invoice_id AS "invoiceId"`,
    [orgId, creditNoteId, invoiceId, amountApplied, actorUserId]
  );
  return rows[0];
}

async function setVoided({ orgId, id, reversalJournalEntryId, actorUserId, reason, client }) {
  const { rows } = await client.query(
    `UPDATE credit_notes
        SET status='voided', reversal_journal_entry_id=$3,
            voided_at=NOW(), voided_by=$4, void_reason=$5
      WHERE organization_id=$1 AND id=$2 AND status='issued'
      RETURNING *`,
    [orgId, id, reversalJournalEntryId, actorUserId, reason || null]
  );
  if (!rows.length) throw new AppError(409, "Only issued credit notes can be voided");
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
