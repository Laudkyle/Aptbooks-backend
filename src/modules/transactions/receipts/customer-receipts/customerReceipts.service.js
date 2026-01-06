const { pool } = require("../../../../db/pool");
const { AppError } = require("../../../../shared/errors/AppError");

const periodIF = require("../../../../interfaces/periodManagement.interface");
const journalIF = require("../../../../interfaces/journalPosting.interface");
const partnerIF = require("../../../../interfaces/partnerManagement.interface");

const {
  parseDecimalToBigInt,
  bigIntToDecimalString
} = require("../../../../shared/utils/money");

const repo = require("./customerReceipts.repository");

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

async function getInvoiceForAllocation(orgId, invoiceId) {
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`,
    [orgId, invoiceId]
  );
  return rows[0] || null;
}

async function getInvoiceOutstanding(orgId, invoiceId) {
  const { rows: invRows } = await pool.query(
    `SELECT total FROM invoices WHERE organization_id=$1 AND id=$2`,
    [orgId, invoiceId]
  );
  if (!invRows.length) return null;

  const total = Number(invRows[0].total);

  const { rows: paidRows } = await pool.query(
    `
    SELECT COALESCE(SUM(cra.amount_applied),0) AS paid
    FROM customer_receipt_allocations cra
    JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
    WHERE cra.invoice_id=$1
      AND cr.organization_id=$2
      AND cr.status='posted'
    `,
    [invoiceId, orgId]
  );

  const paid = Number(paidRows[0]?.paid || 0);
  return Number((total - paid).toFixed(2));
}

async function createDraftCustomerReceipt({ orgId, actorUserId, payload }) {
  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: payload.customerId });
  if (!customer.default_receivable_account_id) {
    throw new AppError(400, "Customer missing defaultReceivableAccountId");
  }

  await assertPostableActiveAccount({ orgId, accountId: payload.cashAccountId, errMsg: "Invalid cashAccountId" });

  // Validate allocations: invoices must be issued/paid, same customer, and not exceed outstanding
  let sumAllocCents = 0n;

  for (const a of payload.allocations) {
    const inv = await getInvoiceForAllocation(orgId, a.invoiceId);
    if (!inv) throw new AppError(400, `Invalid invoiceId: ${a.invoiceId}`);
    if (inv.customer_id !== payload.customerId) throw new AppError(400, "Allocation invoice customer mismatch");
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid invoices");
    if (inv.status === "voided") throw new AppError(409, "Cannot allocate to voided invoice");

    const outstanding = await getInvoiceOutstanding(orgId, a.invoiceId);
    if (outstanding === null) throw new AppError(400, `Invalid invoiceId: ${a.invoiceId}`);
    const appliedCents = parseDecimalToBigInt(a.amountApplied, 2);
    const outstandingCents = parseDecimalToBigInt(outstanding, 2);
    if (appliedCents > outstandingCents) throw new AppError(409, "Allocation exceeds invoice outstanding");

    sumAllocCents += appliedCents;
  }

  const amountTotalCents = parseDecimalToBigInt(payload.amountTotal, 2);
  if (sumAllocCents <= 0n) throw new AppError(400, "allocations must sum to > 0");
  if (sumAllocCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds receipt amountTotal");

  const amountTotal = bigIntToDecimalString(amountTotalCents, 2);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const baseCurrency = await getOrgBaseCurrency(client, orgId);
    const receiptNo = await repo.nextReceiptNo(client, orgId);

    const cr = await repo.insertCustomerReceipt(client, {
      orgId,
      customerId: payload.customerId,
      receiptNo,
      receiptDate: payload.receiptDate,
      paymentMethodId: payload.paymentMethodId,
      cashAccountId: payload.cashAccountId,
      amountTotal,
      currencyCode: baseCurrency,
      memo: payload.memo
    });

    for (const a of payload.allocations) {
      await repo.upsertAllocation(client, {
        customerReceiptId: cr.id,
        invoiceId: a.invoiceId,
        amountApplied: bigIntToDecimalString(parseDecimalToBigInt(a.amountApplied, 2), 2)
      });
    }

    await client.query("COMMIT");
    return cr;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getCustomerReceiptDetails({ orgId, id }) {
  const cr = await repo.getCustomerReceiptById(orgId, id);
  if (!cr) throw new AppError(404, "Customer receipt not found");
  const allocations = await repo.getAllocations(id);
  return { customerReceipt: cr, allocations };
}

async function listCustomerReceipts({ orgId, query }) {
  return repo.listCustomerReceipts({ orgId, query });
}

async function postCustomerReceipt({ orgId, actorUserId, id }) {
  const { customerReceipt: cr, allocations } = await getCustomerReceiptDetails({ orgId, id });
  if (cr.status !== "draft") throw new AppError(409, "Only draft customer receipts can be posted");
  if (!allocations.length) throw new AppError(400, "Customer receipt has no allocations");

  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: cr.customer_id });
  if (!customer.default_receivable_account_id) throw new AppError(400, "Customer missing defaultReceivableAccountId");

  await assertPostableActiveAccount({ orgId, accountId: cr.cash_account_id, errMsg: "Invalid cashAccountId" });

  // Re-validate allocations at post-time (race safety)
  let sumAllocCents = 0n;
  for (const a of allocations) {
    const inv = await getInvoiceForAllocation(orgId, a.invoice_id);
    if (!inv) throw new AppError(400, `Invalid invoiceId: ${a.invoice_id}`);
    if (inv.customer_id !== cr.customer_id) throw new AppError(400, "Allocation invoice customer mismatch");
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid invoices");
    if (inv.status === "voided") throw new AppError(409, "Cannot allocate to voided invoice");

    const outstanding = await getInvoiceOutstanding(orgId, a.invoice_id);
    const appliedCents = parseDecimalToBigInt(a.amount_applied, 2);
    const outstandingCents = parseDecimalToBigInt(outstanding, 2);
    if (appliedCents > outstandingCents) throw new AppError(409, "Allocation exceeds invoice outstanding");

    sumAllocCents += appliedCents;
  }

  const amountTotalCents = parseDecimalToBigInt(cr.amount_total, 2);
  if (sumAllocCents <= 0n) throw new AppError(400, "allocations must sum to > 0");
  if (sumAllocCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds receipt amountTotal");

  const sumAlloc = bigIntToDecimalString(sumAllocCents, 2);

  const period = await periodIF.findOpenPeriodForDate({ orgId, date: cr.receipt_date });

  const arAccountId = customer.default_receivable_account_id;
  const cashAccountId = cr.cash_account_id;

  const journalLines = [
    { accountId: cashAccountId, debit: sumAlloc, credit: "0.00", description: `Cash/Bank receipt ${cr.receipt_no}` },
    { accountId: arAccountId, debit: "0.00", credit: sumAlloc, description: `A/R settlement ${cr.receipt_no}` }
  ];

  const idempotencyKey = `customer_receipt:${id}:post`;

  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: period.id,
      entryDate: cr.receipt_date,
      typeCode: "GENERAL",
      memo: `Customer receipt ${cr.receipt_no}` + (cr.memo ? `: ${cr.memo}` : ""),
      idempotencyKey,
      lines: journalLines
    }
  });

  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });

  const { rows: crRows } = await pool.query(
    `
    UPDATE customer_receipts
    SET status='posted',
        period_id=$3,
        journal_entry_id=$4,
        posted_at=NOW(),
        posted_by=$5,
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, id, period.id, posted.journalId, actorUserId]
  );

  // Update invoice status to paid if fully settled
  for (const a of allocations) {
    const outstandingAfter = await getInvoiceOutstanding(orgId, a.invoice_id);
    if (outstandingAfter !== null && outstandingAfter <= 0) {
      await pool.query(
        `
        UPDATE invoices
        SET status='paid', updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 AND status IN ('issued','paid')
        `,
        [orgId, a.invoice_id]
      );
    }
  }

  return crRows[0];
}

async function voidCustomerReceipt({ orgId, actorUserId, id, reason }) {
  const cr = await repo.getCustomerReceiptById(orgId, id);
  if (!cr) throw new AppError(404, "Customer receipt not found");
  if (cr.status !== "posted") throw new AppError(409, "Only posted customer receipts can be voided");
  if (!cr.journal_entry_id) throw new AppError(500, "Customer receipt missing journal reference");

  const out = await journalIF.voidPostedJournal({
    orgId,
    journalId: cr.journal_entry_id,
    actorUserId,
    reason
  });

  const { rows } = await pool.query(
    `
    UPDATE customer_receipts
    SET status='voided',
        voided_at=NOW(),
        voided_by=$3,
        void_reason=$4,
        reversal_journal_entry_id=$5,
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, id, actorUserId, reason, out.reversalJournalId || null]
  );

  const { rows: affectedInvoices } = await pool.query(
    `SELECT invoice_id FROM customer_receipt_allocations WHERE customer_receipt_id=$1`,
    [id]
  );

  for (const r of affectedInvoices) {
    const outstanding = await getInvoiceOutstanding(orgId, r.invoice_id);
    if (outstanding !== null && outstanding > 0) {
      await pool.query(
        `
        UPDATE invoices
        SET status='issued', updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 AND status IN ('paid','issued')
        `,
        [orgId, r.invoice_id]
      );
    }
  }

  return { customerReceipt: rows[0], reversalJournalId: out.reversalJournalId };
}

module.exports = {
  createDraftCustomerReceipt,
  getCustomerReceiptDetails,
  listCustomerReceipts,
  postCustomerReceipt,
  voidCustomerReceipt
};
