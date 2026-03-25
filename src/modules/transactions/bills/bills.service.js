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
  bigIntToDecimalString
} = require("../../../shared/utils/money");

const repo = require("./bills.repository");
const { resolveLineTaxes, round2, loadLineTaxDetails, upsertDocumentTaxSnapshot } = require("../../../shared/tax/multiTax");
const { summarizeLineTaxDetails } = require("../../../shared/tax/posting");

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
  let taxTotal = 0;
  const computed = [];

  for (const l of lines) {
    const qty = l.quantity ?? 1;
    const unitPrice = l.unitPrice ?? 0;
    const lineCents = multiplyQtyByUnitPriceToMoney(qty, unitPrice, 4, 2);
    subtotalCents += lineCents;
    const taxableAmount = Number(bigIntToDecimalString(lineCents, 2));
    const tax = await resolveLineTaxes({
      client,
      orgId,
      line: l,
      defaultTaxableAmount: taxableAmount,
      context: {
        partnerId: payload.vendorId,
        partnerType: "vendor",
        transactionScope: "purchases",
        documentType: "bill",
        documentDate: payload.billDate,
        jurisdictionId: payload.jurisdictionId || null,
        placeOfSupply: payload.placeOfSupply || null
      }
    });
    taxTotal += Number(tax.taxAmount || 0);
    computed.push({
      ...l,
      quantity: qty,
      unitPrice,
      lineTotal: bigIntToDecimalString(lineCents, 2),
      taxableAmount,
      taxAmount: round2(tax.taxAmount),
      taxCodeId: tax.selectedTaxCodeId || null,
      taxDetails: tax.components,
      taxSnapshot: tax.snapshot
    });
  }

  const subtotal = bigIntToDecimalString(subtotalCents, 2);
  return { computed, subtotal, taxTotal: round2(taxTotal).toFixed(2), total: (Number(subtotal) + round2(taxTotal)).toFixed(2) };
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

    const { computed, subtotal, taxTotal, total } = await prepareBillLines({ client, orgId, payload, lines: payload.lines });
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
      currencyCode: baseCurrency
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

async function getBillDetails({ orgId, billId, currentUserId }) {
  const bill = await repo.getBillById(orgId, billId, currentUserId);
  if (!bill) throw new AppError(404, "Bill not found");

  const lines = await repo.getBillLines(billId);
  const taxMap = await loadLineTaxDetails({ client: pool, tableName: 'bill_line_tax_details', lineIds: lines.map((l) => l.id) });

  const { rows: paidRows } = await pool.query(
    `
    SELECT COALESCE(SUM(vpa.amount_applied),0) AS paid
    FROM vendor_payment_allocations vpa
    JOIN vendor_payments vp ON vp.id = vpa.vendor_payment_id
    WHERE vpa.bill_id=$1
      AND vp.organization_id=$2
      AND vp.status='posted'
    `,
    [billId, orgId]
  );

  const paid = Number(paidRows[0]?.paid || 0);
  const total = Number(bill.total);
  const outstanding = Number((total - paid).toFixed(2));

  return { bill, lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })), paid, outstanding };
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
    if (bill.status !== "draft") throw new AppError(409, "Only draft bills can be issued");

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
    const expenseMap = new Map();
    for (const l of postingLines) {
      await assertPostableActiveAccount({ orgId, accountId: l.expense_account_id, errMsg: "Invalid expenseAccountId" });
      const taxBuckets = taxSummary.byLineId.get(l.id) || { nonRecoverable: 0 };
      const expenseAmount = Number((Number((l.taxable_amount ?? l.line_total ?? 0)) + Number(taxBuckets.nonRecoverable || 0)).toFixed(2));
      expenseMap.set(l.expense_account_id, (expenseMap.get(l.expense_account_id) || 0) + expenseAmount);
    }

    const apAccountId = vendor.default_payable_account_id;
    const total = Number(bill.total);
    const { rows: taxSettingsRows } = await client.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
    const settings = taxSettingsRows[0] || {};
    const inputTaxAccountId = settings.input_tax_account_id || null;
    const reverseChargeTaxAccountId = settings.reverse_charge_tax_account_id || inputTaxAccountId || null;
    const netPayable = Number((total - taxSummary.withholdingPayable).toFixed(2));

    const journalLines = [];
    for (const [accountId, amt] of expenseMap.entries()) {
      journalLines.push({ accountId, debit: Number(amt.toFixed(2)), credit: 0, description: `Expense for ${bill.bill_no}` });
    }
    if (taxSummary.recoverableInputTax > 0) {
      if (!inputTaxAccountId) throw new AppError(409, 'Input tax account is not configured (tax_settings.input_tax_account_id)');
      journalLines.push({ accountId: inputTaxAccountId, debit: taxSummary.recoverableInputTax, credit: 0, description: `Recoverable input tax for ${bill.bill_no}` });
    }
    if (taxSummary.reverseChargeTax > 0 && reverseChargeTaxAccountId) {
      journalLines.push({ accountId: reverseChargeTaxAccountId, debit: taxSummary.reverseChargeTax, credit: taxSummary.reverseChargeTax, description: `Reverse charge tax memo for ${bill.bill_no}` });
    }
    if (taxSummary.withholdingPayable > 0) {
      const withholdingPayableAccountId = settings.withholding_tax_payable_account_id || null;
      if (withholdingPayableAccountId) {
        journalLines.push({ accountId: withholdingPayableAccountId, debit: 0, credit: taxSummary.withholdingPayable, description: `Withholding tax payable for ${bill.bill_no}` });
      }
    }
    journalLines.push({ accountId: apAccountId, debit: 0, credit: netPayable, description: `A/P for ${bill.bill_no}` });

    const idempotencyKey = `bill:${billId}:issue`;

    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: bill.bill_date,
        typeCode: "GENERAL",
        memo: `Bill ${bill.bill_no}` + (bill.memo ? `: ${bill.memo}` : ""),
        idempotencyKey,
        lines: journalLines
      }
    });

    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });

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

    return rows[0];
  });
}

async function submitBillForApproval({ orgId, actorUserId, billId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, billId]);
    if (!rows.length) throw new AppError(404, "Bill not found");
    const bill = rows[0];
    if (bill.status !== "draft") throw new AppError(409, "Only draft bills can be submitted");

    const doc = await documentsSvc.createDraftDocument({
      orgId,
      actorUserId,
      client,
      payload: {
        entityType: "bill",
        entityId: bill.id,
        title: `Bill ${bill.bill_no}`,
        amount: bill.total,
        documentDate: bill.bill_date,
        memo: bill.memo || null
      }
    });

    const { rows: updated } = await client.query(
      `UPDATE bills SET workflow_document_id=$3, workflow_status='pending_approval', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, billId, doc.id]
    );
    return updated[0];
  });
}

module.exports = {
  createDraftBill,
  getBillDetails,
  listBills,
  issueBill,
  submitBillForApproval
};
