const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

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

async function getOrgBaseCurrency(client, orgId) {
  const { rows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, "Invalid organization");
  return rows[0].base_currency_code;
}

const repo = require("./bills.repository");

async function assertPostableActiveAccount({ orgId, accountId, errMsg }) {
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, errMsg || "Invalid account");
  if (!rows[0].is_postable) throw new AppError(400, "Non-postable account used");
  if (rows[0].status !== "active") throw new AppError(400, "Inactive account used");
}

function calcTotals(lines) {
  let subtotalCents = 0n;

  const computed = lines.map((l) => {
    const qty = l.quantity ?? 1;
    const unitPrice = l.unitPrice ?? 0;
    const lineCents = multiplyQtyByUnitPriceToMoney(qty, unitPrice, 4, 2);
    subtotalCents += lineCents;

    return {
      ...l,
      quantity: qty,
      unitPrice,
      lineTotal: bigIntToDecimalString(lineCents, 2)
    };
  });

  const subtotal = bigIntToDecimalString(subtotalCents, 2);
  return { computed, subtotal, total: subtotal };
}

async function createDraftBill({ orgId, actorUserId, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId });
  if (vendor.type !== "vendor") throw new AppError(400, "Partner is not a vendor");
  if (vendor.status !== "active") throw new AppError(400, "Vendor is inactive");
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

  for (const l of payload.lines) {
    await assertPostableActiveAccount({ orgId, accountId: l.expenseAccountId, errMsg: "Invalid expenseAccountId" });
  }

  const { computed, subtotal, total } = calcTotals(payload.lines);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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
        expenseAccountId: l.expenseAccountId
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

async function getBillDetails({ orgId, billId }) {
  const bill = await repo.getBillById(orgId, billId);
  if (!bill) throw new AppError(404, "Bill not found");

  const lines = await repo.getBillLines(billId);

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

  return { bill, lines, paid, outstanding };
}

async function listBills({ orgId, query }) {
  return repo.listBills({ orgId, query });
}

async function issueBill({ orgId, actorUserId, billId }) {
  const { withTransaction } = require("../../../db/tx");
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

  const expenseMap = new Map();
  for (const l of lines) {
    await assertPostableActiveAccount({ orgId, accountId: l.expense_account_id, errMsg: "Invalid expenseAccountId" });
    expenseMap.set(l.expense_account_id, (expenseMap.get(l.expense_account_id) || 0) + Number(l.line_total));
  }

  const apAccountId = vendor.default_payable_account_id;
  const total = Number(bill.total);

  const journalLines = [];
  for (const [accountId, amt] of expenseMap.entries()) {
    journalLines.push({ accountId, debit: Number(amt.toFixed(2)), credit: 0, description: `Expense for ${bill.bill_no}` });
  }
  journalLines.push({ accountId: apAccountId, debit: 0, credit: total, description: `A/P for ${bill.bill_no}` });

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

// -----------------------------------------------------------------------------
// Stage 5: Bill approval workflow integration (Tier 10 Documents)
// -----------------------------------------------------------------------------

async function assertBillApprovalStateAllowsIssue({ orgId, bill, client }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "bill",
    workflowDocumentId: bill.workflow_document_id,
    client,
    actionLabel: "issue"
  });
}

async function submitBillForApproval({ orgId, actorUserId, billId }) {
  const { withTransaction } = require("../../../db/tx");
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, billId]
    );
    if (!rows.length) throw new AppError(404, "Bill not found");
    const bill = rows[0];

    const { rows: lines } = await client.query(
      `SELECT * FROM bill_lines WHERE bill_id=$1 ORDER BY line_no`,
      [billId]
    );

    return documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "bill",
      entity: bill,
      workflowDocumentId: bill.workflow_document_id,
      snapshot: {
        header: bill,
        lines,
        totals: {
          subtotal: bill.subtotal,
          total: bill.total
        },
        meta: {
          status: bill.status,
          currency_code: bill.currency_code
        }
      },
      client,
      persistWorkflowDocumentId: async (documentId) => {
        await client.query(
          `UPDATE bills SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
          [orgId, billId, documentId]
        );
      }
    });
  });
}

async function approveBillWorkflow({ orgId, actorUserId, billId, comment }) {
  const { withTransaction } = require("../../../db/tx");
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, workflow_document_id, created_by FROM bills WHERE organization_id=$1 AND id=$2`,
      [orgId, billId]
    );
    if (!rows.length) throw new AppError(404, "Bill not found");
    const bill = rows[0];
    if (!bill.workflow_document_id) throw new AppError(409, "Bill has no workflow document");

    const result = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "bill",
      workflowDocumentId: bill.workflow_document_id,
      creatorUserId: bill.created_by || null,
      comment: comment || null,
      client
    });
    return result.document;
  });
}

async function rejectBillWorkflow({ orgId, actorUserId, billId, comment }) {
  const { withTransaction } = require("../../../db/tx");
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, workflow_document_id, created_by FROM bills WHERE organization_id=$1 AND id=$2`,
      [orgId, billId]
    );
    if (!rows.length) throw new AppError(404, "Bill not found");
    const bill = rows[0];
    if (!bill.workflow_document_id) throw new AppError(409, "Bill has no workflow document");

    const result = await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "bill",
      workflowDocumentId: bill.workflow_document_id,
      creatorUserId: bill.created_by || null,
      comment: comment || null,
      client
    });
    return result.document;
  });
}

async function voidBill({ orgId, actorUserId, billId, reason }) {
  const { withTransaction } = require("../../../db/tx");
  return withTransaction(async (client) => {
    const { rows: billRows } = await client.query(
      `SELECT * FROM bills WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, billId]
    );
    if (!billRows.length) throw new AppError(404, "Bill not found");
    const bill = billRows[0];
    if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Only issued/paid bills can be voided");
    if (!bill.journal_entry_id) throw new AppError(500, "Bill missing journal reference");

    const out = await journalIF.voidPostedJournal({ orgId, journalId: bill.journal_entry_id, actorUserId, reason, client });

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

    return { bill: rows[0], reversalJournalId: out.reversalJournalId };
  });
}

module.exports = {
  createDraftBill,
  getBillDetails,
  listBills,
  submitBillForApproval,
  approveBillWorkflow,
  rejectBillWorkflow,
  issueBill,
  voidBill
};
