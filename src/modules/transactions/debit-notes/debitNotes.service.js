const { pool } = require("../../../db/pool");
const { withTransaction } = require("../../../db/tx");
const { AppError } = require("../../../shared/errors/AppError");
const periodIF = require("../../../interfaces/periodManagement.interface");
const partnerIF = require("../../../interfaces/partnerManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");
const documentableSvc = require("../../../workflow/documents/documentable.service");

const repo = require("./debitNotes.repository");
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

async function getDebitNoteBalances({ orgId, debitNoteId, client }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT
        dn.total,
        COALESCE(SUM(dna.amount_applied),0) AS applied
     FROM debit_notes dn
     LEFT JOIN debit_note_applications dna ON dna.debit_note_id = dn.id AND dna.organization_id=dn.organization_id
     WHERE dn.organization_id=$1 AND dn.id=$2
     GROUP BY dn.total`,
    [orgId, debitNoteId]
  );
  if (!rows.length) throw new AppError(404, "Debit note not found");
  const total = Number(rows[0].total || 0);
  const applied = Number(rows[0].applied || 0);
  const remaining = Number((total - applied).toFixed(2));
  return { total, applied, remaining };
}

async function getBillOpenBalance({ orgId, billId, client }) {
  const db = client || pool;
  const { rows } = await db.query(
    `WITH palloc AS (
      SELECT vpa.bill_id, SUM(vpa.amount_applied) AS allocated
      FROM vendor_payment_allocations vpa
      JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
      WHERE vp.organization_id=$1 AND vp.status='posted'
      GROUP BY vpa.bill_id
    ), dnalloc AS (
      SELECT dna.bill_id, SUM(dna.amount_applied) AS applied
      FROM debit_note_applications dna
      JOIN debit_notes dn ON dn.id = dna.debit_note_id
      WHERE dna.organization_id=$1 AND dn.status='issued'
      GROUP BY dna.bill_id
    )
    SELECT b.total,
           COALESCE(palloc.allocated,0) AS payments_allocated,
           COALESCE(dnalloc.applied,0) AS debit_applied
      FROM bills b
      LEFT JOIN palloc ON palloc.bill_id = b.id
      LEFT JOIN dnalloc ON dnalloc.bill_id = b.id
     WHERE b.organization_id=$1 AND b.id=$2`,
    [orgId, billId]
  );
  if (!rows.length) throw new AppError(404, "Bill not found");
  const total = Number(rows[0].total || 0);
  const allocated = Number(rows[0].payments_allocated || 0);
  const debit = Number(rows[0].debit_applied || 0);
  return Number((total - allocated - debit).toFixed(2));
}

async function refreshBillPaidStatus({ orgId, billId, client }) {
  const open = await getBillOpenBalance({ orgId, billId, client });
  await client.query(
    `UPDATE bills
        SET status = CASE WHEN status='issued' AND $3 <= 0 THEN 'paid' ELSE status END,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2`,
    [orgId, billId, open]
  );
}

async function createDraftDebitNote({ orgId, actorUserId, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId });
  if (vendor.type !== 'vendor') throw new AppError(400, "Partner is not a vendor");
  if (vendor.status !== 'active') throw new AppError(400, "Vendor is inactive");
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

  const totals = calcTotals(payload.lines);

  return withTransaction(async (client) => {
    return repo.createDraft({ orgId, actorUserId, payload, totals, client });
  });
}

async function listDebitNotes({ orgId, query }) {
  const client = await pool.connect();
  try {
    return await repo.list({ orgId, query, client });
  } finally {
    client.release();
  }
}

async function getDebitNoteDetails({ orgId, id, currentUserId }) {
  const client = await pool.connect();
  try {
    const dn = await repo.getById({ orgId, id, client, currentUserId});
    if (!dn) throw new AppError(404, "Debit note not found");
    const lines = await repo.getLines({ id, client });
    const taxMap = await loadLineTaxDetails({ client, tableName: 'debit_note_line_tax_details', lineIds: lines.map((l) => l.id) });
    const applications = await repo.getApplications({ orgId, id, client });
    const bal = await getDebitNoteBalances({ orgId, debitNoteId: id, client });
    return { ...dn, lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })), applications, balance: bal };
  } finally {
    client.release();
  }
}



async function assertDebitNoteApprovalStateAllowsIssue({ orgId, debitNote, client }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "debit_note",
    workflowDocumentId: debitNote.workflow_document_id,
    client,
    actionLabel: "issue"
  });
}

async function submitDebitNoteForApproval({ orgId, actorUserId, id }) {
  return withTransaction(async (client) => {
    const docEntity = await repo.getById({ orgId, id, client });
    if (!docEntity) throw new AppError(404, "Debit note not found");
    const lines = await repo.getLines({ id, client });
    const taxMap = await loadLineTaxDetails({ client, tableName: 'debit_note_line_tax_details', lineIds: lines.map((l) => l.id) });
    const applications = await repo.getApplications ? await repo.getApplications({ orgId, id, client }) : [];
    return documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "debit_note",
      entity: docEntity,
      workflowDocumentId: docEntity.workflow_document_id,
      snapshot: {
        header: docEntity,
        lines,
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
          `UPDATE debit_notes SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
          [orgId, id, workflowDocumentId]
        );
      }
    });
  });
}

async function approveDebitNoteWorkflow({ orgId, actorUserId, id, comment }) {
  return withTransaction(async (client) => {
    const docEntity = await repo.getById({ orgId, id, client });
    if (!docEntity) throw new AppError(404, "Debit note not found");
    if (!docEntity.workflow_document_id) throw new AppError(409, "Debit note has no workflow document");

    const approved = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "debit_note",
      workflowDocumentId: docEntity.workflow_document_id,
      creatorUserId: docEntity.created_by,
      comment,
      client
    });

    await client.query(
      `UPDATE debit_notes SET status='approved', approved_at=NOW(), approved_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, id, actorUserId]
    );

    return approved;
  });
}

async function rejectDebitNoteWorkflow({ orgId, actorUserId, id, comment }) {
  return withTransaction(async (client) => {
    const docEntity = await repo.getById({ orgId, id, client });
    if (!docEntity) throw new AppError(404, "Debit note not found");
    if (!docEntity.workflow_document_id) throw new AppError(409, "Debit note has no workflow document");

    const rejected = await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "debit_note",
      workflowDocumentId: docEntity.workflow_document_id,
      creatorUserId: docEntity.created_by,
      comment,
      client
    });

    await client.query(
      `UPDATE debit_notes SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
      [orgId, id, actorUserId, comment || null]
    );

    return rejected;
  });
}

async function issueDebitNote({ orgId, actorUserId, id }) {
  return withTransaction(async (client) => {
    const dn = await repo.getById({ orgId, id, client });
    if (!dn) throw new AppError(404, "Debit note not found");
    if (!['draft','approved'].includes(dn.status)) throw new AppError(409, "Only draft/approved debit notes can be issued");

    await assertDebitNoteApprovalStateAllowsIssue({ orgId, debitNote: dn, client });

    const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: dn.vendor_id, client });
    if (vendor.type !== 'vendor') throw new AppError(400, "Partner is not a vendor");
    if (vendor.status !== 'active') throw new AppError(400, "Vendor is inactive");
    if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

    const lines = await repo.getLines({ id, client });
    const taxMap = await loadLineTaxDetails({ client, tableName: 'debit_note_line_tax_details', lineIds: lines.map((l) => l.id) });
    if (!lines.length) throw new AppError(400, "Debit note has no lines");

    const taxSettings = await getTaxSettings({ orgId, client });
    const inputTaxAccountId = taxSettings?.input_tax_account_id || null;

    const period = await periodIF.findOpenPeriodForDate({ orgId, date: dn.debit_note_date, client });

    const jl = [];

    // Debit AP (reduce payable)
    jl.push({
      accountId: vendor.default_payable_account_id,
      debit: Number(dn.total),
      credit: 0,
      memo: `Debit Note ${dn.debit_note_no}`
    });

    // Credit expense lines
    for (const l of lines) {
      jl.push({
        accountId: l.expense_account_id,
        debit: 0,
        credit: Number(l.line_total),
        memo: l.description
      });
    }

    const taxTotal = Number(dn.tax_total || 0);
    if (taxTotal > 0) {
      if (!inputTaxAccountId) throw new AppError(409, "Input tax account is not configured (tax_settings.input_tax_account_id)");
      jl.push({
        accountId: inputTaxAccountId,
        debit: 0,
        credit: taxTotal,
        memo: "Input tax reversal"
      });
    }

    const posted = await journalIF.postJournal({
      orgId,
      actorUserId,
      payload: {
        entryDate: dn.debit_note_date,
        periodId: period.id,
        memo: `Debit Note ${dn.debit_note_no}`,
        sourceType: "DEBIT_NOTE",
        sourceId: dn.id,
        lines: jl
      },
      client
    });

    return repo.setIssued({
      orgId,
      id,
      periodId: period.id,
      journalEntryId: posted.journalEntryId,
      actorUserId,
      client
    });
  });
}

async function applyDebitNote({ orgId, actorUserId, id, payload }) {
  return withTransaction(async (client) => {
    const dn = await repo.getById({ orgId, id, client });
    if (!dn) throw new AppError(404, "Debit note not found");
    if (dn.status !== 'issued') throw new AppError(409, "Only issued debit notes can be applied");

    const { rows: billRows } = await client.query(
      `SELECT * FROM bills WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.billId]
    );
    if (!billRows.length) throw new AppError(404, "Bill not found");
    const bill = billRows[0];
    if (bill.vendor_id !== dn.vendor_id) throw new AppError(409, "Bill vendor does not match debit note vendor");
    if (bill.status === 'voided') throw new AppError(409, "Cannot apply to voided bill");

    const dnBal = await getDebitNoteBalances({ orgId, debitNoteId: id, client });
    if (payload.amountApplied > dnBal.remaining + 1e-9) throw new AppError(409, "Amount exceeds debit note remaining balance");

    const billOpen = await getBillOpenBalance({ orgId, billId: payload.billId, client });
    if (payload.amountApplied > billOpen + 1e-9) throw new AppError(409, "Amount exceeds bill open balance");

    const app = await repo.insertApplication({
      orgId,
      debitNoteId: id,
      billId: payload.billId,
      amountApplied: payload.amountApplied,
      actorUserId,
      client
    });

    await refreshBillPaidStatus({ orgId, billId: payload.billId, client });
    return app;
  });
}

async function voidDebitNote({ orgId, actorUserId, id, reason }) {
  return withTransaction(async (client) => {
    const dn = await repo.getById({ orgId, id, client });
    if (!dn) throw new AppError(404, "Debit note not found");
    if (dn.status !== 'issued') throw new AppError(409, "Only issued debit notes can be voided");

    const { rows: apps } = await client.query(
      `SELECT 1 FROM debit_note_applications WHERE organization_id=$1 AND debit_note_id=$2 LIMIT 1`,
      [orgId, id]
    );
    if (apps.length) throw new AppError(409, "Cannot void a debit note that has been applied");

    if (!dn.journal_entry_id) throw new AppError(409, "Debit note has no journal entry to reverse");
    const rev = await journalIF.voidPostedJournal({
      orgId,
      journalId: dn.journal_entry_id,
      actorUserId,
      reason: reason || "Void debit note",
      client
    });

    return repo.setVoided({
      orgId,
      id,
      reversalJournalEntryId: rev.journalEntryId,
      actorUserId,
      reason: reason || null,
      client
    });
  });
}

module.exports = {
  createDraftDebitNote,
  listDebitNotes,
  getDebitNoteDetails,
  submitDebitNoteForApproval,
  approveDebitNoteWorkflow,
  rejectDebitNoteWorkflow,
  assertDebitNoteApprovalStateAllowsIssue,
  issueDebitNote,
  applyDebitNote,
  voidDebitNote
};
