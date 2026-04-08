const { pool } = require("../../../db/pool");
const { withTransaction } = require("../../../db/tx");
const { AppError } = require("../../../shared/errors/AppError");
const periodIF = require("../../../interfaces/periodManagement.interface");
const partnerIF = require("../../../interfaces/partnerManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");
const documentableSvc = require("../../../workflow/documents/documentable.service");

const repo = require("./debitNotes.repository");
const { propagateDocumentWorkflowToJournal } = require("../_shared/workflowJournalAudit.service");
const { resolveLineTaxes, round2, loadLineTaxDetails, summarizeResolvedTaxes } = require("../../../shared/tax/multiTax");
const { enrichLines, buildDetailMeta } = require("../_shared/detailEnrichment");
async function calcTotals({ client, orgId, lines }) {
  let subtotal = 0;
  let tax_total = 0;
  for (const l of lines) {
    const qty = Number(l.quantity ?? 1);
    const up = Number(l.unitPrice ?? 0);
    const lt = Number((qty * up).toFixed(2));
    l.lineTotal = lt;
    const tax = await resolveLineTaxes({ client, orgId, line: l, defaultTaxableAmount: lt });
    const resolvedTaxSummary = summarizeResolvedTaxes(tax.components);
    l.taxableAmount = round2(lt - resolvedTaxSummary.inclusiveNonWithholdingTax);
    l.taxAmount = round2(resolvedTaxSummary.totalNonWithholdingTax);
    l.taxCodeId = tax.selectedTaxCodeId || null;
    l.taxDetails = tax.components;
    subtotal += Number(l.taxableAmount ?? 0);
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

  return withTransaction(async (client) => {
    const totals = await calcTotals({ client, orgId, lines: payload.lines });
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
    const enrichedLines = await enrichLines({ client, lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })) });
    return { ...dn, lines: enrichedLines, applications, balance: bal, detail_meta: buildDetailMeta({ header: dn, lines: enrichedLines, extra: { paid: Number((bal?.applied_amount || 0)), outstanding: Number((bal?.remaining_amount || 0)) } }) };
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

    if (approved?.next) {
      const { rows } = await client.query(`UPDATE debit_notes SET status='submitted', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id]);
      return rows[0];
    }

    const { rows } = await client.query(`UPDATE debit_notes SET status='approved', approved_at=NOW(), approved_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id, actorUserId]);
    return rows[0];
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

    const { rows } = await client.query(`UPDATE debit_notes SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, id, actorUserId, comment || null]);
    return rows[0];
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
    const reverseChargeTaxAccountId = taxSettings?.reverse_charge_tax_account_id || inputTaxAccountId || null;
    const withholdingPayableAccountId = taxSettings?.withholding_tax_payable_account_id || null;

    const period = await periodIF.findOpenPeriodForDate({ orgId, date: dn.debit_note_date, client });

    const postingLines = lines.map((l) => ({ ...l, taxDetails: taxMap.get(l.id) || [] }));
    const { summarizeLineTaxDetails } = require("../../../shared/tax/posting");
    const taxSummary = summarizeLineTaxDetails(postingLines);

    const expenseMap = new Map();
    for (const l of postingLines) {
      const lineTax = taxSummary.byLineId.get(l.id) || { nonRecoverable: 0 };
      const expenseAmount = Number((Number(l.taxable_amount ?? l.line_total ?? 0) + Number(lineTax.nonRecoverable || 0)).toFixed(2));
      expenseMap.set(l.expense_account_id, (expenseMap.get(l.expense_account_id) || 0) + expenseAmount);
    }

    const journalLines = [];
    for (const [accountId, amt] of expenseMap.entries()) {
      journalLines.push({ accountId, debit: 0, credit: Number(amt.toFixed(2)), description: `Expense reversal for ${dn.debit_note_no}` });
    }

    if (taxSummary.recoverableInputTax > 0) {
      if (!inputTaxAccountId) throw new AppError(409, "Input tax account is not configured (tax_settings.input_tax_account_id)");
      journalLines.push({ accountId: inputTaxAccountId, debit: 0, credit: taxSummary.recoverableInputTax, description: `Recoverable input tax reversal for ${dn.debit_note_no}` });
    }
    if (taxSummary.reverseChargeTax > 0 && reverseChargeTaxAccountId) {
      journalLines.push({ accountId: reverseChargeTaxAccountId, debit: taxSummary.reverseChargeTax, credit: 0, description: `Reverse charge tax debit reversal for ${dn.debit_note_no}` });
      journalLines.push({ accountId: reverseChargeTaxAccountId, debit: 0, credit: taxSummary.reverseChargeTax, description: `Reverse charge tax credit reversal for ${dn.debit_note_no}` });
    }
    if (taxSummary.withholdingPayable > 0) {
      if (!withholdingPayableAccountId) {
        throw new AppError(409, 'Withholding tax payable account is not configured (tax_settings.withholding_tax_payable_account_id)');
      }
      journalLines.push({ accountId: withholdingPayableAccountId, debit: taxSummary.withholdingPayable, credit: 0, description: `Withholding tax payable reversal for ${dn.debit_note_no}` });
    }

    const computedPayableReduction = Number((journalLines.reduce((sum, line) => sum + Number(line.credit || 0), 0) - journalLines.reduce((sum, line) => sum + Number(line.debit || 0), 0)).toFixed(2));
    if (computedPayableReduction <= 0) {
      throw new AppError(400, `Computed payable reduction is invalid for ${dn.debit_note_no}`);
    }
    journalLines.unshift({ accountId: vendor.default_payable_account_id, debit: computedPayableReduction, credit: 0, description: `A/P reversal for ${dn.debit_note_no}` });

    const idempotencyKey = `debit_note:${id}:issue`;
    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: dn.debit_note_date,
        typeCode: 'GENERAL',
        memo: `Debit Note ${dn.debit_note_no}` + (dn.memo ? `: ${dn.memo}` : ''),
        idempotencyKey,
        lines: journalLines
      }
    });

    await propagateDocumentWorkflowToJournal({
      client,
      journalId: draft.journalId,
      source: {
        orgId,
        workflowDocumentId: dn.workflow_document_id || null,
        createdBy: dn.created_by || actorUserId,
        submittedAt: dn.submitted_at || null,
        submittedBy: dn.submitted_by || null,
        approvedAt: dn.approved_at || null,
        approvedBy: dn.approved_by || null,
        updatedBy: actorUserId
      }
    });

    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });

    return repo.setIssued({
      orgId,
      id,
      periodId: period.id,
      journalEntryId: posted.journalId,
      actorUserId,
      client
    });
  });
}

async function applyDebitNote({ orgId, actorUserId, id, payload }) {
  return withTransaction(async (client) => {
    const normalizedPayload = {
      billId: String(payload?.billId ?? payload?.bill_id ?? '').trim(),
      amountApplied: Number(payload?.amountApplied ?? payload?.amount_applied ?? payload?.amount ?? 0)
    };
    if (!normalizedPayload.billId) throw new AppError(400, "billId is required");
    if (!Number.isFinite(normalizedPayload.amountApplied) || normalizedPayload.amountApplied <= 0) {
      throw new AppError(400, "amountApplied must be > 0", null, "validation_error");
    }

    const dn = await repo.getById({ orgId, id, client });
    if (!dn) throw new AppError(404, "Debit note not found");
    if (dn.status !== 'issued') throw new AppError(409, "Only issued debit notes can be applied");

    const { rows: billRows } = await client.query(
      `SELECT * FROM bills WHERE organization_id=$1 AND id=$2`,
      [orgId, normalizedPayload.billId]
    );
    if (!billRows.length) throw new AppError(404, "Bill not found");
    const bill = billRows[0];
    if (bill.vendor_id !== dn.vendor_id) throw new AppError(409, "Bill vendor does not match debit note vendor");
    if (bill.status === 'voided') throw new AppError(409, "Cannot apply to voided bill");

    const dnBal = await getDebitNoteBalances({ orgId, debitNoteId: id, client });
    if (normalizedPayload.amountApplied > dnBal.remaining + 1e-9) throw new AppError(409, "Amount exceeds debit note remaining balance");

    const billOpen = await getBillOpenBalance({ orgId, billId: normalizedPayload.billId, client });
    if (normalizedPayload.amountApplied > billOpen + 1e-9) throw new AppError(409, "Amount exceeds bill open balance");

    const app = await repo.insertApplication({
      orgId,
      debitNoteId: id,
      billId: normalizedPayload.billId,
      amountApplied: Number(normalizedPayload.amountApplied.toFixed(2)),
      actorUserId,
      client
    });

    await refreshBillPaidStatus({ orgId, billId: normalizedPayload.billId, client });
    const balance = await getDebitNoteBalances({ orgId, debitNoteId: id, client });
    return { ...app, balance, is_available_for_application: balance.remaining > 0 };
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
