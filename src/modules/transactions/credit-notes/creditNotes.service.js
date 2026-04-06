const { pool } = require("../../../db/pool");
const { withTransaction } = require("../../../db/tx");
const { AppError } = require("../../../shared/errors/AppError");
const periodIF = require("../../../interfaces/periodManagement.interface");
const partnerIF = require("../../../interfaces/partnerManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");
const documentableSvc = require("../../../workflow/documents/documentable.service");

const repo = require("./creditNotes.repository");
const { resolveLineTaxes, round2, loadLineTaxDetails } = require("../../../shared/tax/multiTax");

async function calcTotals({ client, orgId, lines }) {
  let subtotal = 0;
  let tax_total = 0;
  for (const l of lines) {
    const qty = Number(l.quantity ?? 1);
    const up = Number(l.unitPrice ?? 0);
    const lt = Number((qty * up).toFixed(2));
    l.lineTotal = lt;
    const tax = await resolveLineTaxes({ client, orgId, line: l, defaultTaxableAmount: lt });
    l.taxAmount = round2(tax.taxAmount);
    l.taxCodeId = tax.selectedTaxCodeId || null;
    l.taxDetails = tax.components;
    subtotal += lt;
    tax_total += Number(l.taxAmount ?? 0);
  }
  subtotal = Number(subtotal.toFixed(2));
  tax_total = Number(tax_total.toFixed(2));
  const total = Number((subtotal + tax_total).toFixed(2));
  return { subtotal, tax_total, total };
}

async function getTaxSettings({ orgId, client }) {
  const db = client || pool;
  const { rows } = await db.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
  return rows[0] || null;
}

async function getCreditNoteBalances({ orgId, creditNoteId, client }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT
        cn.total,
        COALESCE(SUM(cna.amount_applied),0) AS applied
     FROM credit_notes cn
     LEFT JOIN credit_note_applications cna ON cna.credit_note_id = cn.id AND cna.organization_id=cn.organization_id
     WHERE cn.organization_id=$1 AND cn.id=$2
     GROUP BY cn.total`,
    [orgId, creditNoteId]
  );
  if (!rows.length) throw new AppError(404, "Credit note not found");
  const total = Number(rows[0].total || 0);
  const applied = Number(rows[0].applied || 0);
  const remaining = Number((total - applied).toFixed(2));
  return { total, applied, remaining };
}

async function getInvoiceOpenBalance({ orgId, invoiceId, client }) {
  const db = client || pool;
  const { rows } = await db.query(
    `WITH ralloc AS (
      SELECT cra.invoice_id, SUM(cra.amount_applied) AS allocated
      FROM customer_receipt_allocations cra
      JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
      WHERE cr.organization_id=$1 AND cr.status='posted'
      GROUP BY cra.invoice_id
    ), cnalloc AS (
      SELECT cna.invoice_id, SUM(cna.amount_applied) AS applied
      FROM credit_note_applications cna
      JOIN credit_notes cn ON cn.id = cna.credit_note_id
      WHERE cna.organization_id=$1 AND cn.status='issued'
      GROUP BY cna.invoice_id
    )
    SELECT inv.total,
           COALESCE(ralloc.allocated,0) AS receipts_allocated,
           COALESCE(cnalloc.applied,0) AS credit_applied
      FROM invoices inv
      LEFT JOIN ralloc ON ralloc.invoice_id = inv.id
      LEFT JOIN cnalloc ON cnalloc.invoice_id = inv.id
     WHERE inv.organization_id=$1 AND inv.id=$2`,
    [orgId, invoiceId]
  );
  if (!rows.length) throw new AppError(404, "Invoice not found");
  const total = Number(rows[0].total || 0);
  const allocated = Number(rows[0].receipts_allocated || 0);
  const credit = Number(rows[0].credit_applied || 0);
  return Number((total - allocated - credit).toFixed(2));
}

async function refreshInvoicePaidStatus({ orgId, invoiceId, client }) {
  const open = await getInvoiceOpenBalance({ orgId, invoiceId, client });
  // Only move to PAID if invoice is issued and fully settled.
  await client.query(
    `UPDATE invoices
        SET status = CASE WHEN status='issued' AND $3 <= 0 THEN 'paid' ELSE status END,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2`,
    [orgId, invoiceId, open]
  );
}

async function createDraftCreditNote({ orgId, actorUserId, payload }) {
  // Validate customer
  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: payload.customerId });
  if (!customer.default_receivable_account_id) throw new AppError(400, "Customer missing defaultReceivableAccountId");

  return withTransaction(async (client) => {
    const totals = await calcTotals({ client, orgId, lines: payload.lines });
    const created = await repo.createDraft({ orgId, actorUserId, payload, totals, client });
    return created;
  });
}

async function listCreditNotes({ orgId, query }) {
  const client = await pool.connect();
  try {
    return await repo.list({ orgId, query, client });
  } finally {
    client.release();
  }
}

async function getCreditNoteDetails({ orgId, id, currentUserId }) {
  const client = await pool.connect();

  try {
    const cn = await repo.getById({
      orgId,
      id,
      currentUserId,
      client
    });

    if (!cn) throw new AppError(404, "Credit note not found");

    const lines = await repo.getLines({ id, client });
    const taxMap = await loadLineTaxDetails({ client, tableName: 'credit_note_line_tax_details', lineIds: lines.map((l) => l.id) });
    const applications = await repo.getApplications({ orgId, id, client });
    const bal = await getCreditNoteBalances({
      orgId,
      creditNoteId: id,
      client
    });

    const enrichedLines = await enrichLines({ client, lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })) });

    return {
      ...cn,
      lines: enrichedLines,
      applications,
      balance: bal,
      detail_meta: buildDetailMeta({ header: cn, lines: enrichedLines, extra: { paid: Number((bal?.applied_amount || 0)), outstanding: Number((bal?.remaining_amount || 0)) } })
    };

  } finally {
    client.release();
  }
}



async function assertCreditNoteApprovalStateAllowsIssue({ orgId, creditNote, client }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "credit_note",
    workflowDocumentId: creditNote.workflow_document_id,
    client,
    actionLabel: "issue"
  });
}

async function submitCreditNoteForApproval({ orgId, actorUserId, id }) {
  return withTransaction(async (client) => {
    const docEntity = await repo.getById({ orgId, id, client });
    if (!docEntity) throw new AppError(404, "Credit note not found");
    const lines = await repo.getLines({ id, client });
    const taxMap = await loadLineTaxDetails({ client, tableName: 'credit_note_line_tax_details', lineIds: lines.map((l) => l.id) });
    const applications = await repo.getApplications ? await repo.getApplications({ orgId, id, client }) : [];
    await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "credit_note",
      entity: docEntity,
      workflowDocumentId: docEntity.workflow_document_id,
      snapshot: {
        header: docEntity,
        lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })),
        applications,
        totals: {
          subtotal: docEntity.subtotal,
          tax_total: docEntity.tax_total,
          total: docEntity.total
        },
        meta: {
          status: docEntity.status,
          journal_entry_id: docEntity.journal_entry_id || null,
          period_id: docEntity.period_id || null
        }
      },
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(
          `UPDATE credit_notes SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
          [orgId, id, workflowDocumentId]
        );
      }
    });

    const { rows } = await client.query(`UPDATE credit_notes SET status='submitted', submitted_at=NOW(), submitted_by=$3, approved_at=NULL, approved_by=NULL, rejected_at=NULL, rejected_by=NULL, rejection_reason=NULL, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id, actorUserId]);
    return rows[0];
  });
}

async function approveCreditNoteWorkflow({ orgId, actorUserId, id, comment }) {
  return withTransaction(async (client) => {
    const docEntity = await repo.getById({ orgId, id, client });
    if (!docEntity) throw new AppError(404, "Credit note not found");
    if (!docEntity.workflow_document_id) throw new AppError(409, "Credit note has no workflow document");

    const approved = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "credit_note",
      workflowDocumentId: docEntity.workflow_document_id,
      creatorUserId: docEntity.created_by,
      comment,
      client
    });

    if (approved?.next) {
      const { rows } = await client.query(`UPDATE credit_notes SET status='submitted', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id]);
      return rows[0];
    }

    const { rows } = await client.query(`UPDATE credit_notes SET status='approved', approved_at=NOW(), approved_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id, actorUserId]);
    return rows[0];
  });
}

async function rejectCreditNoteWorkflow({ orgId, actorUserId, id, comment }) {
  return withTransaction(async (client) => {
    const docEntity = await repo.getById({ orgId, id, client });
    if (!docEntity) throw new AppError(404, "Credit note not found");
    if (!docEntity.workflow_document_id) throw new AppError(409, "Credit note has no workflow document");

    const rejected = await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "credit_note",
      workflowDocumentId: docEntity.workflow_document_id,
      creatorUserId: docEntity.created_by,
      comment,
      client
    });

    await client.query(
      `UPDATE credit_notes SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, id, actorUserId, comment || null]
    );

    const { rows } = await client.query(`UPDATE credit_notes SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id, actorUserId, comment || null]);
    return rows[0];
  });
}

async function issueCreditNote({ orgId, actorUserId, id }) {
  return withTransaction(async (client) => {
    const cn = await repo.getById({ orgId, id, client });
    if (!cn) throw new AppError(404, "Credit note not found");
    if (!['draft','approved'].includes(cn.status)) throw new AppError(409, "Only draft/approved credit notes can be issued");

    await assertCreditNoteApprovalStateAllowsIssue({ orgId, creditNote: cn, client });

    const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: cn.customer_id, client });
    if (!customer.default_receivable_account_id) throw new AppError(400, "Customer missing defaultReceivableAccountId");

    const lines = await repo.getLines({ id, client });
    const taxMap = await loadLineTaxDetails({ client, tableName: 'credit_note_line_tax_details', lineIds: lines.map((l) => l.id) });
    if (!lines.length) throw new AppError(400, "Credit note has no lines");

    const taxSettings = await getTaxSettings({ orgId, client });
    const outputTaxAccountId = taxSettings?.output_tax_account_id || null;

    const period = await periodIF.findOpenPeriodForDate({ orgId, date: cn.credit_note_date, client });

    // Build journal lines
    const jl = [];
    for (const l of lines) {
      jl.push({
        accountId: l.revenue_account_id,
        debit: Number(l.line_total),
        credit: 0,
        memo: l.description
      });
    }

    const taxTotal = Number(cn.tax_total || 0);
    if (taxTotal > 0) {
      if (!outputTaxAccountId) throw new AppError(409, "Output tax account is not configured (tax_settings.output_tax_account_id)");
      jl.push({
        accountId: outputTaxAccountId,
        debit: taxTotal,
        credit: 0,
        memo: "Output tax reversal" 
      });
    }

    jl.push({
      accountId: customer.default_receivable_account_id,
      debit: 0,
      credit: Number(cn.total),
      memo: `Credit Note ${cn.credit_note_no}`
    });

    const posted = await journalIF.postJournal({
      orgId,
      actorUserId,
      payload: {
        entryDate: cn.credit_note_date,
        periodId: period.id,
        memo: `Credit Note ${cn.credit_note_no}`,
        sourceType: "CREDIT_NOTE",
        sourceId: cn.id,
        lines: jl
      },
      client
    });

    const issued = await repo.setIssued({
      orgId,
      id,
      periodId: period.id,
      journalEntryId: posted.journalEntryId,
      actorUserId,
      client
    });
    return issued;
  });
}

async function applyCreditNote({ orgId, actorUserId, id, payload }) {
  return withTransaction(async (client) => {
    const cn = await repo.getById({ orgId, id, client });
    if (!cn) throw new AppError(404, "Credit note not found");
    if (cn.status !== 'issued') throw new AppError(409, "Only issued credit notes can be applied");

    const { rows: invRows } = await client.query(
      `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.invoiceId]
    );
    if (!invRows.length) throw new AppError(404, "Invoice not found");
    const inv = invRows[0];
    if (inv.customer_id !== cn.customer_id) throw new AppError(409, "Invoice customer does not match credit note customer");
    if (inv.status === 'voided') throw new AppError(409, "Cannot apply to voided invoice");

    const cnBal = await getCreditNoteBalances({ orgId, creditNoteId: id, client });
    if (payload.amountApplied > cnBal.remaining + 1e-9) throw new AppError(409, "Amount exceeds credit note remaining balance");

    const invOpen = await getInvoiceOpenBalance({ orgId, invoiceId: payload.invoiceId, client });
    if (payload.amountApplied > invOpen + 1e-9) throw new AppError(409, "Amount exceeds invoice open balance");

    const app = await repo.insertApplication({
      orgId,
      creditNoteId: id,
      invoiceId: payload.invoiceId,
      amountApplied: payload.amountApplied,
      actorUserId,
      client
    });

    await refreshInvoicePaidStatus({ orgId, invoiceId: payload.invoiceId, client });
    return app;
  });
}

async function voidCreditNote({ orgId, actorUserId, id, reason }) {
  return withTransaction(async (client) => {
    const cn = await repo.getById({ orgId, id, client });
    if (!cn) throw new AppError(404, "Credit note not found");
    if (cn.status !== 'issued') throw new AppError(409, "Only issued credit notes can be voided");

    const { rows: apps } = await client.query(
      `SELECT 1 FROM credit_note_applications WHERE organization_id=$1 AND credit_note_id=$2 LIMIT 1`,
      [orgId, id]
    );
    if (apps.length) throw new AppError(409, "Cannot void a credit note that has been applied");

    if (!cn.journal_entry_id) throw new AppError(409, "Credit note has no journal entry to reverse");
    const rev = await journalIF.voidPostedJournal({
      orgId,
      journalId: cn.journal_entry_id,
      actorUserId,
      reason: reason || "Void credit note",
      client
    });

    const out = await repo.setVoided({
      orgId,
      id,
      reversalJournalEntryId: rev.journalEntryId,
      actorUserId,
      reason: reason || null,
      client
    });
    return out;
  });
}

module.exports = {
  createDraftCreditNote,
  listCreditNotes,
  getCreditNoteDetails,
  submitCreditNoteForApproval,
  approveCreditNoteWorkflow,
  rejectCreditNoteWorkflow,
  assertCreditNoteApprovalStateAllowsIssue,
  issueCreditNote,
  applyCreditNote,
  voidCreditNote
};
