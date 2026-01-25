const { pool } = require("../../../../db/pool"); 
const { AppError } = require("../../../../shared/errors/AppError"); 

const periodIF = require("../../../../interfaces/periodManagement.interface"); 
const journalIF = require("../../../../interfaces/journalPosting.interface"); 
const partnerIF = require("../../../../interfaces/partnerManagement.interface"); 
const paymentIF = require("../../../../interfaces/paymentConfig.interface"); 

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

async function getPaymentTerm({ orgId, paymentTermsId }) {
  if (!paymentTermsId) return null; 
  const { rows } = await pool.query(
    `SELECT * FROM payment_terms WHERE organization_id=$1 AND id=$2`,
    [orgId, paymentTermsId]
  ); 
  return rows[0] || null; 
}

async function getInvoice(orgId, invoiceId) {
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`,
    [orgId, invoiceId]
  ); 
  return rows[0] || null; 
}

async function getInvoiceOutstanding(orgId, invoiceId) {
  const { rows } = await pool.query(
    `SELECT outstanding FROM reporting_ar_open_items WHERE organization_id=$1 AND invoice_id=$2`,
    [orgId, invoiceId]
  ); 
  if (!rows.length) return null; 
  return Number(rows[0].outstanding || 0); 
}

function computeEarlyPaymentDiscount({ outstanding, cashApplied, term, receiptDate, invoiceDate }) {
  if (!term) return 0; 
  if (term.discount_days == null || term.discount_rate == null) return 0; 
  const rate = Number(term.discount_rate || 0); 
  if (!rate || rate <= 0) return 0; 

  // Eligible if receipt_date <= invoice_date + discount_days
  const inv = new Date(invoiceDate); 
  const due = new Date(inv); 
  due.setDate(due.getDate() + Number(term.discount_days)); 
  const rdt = new Date(receiptDate); 
  if (rdt.getTime() > due.getTime()) return 0; 

  const maxDiscount = Number((outstanding * rate).toFixed(2)); 
  const requiredCash = Number((outstanding - maxDiscount).toFixed(2)); 

  if (cashApplied + 1e-9 < requiredCash) return 0; 

  // Discount is the gap between outstanding and cash, capped to maxDiscount
  const raw = Number((outstanding - cashApplied).toFixed(2)); 
  if (raw <= 0) return 0; 
  return Number(Math.min(maxDiscount, raw).toFixed(2)); 
}

async function createDraftCustomerReceipt({ orgId, actorUserId, payload }) {
  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: payload.customerId }); 
  if (!customer.default_receivable_account_id) {
    throw new AppError(400, "Customer missing defaultReceivableAccountId"); 
  }

  await assertPostableActiveAccount({ orgId, accountId: payload.cashAccountId, errMsg: "Invalid cashAccountId" }); 

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

async function getCustomerReceiptDetails({ orgId, id }) {
  const cr = await repo.getCustomerReceiptById(orgId, id); 
  if (!cr) throw new AppError(404, "Customer receipt not found"); 
  const allocations = await repo.getAllocations(id); 
  return { customerReceipt: cr, allocations }; 
}

async function listCustomerReceipts({ orgId, query }) {
  return repo.listCustomerReceipts({ orgId, query }); 
}

async function autoAllocateCustomerReceipt({ orgId, actorUserId, id, rule }) {
  const { customerReceipt: cr, allocations: current } = await getCustomerReceiptDetails({ orgId, id }); 
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

  let remaining = Number(cr.amount_total || 0); 
  const proposed = []; 

  for (const r of rows) {
    if (remaining <= 0) break; 
    const outstanding = Number(r.outstanding || 0); 
    if (outstanding <= 0) continue; 

    // Try discount settlement first (if eligible)
    const maxDiscount = computeEarlyPaymentDiscount({
      outstanding,
      cashApplied: outstanding, // placeholder;  will recompute below
      term,
      receiptDate: cr.receipt_date,
      invoiceDate: r.invoice_date
    }); 

    // Recompute using required cash if discount eligible
    let discount = 0; 
    if (term && term.discount_days != null && term.discount_rate != null) {
      const rate = Number(term.discount_rate || 0); 
      if (rate > 0) {
        const maxD = Number((outstanding * rate).toFixed(2)); 
        const requiredCash = Number((outstanding - maxD).toFixed(2)); 
        if (remaining + 1e-9 >= requiredCash) {
          const cash = requiredCash; 
          discount = maxD; 
          proposed.push({ invoiceId: r.invoice_id, amountApplied: Number(cash.toFixed(2)), discountTaken: Number(discount.toFixed(2)) }); 
          remaining = Number((remaining - cash).toFixed(2)); 
          continue; 
        }
      }
    }

    // Partial or full cash without discount
    const cash = Math.min(remaining, outstanding); 
    proposed.push({ invoiceId: r.invoice_id, amountApplied: Number(cash.toFixed(2)), discountTaken: 0 }); 
    remaining = Number((remaining - cash).toFixed(2)); 
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

  return getCustomerReceiptDetails({ orgId, id }); 
}

async function reallocateCustomerReceipt({ orgId, actorUserId, id, allocations }) {
  const { customerReceipt: cr, allocations: before } = await getCustomerReceiptDetails({ orgId, id }); 

  const isPosted = cr.status === "posted"; 
  if (cr.status !== "draft" && cr.status !== "posted") {
    throw new AppError(409, "Only draft/posted customer receipts can be reallocated"); 
  }

  if (isPosted) {
    // Hard control: require special permission on route-level.
    // Additional control: do not allow changing totals (cash/discount/unapplied) for posted documents.
    // We enforce this by requiring the resulting cash allocation sum equals (amount_total - unapplied_amount).
    const expectedCash = Number((Number(cr.amount_total || 0) - Number(cr.unapplied_amount || 0)).toFixed(2)); 
    const sumCash = Number((allocations || []).reduce((s, a) => s + Number(a.amountApplied || 0), 0).toFixed(2)); 
    if (Math.abs(sumCash - expectedCash) > 1e-6) {
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
    const cashApplied = Number(a.amountApplied || 0); 
    if (outstanding === null) throw new AppError(400, `Invalid invoiceId: ${a.invoiceId}`); 
    if (cashApplied <= 0) throw new AppError(400, "Allocation amountApplied must be > 0"); 
    if (cashApplied - 1e-9 > outstanding) throw new AppError(409, "Allocation exceeds invoice outstanding"); 

    const discount = computeEarlyPaymentDiscount({
      outstanding,
      cashApplied,
      term,
      receiptDate: cr.receipt_date,
      invoiceDate: inv.invoice_date
    }); 

    const settlement = Number((cashApplied + discount).toFixed(2)); 
    if (settlement - 1e-9 > outstanding) {
      throw new AppError(409, "Allocation (cash+discount) exceeds invoice outstanding"); 
    }

    proposed.push({ invoiceId: a.invoiceId, amountApplied: cashApplied, discountTaken: discount }); 
    sumCashCents += parseDecimalToBigInt(cashApplied, 2); 
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

  return getCustomerReceiptDetails({ orgId, id }); 
}

async function postCustomerReceipt({ orgId, actorUserId, id }) {
  const { customerReceipt: cr, allocations } = await getCustomerReceiptDetails({ orgId, id }); 
  if (cr.status !== "draft") throw new AppError(409, "Only draft customer receipts can be posted"); 

  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: cr.customer_id }); 
  if (!customer.default_receivable_account_id) throw new AppError(400, "Customer missing defaultReceivableAccountId"); 

  await assertPostableActiveAccount({ orgId, accountId: cr.cash_account_id, errMsg: "Invalid cashAccountId" }); 

  const term = await getPaymentTerm({ orgId, paymentTermsId: customer.payment_terms_id }); 
  const settings = await paymentIF.getPaymentSettings({ orgId }); 

  let cashAppliedCents = 0n; 
  let discountCents = 0n; 
  let settlementCents = 0n; 

  // Validate allocations and compute discounts;  update allocation rows with computed discounts
  for (const a of allocations) {
    const inv = await getInvoice(orgId, a.invoice_id); 
    if (!inv) throw new AppError(400, `Invalid invoiceId: ${a.invoice_id}`); 
    if (inv.customer_id !== cr.customer_id) throw new AppError(400, "Allocation invoice customer mismatch"); 
    if (inv.status !== "issued" && inv.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid invoices"); 

    const outstanding = await getInvoiceOutstanding(orgId, a.invoice_id); 
    if (outstanding === null) throw new AppError(400, `Invalid invoiceId: ${a.invoice_id}`); 

    const cashApplied = Number(a.amount_applied || 0); 
    if (cashApplied <= 0) throw new AppError(400, "Allocation amount_applied must be > 0"); 
    if (cashApplied - 1e-9 > outstanding) throw new AppError(409, "Allocation exceeds invoice outstanding"); 

    const discount = computeEarlyPaymentDiscount({
      outstanding,
      cashApplied,
      term,
      receiptDate: cr.receipt_date,
      invoiceDate: inv.invoice_date
    }); 

    const settlement = Number((cashApplied + discount).toFixed(2)); 
    if (settlement - 1e-9 > outstanding) throw new AppError(409, "Allocation (cash+discount) exceeds invoice outstanding"); 

    // Persist computed discount
    await pool.query(
      `UPDATE customer_receipt_allocations SET discount_taken=$3 WHERE customer_receipt_id=$1 AND invoice_id=$2`,
      [id, a.invoice_id, discount.toFixed(2)]
    ); 

    cashAppliedCents += parseDecimalToBigInt(cashApplied, 2); 
    discountCents += parseDecimalToBigInt(discount, 2); 
    settlementCents += parseDecimalToBigInt(settlement, 2); 
  }

  const amountTotalCents = parseDecimalToBigInt(cr.amount_total, 2); 
  if (cashAppliedCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds receipt amountTotal"); 

  const unappliedCents = amountTotalCents - cashAppliedCents; 

  if (unappliedCents > 0n) {
    if (!settings || !settings.ar_unapplied_account_id) {
      throw new AppError(409, "Unapplied cash exists but payment_settings.ar_unapplied_account_id is not configured"); 
    }
    await assertPostableActiveAccount({ orgId, accountId: settings.ar_unapplied_account_id, errMsg: "Invalid arUnappliedAccountId" }); 
  }

  if (discountCents > 0n) {
    if (!settings || !settings.ar_discount_account_id) {
      throw new AppError(409, "Discount taken exists but payment_settings.ar_discount_account_id is not configured"); 
    }
    await assertPostableActiveAccount({ orgId, accountId: settings.ar_discount_account_id, errMsg: "Invalid arDiscountAccountId" }); 
  }

  const cashApplied = bigIntToDecimalString(cashAppliedCents, 2); 
  const discountTotal = bigIntToDecimalString(discountCents, 2); 
  const settlementTotal = bigIntToDecimalString(settlementCents, 2); 
  const unappliedAmount = bigIntToDecimalString(unappliedCents, 2); 

  const period = await periodIF.findOpenPeriodForDate({ orgId, date: cr.receipt_date }); 

  const arAccountId = customer.default_receivable_account_id; 
  const cashAccountId = cr.cash_account_id; 

  const journalLines = []; 
  journalLines.push({ accountId: cashAccountId, debit: bigIntToDecimalString(amountTotalCents, 2), credit: "0.00", description: `Cash/Bank receipt ${cr.receipt_no}` }); 

  if (discountCents > 0n) {
    journalLines.push({ accountId: settings.ar_discount_account_id, debit: discountTotal, credit: "0.00", description: `Early payment discount ${cr.receipt_no}` }); 
  }

  if (settlementCents > 0n) {
    journalLines.push({ accountId: arAccountId, debit: "0.00", credit: settlementTotal, description: `A/R settlement ${cr.receipt_no}` }); 
  }

  if (unappliedCents > 0n) {
    journalLines.push({ accountId: settings.ar_unapplied_account_id, debit: "0.00", credit: unappliedAmount, description: `Unapplied cash ${cr.receipt_no}` }); 
  }

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
        settlement_total=$5,
        discount_total=$6,
        unapplied_amount=$7,
        posted_at=NOW(),
        posted_by=$8,
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, id, period.id, posted.journalId, settlementTotal, discountTotal, unappliedAmount, actorUserId]
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
    [orgId, id, actorUserId, reason, out.reversalJournalId]
  ); 

  // Recompute invoice status after void (if invoice has outstanding again)
  const { rows: allocRows } = await pool.query(
    `SELECT invoice_id FROM customer_receipt_allocations WHERE customer_receipt_id=$1`,
    [id]
  ); 

  for (const r of allocRows) {
    const outstanding = await getInvoiceOutstanding(orgId, r.invoice_id); 
    if (outstanding !== null && outstanding > 0) {
      await pool.query(
        `UPDATE invoices SET status='issued', updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status='paid'`,
        [orgId, r.invoice_id]
      ); 
    }
  }

  return rows[0]; 
}

module.exports = {
  createDraftCustomerReceipt,
  getCustomerReceiptDetails,
  listCustomerReceipts,
  autoAllocateCustomerReceipt,
  reallocateCustomerReceipt,
  postCustomerReceipt,
  voidCustomerReceipt
}; 
