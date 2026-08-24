const { pool } = require("../../../../db/pool");
const { AppError } = require("../../../../shared/errors/AppError");
const { propagateDocumentWorkflowToJournal } = require("../../_shared/workflowJournalAudit.service");

const periodIF = require("../../../../interfaces/periodManagement.interface");
const journalIF = require("../../../../interfaces/journalPosting.interface");
const partnerIF = require("../../../../interfaces/partnerManagement.interface");
const paymentIF = require("../../../../interfaces/paymentConfig.interface");
const documentableSvc = require("../../../../workflow/documents/documentable.service");

const {
  parseDecimalToBigInt,
  bigIntToDecimalString
} = require("../../../../shared/utils/money");
const {
  moneyUnits,
  moneyStringFromUnits,
  normalizeMoney,
  addMoney,
  applyFractionToMoneyUnits,
  minUnits,
  moneyNumber,
} = require("../../../../shared/utils/financialMath");

const repo = require("./customerReceipts.repository");
const { buildDetailMeta, round2 } = require("../../_shared/detailEnrichment");
const { writeAudit } = require("../../../../core/foundation/audit-logs/audit.service");
const { resolvePaymentAccount } = require("../../_shared/paymentAccount.service");

async function getOrgBaseCurrency(client, orgId) {
  const { rows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, "Invalid organization");
  return rows[0].base_currency_code;
}

async function assertPostableActiveAccount({ orgId, accountId, errMsg, client = null }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, errMsg || "Invalid account");
  if (!rows[0].is_postable) throw new AppError(400, "Non-postable account used");
  if (rows[0].status !== "active") throw new AppError(400, "Inactive account used");
}

async function getPaymentTerm({ orgId, paymentTermsId, client = null }) {
  if (!paymentTermsId) return null;
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT * FROM payment_terms WHERE organization_id=$1 AND id=$2`,
    [orgId, paymentTermsId]
  );
  return rows[0] || null;
}

async function getInvoice(orgId, invoiceId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`,
    [orgId, invoiceId]
  );
  return rows[0] || null;
}

async function getInvoiceOutstanding(orgId, invoiceId, client = null) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT outstanding FROM reporting_ar_open_items WHERE organization_id=$1 AND invoice_id=$2`,
    [orgId, invoiceId]
  );
  if (!rows.length) return null;
  return normalizeMoney(rows[0].outstanding || "0");
}

function computeEarlyPaymentDiscount({ outstanding, cashApplied, term, receiptDate, invoiceDate }) {
  if (!term || term.discount_days == null || term.discount_rate == null) return "0.00";

  const outstandingCents = moneyUnits(outstanding);
  const cashAppliedCents = moneyUnits(cashApplied);
  const maxDiscountCents = applyFractionToMoneyUnits(outstandingCents, term.discount_rate || "0");
  if (maxDiscountCents <= 0n) return "0.00";

  // Eligible if receipt_date <= invoice_date + discount_days. Day counts are not money.
  const inv = new Date(invoiceDate);
  const due = new Date(inv);
  due.setDate(due.getDate() + Number(term.discount_days));
  const rdt = new Date(receiptDate);
  if (rdt.getTime() > due.getTime()) return "0.00";

  const requiredCashCents = outstandingCents - maxDiscountCents;
  if (cashAppliedCents < requiredCashCents) return "0.00";

  const rawDiscountCents = outstandingCents - cashAppliedCents;
  if (rawDiscountCents <= 0n) return "0.00";
  return moneyStringFromUnits(minUnits(maxDiscountCents, rawDiscountCents));
}

async function createDraftCustomerReceipt({ orgId, actorUserId, payload }) {
  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: payload.customerId });
  if (!customer.default_receivable_account_id) {
    throw new AppError(400, "Customer missing defaultReceivableAccountId");
  }

  const allocations = Array.isArray(payload.allocations) ? payload.allocations : [];

  // Validate allocations (optional at draft): invoices must be issued/paid, same customer, and not exceed outstanding
  let sumAllocCents = 0n;

  for (const a of allocations) {
    const inv = await getInvoice(orgId, a.invoiceId);
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
  if (sumAllocCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds receipt amountTotal");

  const amountTotal = bigIntToDecimalString(amountTotalCents, 2);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { accountId: paymentAccountId } = await resolvePaymentAccount({
      orgId, paymentMethodId: payload.paymentMethodId, cashAccountId: payload.cashAccountId, client
    });
    const baseCurrency = await getOrgBaseCurrency(client, orgId);
    const receiptNo = await repo.nextReceiptNo(client, orgId);

    const cr = await repo.insertCustomerReceipt(client, {
      orgId,
      customerId: payload.customerId,
      receiptNo,
      receiptDate: payload.receiptDate,
      paymentMethodId: payload.paymentMethodId,
      cashAccountId: paymentAccountId,
      amountTotal,
      currencyCode: baseCurrency,
      memo: payload.memo
    });

    for (const a of allocations) {
      await repo.upsertAllocation(client, {
        customerReceiptId: cr.id,
        invoiceId: a.invoiceId,
        amountApplied: bigIntToDecimalString(parseDecimalToBigInt(a.amountApplied, 2), 2),
        discountTaken: "0.00"
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

async function updateDraftCustomerReceipt({ orgId, actorUserId, id, payload }) {
  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: payload.customerId });
  if (!customer.default_receivable_account_id) throw new AppError(400, "Customer missing defaultReceivableAccountId");

  return require("../../../../db/tx").withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM customer_receipts WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Customer receipt not found");
    const before = rows[0];
    if (before.status !== 'draft') throw new AppError(409, "Only draft customer receipts can be edited");
    const { accountId: paymentAccountId } = await resolvePaymentAccount({
      orgId, paymentMethodId: payload.paymentMethodId, cashAccountId: payload.cashAccountId, client
    });

    const allocations = Array.isArray(payload.allocations) ? payload.allocations : [];
    let sumAllocCents = 0n;
    for (const a of allocations) {
      const inv = await getInvoice(orgId, a.invoiceId, client);
      if (!inv) throw new AppError(400, `Invalid invoiceId: ${a.invoiceId}`);
      if (inv.customer_id !== payload.customerId) throw new AppError(400, "Allocation invoice customer mismatch");
      if (!['issued','paid'].includes(inv.status)) throw new AppError(409, "Can only allocate to issued/paid invoices");
      const outstanding = await getInvoiceOutstanding(orgId, a.invoiceId, client);
      if (outstanding === null) throw new AppError(400, `Invalid invoiceId: ${a.invoiceId}`);
      const appliedCents = parseDecimalToBigInt(a.amountApplied, 2);
      if (appliedCents > parseDecimalToBigInt(outstanding, 2)) throw new AppError(409, "Allocation exceeds invoice outstanding");
      sumAllocCents += appliedCents;
    }
    const amountTotalCents = parseDecimalToBigInt(payload.amountTotal, 2);
    if (sumAllocCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds receipt amountTotal");
    const amountTotal = bigIntToDecimalString(amountTotalCents, 2);

    const { rows: updatedRows } = await client.query(
      `UPDATE customer_receipts
          SET customer_id=$3, receipt_date=$4, payment_method_id=$5, cash_account_id=$6,
              amount_total=$7, memo=$8, unapplied_amount=0, discount_total=0, settlement_total=0, updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, id, payload.customerId, payload.receiptDate, payload.paymentMethodId || null, paymentAccountId, amountTotal, payload.memo || null]
    );
    await repo.deleteAllocations(client, id);
    for (const a of allocations) {
      await repo.upsertAllocation(client, {
        customerReceiptId: id, invoiceId: a.invoiceId,
        amountApplied: bigIntToDecimalString(parseDecimalToBigInt(a.amountApplied, 2), 2), discountTaken: '0.00'
      });
    }
    await writeAudit({ organizationId: orgId, actorUserId, action: 'customer_receipt.draft_updated', entityType: 'customer_receipts', entityId: id, before, after: updatedRows[0], client });
    return updatedRows[0];
  });
}

async function getCustomerReceiptDetails({ orgId, id, currentUserId }) {
  const cr = await repo.getCustomerReceiptById(orgId, id, currentUserId);
  if (!cr) throw new AppError(404, "Customer receipt not found");
  const allocations = await repo.getAllocations(id);
  const invoiceIds = allocations.map((a) => a.invoice_id).filter(Boolean);
  let invoiceMap = new Map();
  if (invoiceIds.length) {
    const { rows } = await pool.query(
      `SELECT id, invoice_no, invoice_date, due_date, total, status, currency_code FROM invoices WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
      [orgId, invoiceIds]
    );
    invoiceMap = new Map(rows.map((row) => [row.id, row]));
  }
  const enrichedAllocations = allocations.map((allocation) => {
    const invoice = invoiceMap.get(allocation.invoice_id) || null;
    return {
      ...allocation,
      invoice,
      display_amounts: {
        amount_applied: round2(allocation.amount_applied || 0),
        discount_taken: round2(allocation.discount_taken || 0),
        settled_total: moneyNumber(addMoney(allocation.amount_applied || "0", allocation.discount_taken || "0")),
      }
    };
  });
  return {
    customerReceipt: cr,
    allocations: enrichedAllocations,
    detail_meta: buildDetailMeta({ header: cr, lines: [], extra: { outstanding: cr.unapplied_amount ?? 0 } }),
    allocation_summary: {
      allocation_count: enrichedAllocations.length,
      applied_total: moneyNumber(moneyStringFromUnits(enrichedAllocations.reduce((sum, item) => sum + moneyUnits(item.amount_applied || "0"), 0n))),
      discount_total: moneyNumber(moneyStringFromUnits(enrichedAllocations.reduce((sum, item) => sum + moneyUnits(item.discount_taken || "0"), 0n))),
      unapplied_amount: round2(cr.unapplied_amount || 0),
    }
  };
}

async function listCustomerReceipts({ orgId, query }) {
  return repo.listCustomerReceipts({ orgId, query });
}

async function autoAllocateCustomerReceipt({ orgId, actorUserId, id, rule }) {
  const { customerReceipt: cr, allocations: current } = await getCustomerReceiptDetails({ orgId, id, currentUserId: actorUserId });
  if (cr.status !== "draft") throw new AppError(409, "Only draft customer receipts can be auto-allocated");

  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: cr.customer_id });
  const term = await getPaymentTerm({ orgId, paymentTermsId: customer.payment_terms_id });

  const { rows } = await pool.query(
    `
    SELECT o.invoice_id, o.outstanding, i.invoice_date, i.due_date
    FROM reporting_ar_open_items o
    JOIN invoices i ON i.id = o.invoice_id
    WHERE o.organization_id=$1
      AND o.customer_id=$2
      AND o.outstanding > 0
      AND i.status IN ('issued','paid')
    ORDER BY ${rule === 'fifo' ? 'i.invoice_date' : 'i.due_date'} ASC, i.invoice_date ASC
    `,
    [orgId, cr.customer_id]
  );

  let remainingCents = moneyUnits(cr.amount_total || "0");
  const proposed = [];

  for (const r of rows) {
    if (remainingCents <= 0n) break;
    const outstandingCents = moneyUnits(r.outstanding || "0");
    if (outstandingCents <= 0n) continue;

    if (term && term.discount_days != null && term.discount_rate != null) {
      const maxDiscountCents = applyFractionToMoneyUnits(outstandingCents, term.discount_rate || "0");
      const requiredCashCents = outstandingCents - maxDiscountCents;
      const discount = computeEarlyPaymentDiscount({
        outstanding: moneyStringFromUnits(outstandingCents),
        cashApplied: moneyStringFromUnits(requiredCashCents),
        term,
        receiptDate: cr.receipt_date,
        invoiceDate: r.invoice_date
      });
      if (moneyUnits(discount) > 0n && remainingCents >= requiredCashCents) {
        proposed.push({ invoiceId: r.invoice_id, amountApplied: moneyStringFromUnits(requiredCashCents), discountTaken: discount });
        remainingCents -= requiredCashCents;
        continue;
      }
    }

    const cashCents = minUnits(remainingCents, outstandingCents);
    proposed.push({ invoiceId: r.invoice_id, amountApplied: moneyStringFromUnits(cashCents), discountTaken: "0.00" });
    remainingCents -= cashCents;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await repo.recordAllocationEvent(client, {
      orgId,
      customerReceiptId: id,
      actorUserId,
      action: "auto_allocate",
      before: JSON.stringify(current),
      after: JSON.stringify(proposed)
    });

    await repo.deleteAllocations(client, id);
    for (const a of proposed) {
      await repo.upsertAllocation(client, {
        customerReceiptId: id,
        invoiceId: a.invoiceId,
        amountApplied: bigIntToDecimalString(parseDecimalToBigInt(a.amountApplied, 2), 2),
        discountTaken: bigIntToDecimalString(parseDecimalToBigInt(a.discountTaken, 2), 2)
      });
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return getCustomerReceiptDetails({ orgId, id, currentUserId: actorUserId   });
}

async function reallocateCustomerReceipt({ orgId, actorUserId, id, allocations }) {
  const { customerReceipt: cr, allocations: before } = await getCustomerReceiptDetails({ orgId, id, currentUserId: actorUserId });

  const isPosted = cr.status === "posted";
  if (cr.status !== "draft" && cr.status !== "posted") {
    throw new AppError(409, "Only draft/posted customer receipts can be reallocated");
  }

  if (isPosted) {
    // Hard control: require special permission on route-level.
    // Additional control: do not allow changing totals (cash/discount/unapplied) for posted documents.
    // We enforce this by requiring the resulting cash allocation sum equals (amount_total - unapplied_amount).
    const expectedCashCents = moneyUnits(cr.amount_total || "0") - moneyUnits(cr.unapplied_amount || "0");
    const sumCashCents = (allocations || []).reduce((sum, allocation) => sum + moneyUnits(allocation.amountApplied || "0"), 0n);
    if (sumCashCents !== expectedCashCents) {
      throw new AppError(409, "Posted receipt reallocation must preserve applied cash amount");
    }
  }

  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: cr.customer_id });
  const term = await getPaymentTerm({ orgId, paymentTermsId: customer.payment_terms_id });

  // Validate and compute discounts
  const proposed = [];
  let sumCashCents = 0n;
  for (const a of allocations || []) {
    const inv = await getInvoice(orgId, a.invoiceId);
    if (!inv) throw new AppError(400, `Invalid invoiceId: ${a.invoiceId}`);
    if (inv.customer_id !== cr.customer_id) throw new AppError(400, "Allocation invoice customer mismatch");
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid invoices");

    const outstanding = await getInvoiceOutstanding(orgId, a.invoiceId);
    const cashAppliedCents = moneyUnits(a.amountApplied || "0");
    if (outstanding === null) throw new AppError(400, `Invalid invoiceId: ${a.invoiceId}`);
    if (cashAppliedCents <= 0n) throw new AppError(400, "Allocation amountApplied must be > 0");
    if (cashAppliedCents > moneyUnits(outstanding)) throw new AppError(409, "Allocation exceeds invoice outstanding");
    const cashApplied = moneyStringFromUnits(cashAppliedCents);

    const discount = computeEarlyPaymentDiscount({
      outstanding,
      cashApplied,
      term,
      receiptDate: cr.receipt_date,
      invoiceDate: inv.invoice_date
    });

    const settlementCents = cashAppliedCents + moneyUnits(discount);
    if (settlementCents > moneyUnits(outstanding)) {
      throw new AppError(409, "Allocation (cash+discount) exceeds invoice outstanding");
    }

    proposed.push({ invoiceId: a.invoiceId, amountApplied: cashApplied, discountTaken: discount });
    sumCashCents += cashAppliedCents;
  }

  const amountTotalCents = parseDecimalToBigInt(cr.amount_total, 2);
  if (sumCashCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds receipt amountTotal");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await repo.recordAllocationEvent(client, {
      orgId,
      customerReceiptId: id,
      actorUserId,
      action: "reallocate",
      before: JSON.stringify(before),
      after: JSON.stringify(proposed)
    });

    await repo.deleteAllocations(client, id);
    for (const a of proposed) {
      await repo.upsertAllocation(client, {
        customerReceiptId: id,
        invoiceId: a.invoiceId,
        amountApplied: bigIntToDecimalString(parseDecimalToBigInt(a.amountApplied, 2), 2),
        discountTaken: bigIntToDecimalString(parseDecimalToBigInt(a.discountTaken, 2), 2)
      });
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return getCustomerReceiptDetails({ orgId, id, currentUserId: actorUserId });
}



async function assertCustomerReceiptApprovalStateAllowsPost({ orgId, customerReceipt, client = null }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "payment_in",
    workflowDocumentId: customerReceipt.workflow_document_id,
    client,
    actionLabel: "post"
  });
}

async function submitCustomerReceiptForApproval({ orgId, actorUserId, id }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM customer_receipts WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Customer receipt not found");
    const cr = rows[0];
    const allocations = await repo.getAllocations(id);

    const doc = await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "payment_in",
      entity: cr,
      workflowDocumentId: cr.workflow_document_id,
      snapshot: {
        header: cr,
        allocations,
        totals: {
          amount_total: cr.amount_total,
          unapplied_amount: cr.unapplied_amount || null,
          settlement_amount: cr.settlement_amount || null,
          discount_amount: cr.discount_amount || null,
        },
        meta: {
          status: cr.status,
          journal_entry_id: cr.journal_entry_id || null,
          period_id: cr.period_id || null,
        }
      },
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(`UPDATE customer_receipts SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, workflowDocumentId]);
      }
    });

    await client.query(`UPDATE customer_receipts SET status='submitted', submitted_at=NOW(), submitted_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, actorUserId]);
    await client.query("COMMIT");
    return doc;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function approveCustomerReceiptWorkflow({ orgId, actorUserId, id, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM customer_receipts WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Customer receipt not found");
    const cr = rows[0];
    if (!cr.workflow_document_id) throw new AppError(409, "Customer receipt has no workflow document");

    const approved = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "payment_in",
      workflowDocumentId: cr.workflow_document_id,
      creatorUserId: cr.created_by || null,
      comment,
      client
    });

    if (approved?.next) {
      await client.query(`UPDATE customer_receipts SET status='submitted', updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id]);
    } else {
      await client.query(`UPDATE customer_receipts SET status='approved', approved_at=NOW(), approved_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, actorUserId]);
    }
    await client.query("COMMIT");
    return approved;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function rejectCustomerReceiptWorkflow({ orgId, actorUserId, id, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM customer_receipts WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Customer receipt not found");
    const cr = rows[0];
    if (!cr.workflow_document_id) throw new AppError(409, "Customer receipt has no workflow document");

    const rejected = await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "payment_in",
      workflowDocumentId: cr.workflow_document_id,
      creatorUserId: cr.created_by || null,
      comment,
      client
    });

    await client.query(`UPDATE customer_receipts SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, actorUserId, comment || null]);
    await client.query("COMMIT");
    return rejected;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function postCustomerReceipt({ orgId, actorUserId, id }) {
  const { withTransaction } = require("../../../../db/tx");
  return withTransaction(async (client) => {
    const { rows: crRows } = await client.query(
      `SELECT * FROM customer_receipts WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, id]
    );
    if (!crRows.length) throw new AppError(404, "Customer receipt not found");
    const cr = crRows[0];
    if (!["draft", "approved"].includes(cr.status)) throw new AppError(409, "Only draft/approved customer receipts can be posted");

    await assertCustomerReceiptApprovalStateAllowsPost({ orgId, customerReceipt: cr, client });
    const { rows: allocations } = await client.query(
      `SELECT * FROM customer_receipt_allocations WHERE customer_receipt_id=$1 ORDER BY created_at ASC`,
      [id]
    );

    const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: cr.customer_id, client });
    if (!customer.default_receivable_account_id) throw new AppError(400, "Customer missing defaultReceivableAccountId");
    await assertPostableActiveAccount({ orgId, accountId: cr.cash_account_id, errMsg: "Invalid cashAccountId", client });

    const term = await getPaymentTerm({ orgId, paymentTermsId: customer.payment_terms_id, client });
    const settings = await paymentIF.getPaymentSettings({ orgId, client });
    let cashAppliedCents = 0n;
    let discountCents = 0n;
    let settlementCents = 0n;

    for (const a of allocations) {
      const inv = await getInvoice(orgId, a.invoice_id, client);
      if (!inv) throw new AppError(400, `Invalid invoiceId: ${a.invoice_id}`);
      if (inv.customer_id !== cr.customer_id) throw new AppError(400, "Allocation invoice customer mismatch");
      if (!["issued", "paid"].includes(inv.status)) throw new AppError(409, "Can only allocate to issued/paid invoices");

      const outstanding = await getInvoiceOutstanding(orgId, a.invoice_id, client);
      if (outstanding === null) throw new AppError(400, `Invalid invoiceId: ${a.invoice_id}`);
      const cashCurrent = moneyUnits(a.amount_applied || "0");
      if (cashCurrent <= 0n) throw new AppError(400, "Allocation amount_applied must be > 0");
      if (cashCurrent > moneyUnits(outstanding)) throw new AppError(409, "Allocation exceeds invoice outstanding");

      const discount = computeEarlyPaymentDiscount({
        outstanding,
        cashApplied: moneyStringFromUnits(cashCurrent),
        term,
        receiptDate: cr.receipt_date,
        invoiceDate: inv.invoice_date
      });
      const settlementCurrent = cashCurrent + moneyUnits(discount);
      if (settlementCurrent > moneyUnits(outstanding)) throw new AppError(409, "Allocation (cash+discount) exceeds invoice outstanding");

      await client.query(
        `UPDATE customer_receipt_allocations SET discount_taken=$3 WHERE customer_receipt_id=$1 AND invoice_id=$2`,
        [id, a.invoice_id, discount]
      );
      cashAppliedCents += cashCurrent;
      discountCents += moneyUnits(discount);
      settlementCents += settlementCurrent;
    }

    const amountTotalCents = parseDecimalToBigInt(cr.amount_total, 2);
    if (cashAppliedCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds receipt amountTotal");
    const unappliedCents = amountTotalCents - cashAppliedCents;

    if (unappliedCents > 0n) {
      if (!settings?.ar_unapplied_account_id) throw new AppError(409, "Unapplied cash exists but payment_settings.ar_unapplied_account_id is not configured");
      await assertPostableActiveAccount({ orgId, accountId: settings.ar_unapplied_account_id, errMsg: "Invalid arUnappliedAccountId", client });
    }
    if (discountCents > 0n) {
      if (!settings?.ar_discount_account_id) throw new AppError(409, "Discount taken exists but payment_settings.ar_discount_account_id is not configured");
      await assertPostableActiveAccount({ orgId, accountId: settings.ar_discount_account_id, errMsg: "Invalid arDiscountAccountId", client });
    }

    const discountTotal = bigIntToDecimalString(discountCents, 2);
    const settlementTotal = bigIntToDecimalString(settlementCents, 2);
    const unappliedAmount = bigIntToDecimalString(unappliedCents, 2);
    const period = await periodIF.findOpenPeriodForDate({ orgId, date: cr.receipt_date, client });

    const journalLines = [
      { accountId: cr.cash_account_id, debit: bigIntToDecimalString(amountTotalCents, 2), credit: "0.00", description: `Cash/Bank receipt ${cr.receipt_no}` }
    ];
    if (discountCents > 0n) journalLines.push({ accountId: settings.ar_discount_account_id, debit: discountTotal, credit: "0.00", description: `Early payment discount ${cr.receipt_no}` });
    if (settlementCents > 0n) journalLines.push({ accountId: customer.default_receivable_account_id, debit: "0.00", credit: settlementTotal, description: `A/R settlement ${cr.receipt_no}` });
    if (unappliedCents > 0n) journalLines.push({ accountId: settings.ar_unapplied_account_id, debit: "0.00", credit: unappliedAmount, description: `Unapplied cash ${cr.receipt_no}` });

    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      source: { type: 'customer_receipt', id, action: 'post', reference: cr.receipt_no, module: 'receivables' },
      payload: {
        periodId: period.id,
        entryDate: cr.receipt_date,
        typeCode: "GENERAL",
        memo: `Customer receipt ${cr.receipt_no}` + (cr.memo ? `: ${cr.memo}` : ""),
        idempotencyKey: `customer_receipt:${id}:post`,
        lines: journalLines
      }
    });
    await propagateDocumentWorkflowToJournal({
      client,
      journalId: draft.journalId,
      source: {
        orgId,
        workflowDocumentId: cr.workflow_document_id || null,
        createdBy: cr.created_by || actorUserId,
        submittedAt: cr.submitted_at || null,
        submittedBy: cr.submitted_by || null,
        approvedAt: cr.approved_at || null,
        approvedBy: cr.approved_by || null,
        updatedBy: actorUserId
      }
    });
    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client, source: { type: 'customer_receipt', id, action: 'post', reference: cr.receipt_no, module: 'receivables' } });

    const { rows: updated } = await client.query(
      `UPDATE customer_receipts
          SET status='posted', period_id=$3, journal_entry_id=$4,
              settlement_total=$5, discount_total=$6, unapplied_amount=$7,
              posted_at=NOW(), posted_by=$8, updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, id, period.id, posted.journalId, settlementTotal, discountTotal, unappliedAmount, actorUserId]
    );

    for (const a of allocations) {
      const outstandingAfter = await getInvoiceOutstanding(orgId, a.invoice_id, client);
      if (outstandingAfter !== null && moneyUnits(outstandingAfter) <= 0n) {
        await client.query(`UPDATE invoices SET status='paid', updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status IN ('issued','paid')`, [orgId, a.invoice_id]);
      }
    }

    await writeAudit({ organizationId: orgId, actorUserId, action: "customer_receipt.posted", entityType: "customer_receipts", entityId: id, after: updated[0], client });
    return updated[0];
  });
}

async function voidCustomerReceipt({ orgId, actorUserId, id, reason }) {
  const { withTransaction } = require("../../../../db/tx");
  return withTransaction(async (client) => {
    const { rows: receiptRows } = await client.query(
      `SELECT * FROM customer_receipts WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, id]
    );
    if (!receiptRows.length) throw new AppError(404, "Customer receipt not found");
    const cr = receiptRows[0];
    if (cr.status !== "posted") throw new AppError(409, "Only posted customer receipts can be voided");
    if (!cr.journal_entry_id) throw new AppError(500, "Customer receipt missing journal reference");

    const out = await journalIF.voidPostedJournal({ orgId, journalId: cr.journal_entry_id, actorUserId, reason, client });
    const { rows } = await client.query(
      `UPDATE customer_receipts
          SET status='voided', voided_at=NOW(), voided_by=$3, void_reason=$4,
              reversal_journal_entry_id=$5, updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, id, actorUserId, reason, out.reversalJournalId]
    );

    const { rows: allocRows } = await client.query(`SELECT invoice_id FROM customer_receipt_allocations WHERE customer_receipt_id=$1`, [id]);
    for (const r of allocRows) {
      const outstanding = await getInvoiceOutstanding(orgId, r.invoice_id, client);
      if (outstanding !== null && moneyUnits(outstanding) > 0n) {
        await client.query(`UPDATE invoices SET status='issued', updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status='paid'`, [orgId, r.invoice_id]);
      }
    }
    await writeAudit({ organizationId: orgId, actorUserId, action: "customer_receipt.voided", entityType: "customer_receipts", entityId: id, after: rows[0], client });
    return rows[0];
  });
}

module.exports = {
  createDraftCustomerReceipt,
  updateDraftCustomerReceipt,
  getCustomerReceiptDetails,
  listCustomerReceipts,
  autoAllocateCustomerReceipt,
  reallocateCustomerReceipt,
  submitCustomerReceiptForApproval,
  approveCustomerReceiptWorkflow,
  rejectCustomerReceiptWorkflow,
  assertCustomerReceiptApprovalStateAllowsPost,
  postCustomerReceipt,
  voidCustomerReceipt
};
