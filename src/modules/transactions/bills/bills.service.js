const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { withTransaction } = require("../../../db/tx");

const periodIF = require("../../../interfaces/periodManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");
const documentsSvc = require("../../../workflow/documents/documents.service");
const documentableSvc = require("../../../workflow/documents/documentable.service");
const partnerIF = require("../../../interfaces/partnerManagement.interface");

const {
  multiplyQtyByUnitPriceToMoney,
  bigIntToDecimalString,
  parseDecimalToBigInt
} = require("../../../shared/utils/money");

const repo = require("./bills.repository");
const { resolveLineTaxes, loadLineTaxDetails, upsertDocumentTaxSnapshot, summarizeResolvedTaxes } = require("../../../shared/tax/multiTax");
const { summarizeLineTaxDetails } = require("../../../shared/tax/posting");
const { enrichLines, buildDetailMeta } = require("../_shared/detailEnrichment");
const { propagateDocumentWorkflowToJournal } = require("../_shared/workflowJournalAudit.service");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const { assertSourceNotInFinalizedTaxReturn } = require("../../../shared/tax/taxVoidCompliance");
const {
  moneyUnits,
  moneyStringFromUnits,
  moneyNumber,
} = require("../../../shared/utils/financialMath");

async function getOrgBaseCurrency(client, orgId) {
  const { rows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, "Invalid organization");
  return rows[0].base_currency_code;
}

async function assertPostableActiveAccount({ orgId, accountId, errMsg }) {
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, errMsg || "Invalid account");
  if (!rows[0].is_postable) throw new AppError(400, "Non-postable account used");
  if (rows[0].status !== "active") throw new AppError(400, "Inactive account used");
}

async function prepareBillLines({ client, orgId, payload, lines }) {
  let subtotalCents = 0n;
  let taxTotalCents = 0n;
  let withholdingTotalCents = 0n;
  const computed = [];

  for (const l of lines) {
    const qty = l.quantity ?? 1;
    const unitPrice = l.unitPrice ?? 0;
    const lineCents = multiplyQtyByUnitPriceToMoney(qty, unitPrice, 4, 2);
    const enteredLineAmount = bigIntToDecimalString(lineCents, 2);
    const tax = await resolveLineTaxes({
      client,
      orgId,
      line: l,
      defaultTaxableAmount: enteredLineAmount,
      context: {
        partnerId: payload.vendorId,
        partnerType: "vendor",
        transactionScope: "purchases",
        documentType: "bill",
        documentDate: payload.billDate,
        jurisdictionId: payload.jurisdictionId || null,
        pricingMode: payload.pricingMode || payload.pricing_mode || null,
        supplyType: l.supplyType || payload.supplyType || null,
        placeOfSupply: payload.placeOfSupply || null,
        placeOfSupplyCountryCode: l.placeOfSupplyCountryCode || payload.placeOfSupplyCountryCode || null,
        industry: payload.industry || null,
        partnerCountryCode: payload.placeOfSupplyCountryCode || null
      }
    });
    const resolvedTaxSummary = summarizeResolvedTaxes(tax.components);
    const inclusiveTaxCents = parseDecimalToBigInt(resolvedTaxSummary.inclusiveNonWithholdingTax, 2);
    const taxableCents = lineCents - inclusiveTaxCents;
    const taxableAmount = bigIntToDecimalString(taxableCents, 2);
    subtotalCents += taxableCents;
    taxTotalCents += parseDecimalToBigInt(resolvedTaxSummary.totalNonWithholdingTax, 2);
    withholdingTotalCents += parseDecimalToBigInt(resolvedTaxSummary.withholdingTax, 2);
    computed.push({
      ...l,
      quantity: qty,
      unitPrice,
      lineTotal: enteredLineAmount,
      taxableAmount,
      taxAmount: resolvedTaxSummary.totalNonWithholdingTax,
      taxCodeId: tax.selectedTaxCodeId || null,
      taxDetails: tax.components,
      taxSnapshot: tax.snapshot
    });
  }

  const subtotal = bigIntToDecimalString(subtotalCents, 2);
  const taxTotal = bigIntToDecimalString(taxTotalCents, 2);
  const withholdingTotal = bigIntToDecimalString(withholdingTotalCents, 2);
  const total = bigIntToDecimalString(subtotalCents + taxTotalCents, 2);
  const netSettlementTotal = bigIntToDecimalString(subtotalCents + taxTotalCents - withholdingTotalCents, 2);
  return { computed, subtotal, taxTotal, withholdingTotal, netSettlementTotal, total };
}

async function previewBillTaxes({ orgId, payload }) {
  const client = await pool.connect();
  try {
    const result = await prepareBillLines({ client, orgId, payload, lines: payload.lines || [] });
    return {
      lines: result.computed.map((line, index) => ({
        lineNo: index + 1,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        taxableAmount: line.taxableAmount,
        taxAmount: line.taxAmount,
        taxCodeId: line.taxCodeId,
        taxDetails: line.taxDetails || [],
      })),
      subtotal: result.subtotal,
      taxTotal: result.taxTotal,
      withholdingTotal: result.withholdingTotal,
      netSettlementTotal: result.netSettlementTotal,
      total: result.total,
    };
  } finally {
    client.release();
  }
}

async function createDraftBill({ orgId, actorUserId, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId });
  if (vendor.type !== "vendor") throw new AppError(400, "Partner is not a vendor");
  if (vendor.status !== "active") throw new AppError(400, "Vendor is inactive");
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

  for (const l of payload.lines) {
    await assertPostableActiveAccount({ orgId, accountId: l.expenseAccountId, errMsg: "Invalid expenseAccountId" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { computed, subtotal, taxTotal, withholdingTotal, netSettlementTotal, total } = await prepareBillLines({ client, orgId, payload, lines: payload.lines });
    const baseCurrency = await getOrgBaseCurrency(client, orgId);

    const billNo = await repo.nextBillNo(client, orgId);
    const bill = await repo.insertBill(client, {
      orgId,
      vendorId: payload.vendorId,
      billNo,
      billDate: payload.billDate,
      dueDate: payload.dueDate,
      memo: payload.memo,
      subtotal,
      taxTotal,
      total,
      currencyCode: baseCurrency,
      withholdingTotal,
      netSettlementTotal,
      createdBy: actorUserId
    });

    for (let i = 0; i < computed.length; i++) {
      const l = computed[i];
      await repo.insertBillLine(client, {
        billId: bill.id,
        lineNo: i + 1,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        expenseAccountId: l.expenseAccountId,
        taxCodeId: l.taxCodeId || null,
        taxAmount: l.taxAmount || 0,
        taxableAmount: l.taxableAmount || 0,
        taxSnapshot: l.taxSnapshot || {},
        taxDetails: l.taxDetails || []
      });
    }

    await client.query("COMMIT");
    return bill;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function updateDraftBill({ orgId, actorUserId, billId, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId });
  if (vendor.type !== "vendor") throw new AppError(400, "Partner is not a vendor");
  if (vendor.status !== "active") throw new AppError(400, "Vendor is inactive");
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");
  for (const l of payload.lines) {
    await assertPostableActiveAccount({ orgId, accountId: l.expenseAccountId, errMsg: "Invalid expenseAccountId" });
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, billId]
    );
    if (!rows.length) throw new AppError(404, "Bill not found");
    const before = rows[0];
    if (before.status !== 'draft') throw new AppError(409, "Only draft bills can be edited");

    const { computed, subtotal, taxTotal, withholdingTotal, netSettlementTotal, total } = await prepareBillLines({
      client, orgId, payload, lines: payload.lines
    });
    const { rows: updatedRows } = await client.query(
      `UPDATE bills
          SET vendor_id=$3, bill_date=$4, due_date=$5, memo=$6,
              subtotal=$7, tax_total=$8, total=$9, withholding_total=$10,
              net_settlement_total=$11, updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [orgId, billId, payload.vendorId, payload.billDate, payload.dueDate, payload.memo || null, subtotal, taxTotal, total, withholdingTotal, netSettlementTotal]
    );

    await client.query(`DELETE FROM bill_lines WHERE bill_id=$1`, [billId]);
    for (let i = 0; i < computed.length; i++) {
      const l = computed[i];
      await repo.insertBillLine(client, {
        billId, lineNo: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        lineTotal: l.lineTotal, expenseAccountId: l.expenseAccountId, taxCodeId: l.taxCodeId || null,
        taxAmount: l.taxAmount || 0, taxableAmount: l.taxableAmount || 0, taxSnapshot: l.taxSnapshot || {},
        taxDetails: l.taxDetails || []
      });
    }

    await writeAudit({
      organizationId: orgId, actorUserId, action: 'bill.draft_updated', entityType: 'bills',
      entityId: billId, before, after: updatedRows[0], client
    });
    return updatedRows[0];
  });
}

async function getBillDetails({ orgId, billId, currentUserId }) {
  const bill = await repo.getBillById(orgId, billId, currentUserId);
  if (!bill) throw new AppError(404, "Bill not found");

  const lines = await repo.getBillLines(billId);
  const taxMap = await loadLineTaxDetails({ client: pool, tableName: 'bill_line_tax_details', lineIds: lines.map((l) => l.id) });

  const { rows: paidRows } = await pool.query(
    `
    SELECT
      COALESCE((
        SELECT SUM(vpa.amount_applied)
        FROM vendor_payment_allocations vpa
        JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
        WHERE vpa.bill_id=$1
          AND vp.organization_id=$2
          AND vp.status='posted'
      ),0) AS paid,
      COALESCE((
        SELECT SUM(dna.amount_applied)
        FROM debit_note_applications dna
        WHERE dna.organization_id=$2
          AND dna.bill_id=$1
      ),0) AS debit_applied
    `,
    [billId, orgId]
  );

  const paidUnits = moneyUnits(paidRows[0]?.paid || "0");
  const debitAppliedUnits = moneyUnits(paidRows[0]?.debit_applied || "0");
  const settlementUnits = moneyUnits(bill.net_settlement_total ?? bill.total ?? "0");
  const rawOutstandingUnits = settlementUnits - paidUnits - debitAppliedUnits;
  const outstandingUnits = rawOutstandingUnits > 0n ? rawOutstandingUnits : 0n;
  const paid = moneyNumber(moneyStringFromUnits(paidUnits));
  const debitApplied = moneyNumber(moneyStringFromUnits(debitAppliedUnits));
  const outstanding = moneyNumber(moneyStringFromUnits(outstandingUnits));

  const enrichedLines = await enrichLines({ client: pool, lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })) });

  return {
    bill,
    lines: enrichedLines,
    paid,
    debitApplied,
    outstanding,
    detail_meta: buildDetailMeta({ header: bill, lines: enrichedLines, extra: { paid, debitApplied, outstanding } })
  };
}

async function listBills({ orgId, query }) {
  return repo.listBills({ orgId, query });
}

async function assertBillApprovalStateAllowsIssue({ orgId, bill, client }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "bill",
    workflowDocumentId: bill.workflow_document_id,
    client,
    actionLabel: "issue"
  });
}

async function issueBill({ orgId, actorUserId, billId }) {
  return withTransaction(async (client) => {
    const { rows: billRows } = await client.query(
      `SELECT * FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, billId]
    );
    if (!billRows.length) throw new AppError(404, "Bill not found");
    const bill = billRows[0];
    if (!["draft", "approved"].includes(bill.status)) throw new AppError(409, "Only draft or approved bills can be issued");

    await assertBillApprovalStateAllowsIssue({ orgId, bill, client });

    const { rows: lines } = await client.query(
      `SELECT * FROM bill_lines WHERE bill_id=$1 ORDER BY line_no`,
      [billId]
    );
    if (!lines.length) throw new AppError(400, "Bill has no lines");

    const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: bill.vendor_id, client });
    if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

    const period = await periodIF.findOpenPeriodForDate({ orgId, date: bill.bill_date, client });

    const taxMap = await loadLineTaxDetails({ client, tableName: "bill_line_tax_details", lineIds: lines.map((l) => l.id) });
    const postingLines = lines.map((l) => ({ ...l, taxDetails: taxMap.get(l.id) || [] }));
    const taxSummary = summarizeLineTaxDetails(postingLines);
    const exactTaxSummary = taxSummary.exact;
    const expenseMap = new Map();
    for (const l of postingLines) {
      await assertPostableActiveAccount({ orgId, accountId: l.expense_account_id, errMsg: "Invalid expenseAccountId" });
      const taxBuckets = exactTaxSummary.byLineId.get(l.id) || { nonRecoverable: 0 };
      const expenseUnits = moneyUnits(l.taxable_amount ?? l.line_total ?? "0") + moneyUnits(taxBuckets.nonRecoverable || "0");
      expenseMap.set(l.expense_account_id, (expenseMap.get(l.expense_account_id) || 0n) + expenseUnits);
    }

    const apAccountId = vendor.default_payable_account_id;
    const { rows: taxSettingsRows } = await client.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
    const settings = taxSettingsRows[0] || {};
    const inputTaxAccountId = settings.input_tax_account_id || null;
    const reverseChargeTaxAccountId = settings.reverse_charge_tax_account_id || inputTaxAccountId || null;

    const journalLines = [];
    for (const [accountId, amountUnits] of expenseMap.entries()) {
      journalLines.push({ accountId, debit: moneyStringFromUnits(amountUnits), credit: "0.00", description: `Expense for ${bill.bill_no}` });
    }
    const recoverableInputTaxUnits = moneyUnits(exactTaxSummary.recoverableInputTax || "0");
    if (recoverableInputTaxUnits > 0n) {
      if (!inputTaxAccountId) throw new AppError(409, 'Input tax account is not configured (tax_settings.input_tax_account_id)');
      journalLines.push({ accountId: inputTaxAccountId, debit: moneyStringFromUnits(recoverableInputTaxUnits), credit: "0.00", description: `Recoverable input tax for ${bill.bill_no}` });
    }
    const reverseChargeTaxUnits = moneyUnits(exactTaxSummary.reverseChargeTax || "0");
    if (reverseChargeTaxUnits > 0n && reverseChargeTaxAccountId) {
      const reverseChargeAmount = moneyStringFromUnits(reverseChargeTaxUnits);
      journalLines.push({ accountId: reverseChargeTaxAccountId, debit: reverseChargeAmount, credit: "0.00", description: `Reverse charge tax debit for ${bill.bill_no}` });
      journalLines.push({ accountId: reverseChargeTaxAccountId, debit: "0.00", credit: reverseChargeAmount, description: `Reverse charge tax credit for ${bill.bill_no}` });
    }
    const withholdingPayableUnits = moneyUnits(exactTaxSummary.withholdingPayable || "0");
    if (withholdingPayableUnits > 0n) {
      const withholdingPayableAccountId = settings.withholding_tax_payable_account_id || null;
      if (!withholdingPayableAccountId) {
        throw new AppError(409, 'Withholding tax payable account is not configured (tax_settings.withholding_tax_payable_account_id)');
      }
      journalLines.push({ accountId: withholdingPayableAccountId, debit: "0.00", credit: moneyStringFromUnits(withholdingPayableUnits), description: `Withholding tax payable for ${bill.bill_no}` });
    }

    const computedPayableUnits = journalLines.reduce(
      (sum, line) => sum + moneyUnits(line.debit || "0") - moneyUnits(line.credit || "0"),
      0n
    );
    if (computedPayableUnits <= 0n) {
      throw new AppError(400, `Computed payable is invalid for ${bill.bill_no}`);
    }
    journalLines.push({ accountId: apAccountId, debit: "0.00", credit: moneyStringFromUnits(computedPayableUnits), description: `A/P for ${bill.bill_no}` });

    const idempotencyKey = `bill:${billId}:issue`;

    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      source: { type: 'bill', id: billId, action: 'issue', reference: bill.bill_no, module: 'payables' },
      payload: {
        periodId: period.id,
        entryDate: bill.bill_date,
        typeCode: "GENERAL",
        memo: `Bill ${bill.bill_no}` + (bill.memo ? `: ${bill.memo}` : ""),
        idempotencyKey,
        lines: journalLines
      }
    });

    await propagateDocumentWorkflowToJournal({
      client,
      journalId: draft.journalId,
      source: {
        orgId,
        workflowDocumentId: bill.workflow_document_id || null,
        createdBy: bill.created_by || actorUserId,
        submittedAt: bill.submitted_at || null,
        submittedBy: bill.submitted_by || null,
        approvedAt: bill.approved_at || null,
        approvedBy: bill.approved_by || null,
        updatedBy: actorUserId
      }
    });

    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client, source: { type: 'bill', id: billId, action: 'issue', reference: bill.bill_no, module: 'payables' } });

    await upsertDocumentTaxSnapshot({
      client,
      orgId,
      sourceType: "bill",
      sourceId: billId,
      journalEntryId: posted.journalId,
      snapshot: {
        header: bill,
        lines: postingLines,
        taxSummary,
        journalLines
      }
    });

    const { rows } = await client.query(
      `
      UPDATE bills
      SET status='issued',
          period_id=$3,
          journal_entry_id=$4,
          issued_at=NOW(),
          issued_by=$5,
          updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
      `,
      [orgId, billId, period.id, posted.journalId, actorUserId]
    );

    const issuedBill = rows[0];
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "bill.issued",
      entityType: "bills",
      entityId: billId,
      after: issuedBill,
      client
    });

    return issuedBill;
  });
}

async function submitBillForApproval({ orgId, actorUserId, billId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, billId]);
    if (!rows.length) throw new AppError(404, "Bill not found");
    const bill = rows[0];
    if (!['draft','rejected'].includes(bill.status)) throw new AppError(409, "Only draft or rejected bills can be submitted");

    const lines = await repo.getBillLines(billId);

    await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: 'bill',
      entity: bill,
      workflowDocumentId: bill.workflow_document_id,
      snapshot: {
        header: bill,
        lines,
        totals: { subtotal: bill.subtotal, tax_total: bill.tax_total, total: bill.total },
        meta: { status: bill.status, currency_code: bill.currency_code }
      },
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(`UPDATE bills SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, billId, workflowDocumentId]);
      }
    });

    const { rows: updated } = await client.query(
      `UPDATE bills SET status='submitted', submitted_at=NOW(), submitted_by=$3, approved_at=NULL, approved_by=NULL, rejected_at=NULL, rejected_by=NULL, rejection_reason=NULL, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, billId, actorUserId]
    );
    return updated[0];
  });
}

async function approveBillWorkflow({ orgId, actorUserId, billId, comment }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id, workflow_document_id, created_by FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, billId]);
    if (!rows.length) throw new AppError(404, 'Bill not found');
    const bill = rows[0];
    if (!bill.workflow_document_id) throw new AppError(409, 'Bill has no workflow document');

    const result = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: 'bill',
      workflowDocumentId: bill.workflow_document_id,
      creatorUserId: bill.created_by || null,
      comment: comment || null,
      client
    });

    if (result?.next) {
      const { rows: updated } = await client.query(`UPDATE bills SET status='submitted', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, billId]);
      return updated[0];
    }

    const { rows: updated } = await client.query(`UPDATE bills SET status='approved', approved_at=NOW(), approved_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, billId, actorUserId]);
    return updated[0];
  });
}

async function rejectBillWorkflow({ orgId, actorUserId, billId, comment }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id, workflow_document_id, created_by FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, billId]);
    if (!rows.length) throw new AppError(404, 'Bill not found');
    const bill = rows[0];
    if (!bill.workflow_document_id) throw new AppError(409, 'Bill has no workflow document');

    await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: 'bill',
      workflowDocumentId: bill.workflow_document_id,
      creatorUserId: bill.created_by || null,
      comment: comment || null,
      client
    });

    const { rows: updated } = await client.query(`UPDATE bills SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, billId, actorUserId, comment || null]);
    return updated[0];
  });
}

async function voidBill({ orgId, actorUserId, billId, reason }) {
  return withTransaction(async (client) => {
    const { rows: billRows } = await client.query(
      `SELECT * FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, billId]
    );
    if (!billRows.length) throw new AppError(404, "Bill not found");

    const bill = billRows[0];
    if (bill.status !== "issued") throw new AppError(409, "Only issued bills can be voided");
    if (!bill.journal_entry_id) throw new AppError(500, "Bill missing journal reference");

    const { rows: settlementRows } = await client.query(
      `SELECT 1
         FROM vendor_payment_allocations a
         JOIN vendor_payments p ON p.id=a.vendor_payment_id
        WHERE a.bill_id=$1 AND p.organization_id=$2 AND p.status='posted'
        LIMIT 1`,
      [billId, orgId]
    );
    if (settlementRows.length) {
      throw new AppError(409, "Cannot void a bill with posted vendor payments; void the payments first");
    }

    const { rows: appliedDebitRows } = await client.query(
      `SELECT 1
         FROM debit_note_applications a
         JOIN debit_notes dn ON dn.id=a.debit_note_id
        WHERE a.organization_id=$1 AND a.bill_id=$2 AND dn.status='issued'
        LIMIT 1`,
      [orgId, billId]
    );
    if (appliedDebitRows.length) {
      throw new AppError(409, "Cannot void a bill with applied debit notes; reverse or unapply the debit notes first");
    }

    const { rows: postedWriteoffRows } = await client.query(
      `SELECT 1 FROM writeoffs
        WHERE organization_id=$1 AND entity_type='bill' AND entity_id=$2 AND status='posted'
        LIMIT 1`,
      [orgId, billId]
    );
    if (postedWriteoffRows.length) {
      throw new AppError(409, "Cannot void a bill with a posted write-off; reverse the write-off first");
    }

    await assertSourceNotInFinalizedTaxReturn({
      client, orgId, sourceType: "bill", sourceId: billId
    });

    const out = await journalIF.voidPostedJournal({
      orgId,
      journalId: bill.journal_entry_id,
      actorUserId,
      reason,
      client
    });

    const { rows } = await client.query(
      `
      UPDATE bills
      SET status='voided',
          voided_at=NOW(),
          voided_by=$3,
          void_reason=$4,
          reversal_journal_entry_id=$5,
          updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
      `,
      [orgId, billId, actorUserId, reason, out.reversalJournalId || null]
    );

    const result = { bill: rows[0], reversalJournalId: out.reversalJournalId };
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "bill.voided",
      entityType: "bills",
      entityId: billId,
      after: result,
      client
    });

    return result;
  });
}

module.exports = {
  previewBillTaxes,
  createDraftBill,
  updateDraftBill,
  getBillDetails,
  listBills,
  issueBill,
  submitBillForApproval,
  approveBillWorkflow,
  rejectBillWorkflow,
  voidBill
};
