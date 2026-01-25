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

async function getOrgBaseCurrency(client, orgId) {
  const { rows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  ); 
  if (!rows.length) throw new AppError(400, "Invalid organization"); 
  return rows[0].base_currency_code; 
}

const repo = require("./vendorPayments.repository"); 

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

async function getBillForAllocation(orgId, billId, client = null) {
  const db = client || pool; 
  const { rows } = await db.query(
    `SELECT * FROM bills WHERE organization_id=$1 AND id=$2`,
    [orgId, billId]
  ); 
  return rows[0] || null; 
}

async function getBillOutstanding(orgId, billId, client = null) {
  const db = client || pool; 
  const { rows } = await db.query(
    `SELECT outstanding FROM reporting_ap_open_items WHERE organization_id=$1 AND bill_id=$2`,
    [orgId, billId]
  ); 
  if (!rows.length) return null; 
  return Number(rows[0].outstanding || 0); 
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

function computeEarlyPaymentDiscount({ outstanding, cashApplied, term, paymentDate, billDate }) {
  if (!term) return 0; 
  if (term.discount_days == null || term.discount_rate == null) return 0; 
  const rate = Number(term.discount_rate || 0); 
  if (!rate || rate <= 0) return 0; 

  const billDt = new Date(billDate); 
  const cutoff = new Date(billDt); 
  cutoff.setDate(cutoff.getDate() + Number(term.discount_days)); 
  const pdt = new Date(paymentDate); 
  if (pdt.getTime() > cutoff.getTime()) return 0; 

  const maxDiscount = Number((outstanding * rate).toFixed(2)); 
  const requiredCash = Number((outstanding - maxDiscount).toFixed(2)); 
  if (cashApplied + 1e-9 < requiredCash) return 0; 

  const raw = Number((outstanding - cashApplied).toFixed(2)); 
  if (raw <= 0) return 0; 
  return Number(Math.min(maxDiscount, raw).toFixed(2)); 
}

async function createDraftVendorPayment({ orgId, actorUserId, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId }); 
  if (vendor.type !== "vendor") throw new AppError(400, "Partner is not a vendor"); 
  if (vendor.status !== "active") throw new AppError(400, "Vendor is inactive"); 
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId"); 

  await assertPostableActiveAccount({ orgId, accountId: payload.cashAccountId, errMsg: "Invalid cashAccountId" }); 

  const allocations = Array.isArray(payload.allocations) ? payload.allocations : []; 

  // Validate allocations (optional at draft): bills must be issued/paid, same vendor, and not exceed outstanding
  let sumAllocCents = 0n; 
  for (const a of allocations) {
    const bill = await getBillForAllocation(orgId, a.billId); 
    if (!bill) throw new AppError(400, `Invalid billId: ${a.billId}`); 
    if (bill.vendor_id !== payload.vendorId) throw new AppError(400, "Allocation bill vendor mismatch"); 
    if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid bills"); 
    if (bill.status === "voided") throw new AppError(409, "Cannot allocate to voided bill"); 

    const outstanding = await getBillOutstanding(orgId, a.billId); 
    if (outstanding === null) throw new AppError(400, `Invalid billId: ${a.billId}`); 
    const appliedCents = parseDecimalToBigInt(a.amountApplied, 2); 
    const outstandingCents = parseDecimalToBigInt(outstanding, 2); 
    if (appliedCents > outstandingCents) throw new AppError(409, "Allocation exceeds bill outstanding"); 

    sumAllocCents += appliedCents; 
  }

  const amountTotalCents = parseDecimalToBigInt(payload.amountTotal, 2); 
  if (sumAllocCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds payment amountTotal"); 

  const amountTotal = bigIntToDecimalString(amountTotalCents, 2); 

  const client = await pool.connect(); 
  try {
    await client.query("BEGIN"); 

    const baseCurrency = await getOrgBaseCurrency(client, orgId); 

    const paymentNo = await repo.nextPaymentNo(client, orgId); 
    const vp = await repo.insertVendorPayment(client, {
      orgId,
      vendorId: payload.vendorId,
      paymentNo,
      paymentDate: payload.paymentDate,
      paymentMethodId: payload.paymentMethodId,
      cashAccountId: payload.cashAccountId,
      amountTotal,
      currencyCode: baseCurrency
    }); 

    for (const a of allocations) {
      await repo.upsertAllocation(client, {
        vendorPaymentId: vp.id,
        billId: a.billId,
        amountApplied: bigIntToDecimalString(parseDecimalToBigInt(a.amountApplied, 2), 2),
        discountTaken: "0.00"
      }); 
    }

    await client.query("COMMIT"); 
    return vp; 
  } catch (e) {
    await client.query("ROLLBACK"); 
    throw e; 
  } finally {
    client.release(); 
  }
}

async function autoAllocateVendorPayment({ orgId, actorUserId, id, rule }) {
  const { vendorPayment: vp, allocations: current } = await getVendorPaymentDetails({ orgId, id }); 
  if (vp.status !== "draft") throw new AppError(409, "Only draft vendor payments can be auto-allocated"); 

  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: vp.vendor_id }); 
  const term = await getPaymentTerm({ orgId, paymentTermsId: vendor.payment_terms_id }); 

  const { rows } = await pool.query(
    `
    SELECT o.bill_id, o.outstanding, b.bill_date, b.due_date
    FROM reporting_ap_open_items o
    JOIN bills b ON b.id = o.bill_id
    WHERE o.organization_id=$1
      AND o.vendor_id=$2
      AND o.outstanding > 0
      AND b.status IN ('issued','paid')
    ORDER BY ${rule === 'fifo' ? 'b.bill_date' : 'b.due_date'} ASC, b.bill_date ASC
    `,
    [orgId, vp.vendor_id]
  ); 

  let remaining = Number(vp.amount_total || 0); 
  const proposed = []; 

  for (const r of rows) {
    if (remaining <= 0) break; 
    const outstanding = Number(r.outstanding || 0); 
    if (outstanding <= 0) continue; 

    // Try discount settlement first (if eligible)
    if (term && term.discount_days != null && term.discount_rate != null) {
      const rate = Number(term.discount_rate || 0); 
      if (rate > 0) {
        const maxD = Number((outstanding * rate).toFixed(2)); 
        const requiredCash = Number((outstanding - maxD).toFixed(2)); 
        if (remaining + 1e-9 >= requiredCash) {
          proposed.push({ billId: r.bill_id, amountApplied: Number(requiredCash.toFixed(2)), discountTaken: Number(maxD.toFixed(2)) }); 
          remaining = Number((remaining - requiredCash).toFixed(2)); 
          continue; 
        }
      }
    }

    const cash = Math.min(remaining, outstanding); 
    proposed.push({ billId: r.bill_id, amountApplied: Number(cash.toFixed(2)), discountTaken: 0 }); 
    remaining = Number((remaining - cash).toFixed(2)); 
  }

  const client = await pool.connect(); 
  try {
    await client.query("BEGIN"); 

    await repo.recordAllocationEvent(client, {
      orgId,
      vendorPaymentId: id,
      actorUserId,
      action: "auto_allocate",
      before: JSON.stringify(current),
      after: JSON.stringify(proposed)
    }); 

    await repo.deleteAllocations(client, id); 
    for (const a of proposed) {
      await repo.upsertAllocation(client, {
        vendorPaymentId: id,
        billId: a.billId,
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

  return getVendorPaymentDetails({ orgId, id }); 
}

async function reallocateVendorPayment({ orgId, actorUserId, id, allocations }) {
  const { vendorPayment: vp, allocations: before } = await getVendorPaymentDetails({ orgId, id }); 

  const isPosted = vp.status === "posted"; 
  if (vp.status !== "draft" && vp.status !== "posted") {
    throw new AppError(409, "Only draft/posted vendor payments can be reallocated"); 
  }

  if (isPosted) {
    const expectedCash = Number((Number(vp.amount_total || 0) - Number(vp.unapplied_amount || 0)).toFixed(2)); 
    const sumCash = Number((allocations || []).reduce((s, a) => s + Number(a.amountApplied || 0), 0).toFixed(2)); 
    if (Math.abs(sumCash - expectedCash) > 1e-6) {
      throw new AppError(409, "Posted payment reallocation must preserve applied cash amount"); 
    }
  }

  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: vp.vendor_id }); 
  const term = await getPaymentTerm({ orgId, paymentTermsId: vendor.payment_terms_id }); 

  const proposed = []; 
  let sumCashCents = 0n; 

  for (const a of allocations || []) {
    const bill = await getBillForAllocation(orgId, a.billId); 
    if (!bill) throw new AppError(400, `Invalid billId: ${a.billId}`); 
    if (bill.vendor_id !== vp.vendor_id) throw new AppError(400, "Allocation bill vendor mismatch"); 
    if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid bills"); 

    const outstanding = await getBillOutstanding(orgId, a.billId); 
    const cashApplied = Number(a.amountApplied || 0); 
    if (outstanding === null) throw new AppError(400, `Invalid billId: ${a.billId}`); 
    if (cashApplied <= 0) throw new AppError(400, "Allocation amountApplied must be > 0"); 
    if (cashApplied - 1e-9 > outstanding) throw new AppError(409, "Allocation exceeds bill outstanding"); 

    const discount = computeEarlyPaymentDiscount({
      outstanding,
      cashApplied,
      term,
      paymentDate: vp.payment_date,
      billDate: bill.bill_date
    }); 

    const settlement = Number((cashApplied + discount).toFixed(2)); 
    if (settlement - 1e-9 > outstanding) {
      throw new AppError(409, "Allocation (cash+discount) exceeds bill outstanding"); 
    }

    proposed.push({ billId: a.billId, amountApplied: cashApplied, discountTaken: discount }); 
    sumCashCents += parseDecimalToBigInt(cashApplied, 2); 
  }

  const amountTotalCents = parseDecimalToBigInt(vp.amount_total, 2); 
  if (sumCashCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds payment amountTotal"); 

  const client = await pool.connect(); 
  try {
    await client.query("BEGIN"); 

    await repo.recordAllocationEvent(client, {
      orgId,
      vendorPaymentId: id,
      actorUserId,
      action: "reallocate",
      before: JSON.stringify(before),
      after: JSON.stringify(proposed)
    }); 

    await repo.deleteAllocations(client, id); 
    for (const a of proposed) {
      await repo.upsertAllocation(client, {
        vendorPaymentId: id,
        billId: a.billId,
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

  return getVendorPaymentDetails({ orgId, id }); 
}

async function getVendorPaymentDetails({ orgId, id }) {
  const vp = await repo.getVendorPaymentById(orgId, id); 
  if (!vp) throw new AppError(404, "Vendor payment not found"); 
  const allocations = await repo.getAllocations(id); 
  return { vendorPayment: vp, allocations }; 
}

async function listVendorPayments({ orgId, query }) {
  return repo.listVendorPayments({ orgId, query }); 
}

async function postVendorPayment({ orgId, actorUserId, id }) {
  const { withTransaction } = require("../../../../db/tx"); 
  return withTransaction(async (client) => {
    // Lock vendor payment row
    const { rows: vpRows } = await client.query(
      `SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, id]
    ); 
    if (!vpRows.length) throw new AppError(404, "Vendor payment not found"); 
    const vp = vpRows[0]; 
    if (vp.status !== "draft") throw new AppError(409, "Only draft vendor payments can be posted"); 

    const { rows: allocations } = await client.query(
      `SELECT * FROM vendor_payment_allocations WHERE vendor_payment_id=$1 ORDER BY created_at ASC`,
      [id]
    ); 
    // allocations may be empty (vendor prepayments)

    const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: vp.vendor_id, client }); 
    if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId"); 

    await assertPostableActiveAccount({ orgId, accountId: vp.cash_account_id, errMsg: "Invalid cashAccountId", client }); 

    const term = await getPaymentTerm({ orgId, paymentTermsId: vendor.payment_terms_id, client }); 
    const settings = await paymentIF.getPaymentSettings({ orgId }); 

    // Re-validate allocations at post-time (race safety), compute discounts
    let cashAppliedCents = 0n; 
    let discountCents = 0n; 
    let settlementCents = 0n; 
    for (const a of allocations) {
      const bill = await getBillForAllocation(orgId, a.bill_id, client); 
      if (!bill) throw new AppError(400, `Invalid billId: ${a.bill_id}`); 
      if (bill.vendor_id !== vp.vendor_id) throw new AppError(400, "Allocation bill vendor mismatch"); 
      if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid bills"); 
      if (bill.status === "voided") throw new AppError(409, "Cannot allocate to voided bill"); 

      const outstanding = await getBillOutstanding(orgId, a.bill_id, client); 
      const cashApplied = Number(a.amount_applied || 0); 
      if (cashApplied <= 0) throw new AppError(400, "Allocation amount_applied must be > 0"); 
      if (cashApplied - 1e-9 > outstanding) throw new AppError(409, "Allocation exceeds bill outstanding"); 

      const discount = computeEarlyPaymentDiscount({
        outstanding,
        cashApplied,
        term,
        paymentDate: vp.payment_date,
        billDate: bill.bill_date
      }); 

      const settlement = Number((cashApplied + discount).toFixed(2)); 
      if (settlement - 1e-9 > outstanding) throw new AppError(409, "Allocation (cash+discount) exceeds bill outstanding"); 

      await client.query(
        `UPDATE vendor_payment_allocations SET discount_taken=$3 WHERE vendor_payment_id=$1 AND bill_id=$2`,
        [id, a.bill_id, discount.toFixed(2)]
      ); 

      cashAppliedCents += parseDecimalToBigInt(cashApplied, 2); 
      discountCents += parseDecimalToBigInt(discount, 2); 
      settlementCents += parseDecimalToBigInt(settlement, 2); 
    }

    const amountTotalCents = parseDecimalToBigInt(vp.amount_total, 2); 
    if (cashAppliedCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds payment amountTotal"); 

    const unappliedCents = amountTotalCents - cashAppliedCents; 
    if (unappliedCents > 0n) {
      if (!settings || !settings.ap_prepayments_account_id) {
        throw new AppError(409, "Unapplied payment exists but payment_settings.ap_prepayments_account_id is not configured"); 
      }
      await assertPostableActiveAccount({ orgId, accountId: settings.ap_prepayments_account_id, errMsg: "Invalid apPrepaymentsAccountId", client }); 
    }
    if (discountCents > 0n) {
      if (!settings || !settings.ap_discount_income_account_id) {
        throw new AppError(409, "Discount taken exists but payment_settings.ap_discount_income_account_id is not configured"); 
      }
      await assertPostableActiveAccount({ orgId, accountId: settings.ap_discount_income_account_id, errMsg: "Invalid apDiscountIncomeAccountId", client }); 
    }

    const cashApplied = bigIntToDecimalString(cashAppliedCents, 2); 
    const discountTotal = bigIntToDecimalString(discountCents, 2); 
    const settlementTotal = bigIntToDecimalString(settlementCents, 2); 
    const unappliedAmount = bigIntToDecimalString(unappliedCents, 2); 

    const period = await periodIF.findOpenPeriodForDate({ orgId, date: vp.payment_date, client }); 

    const apAccountId = vendor.default_payable_account_id; 
    const cashAccountId = vp.cash_account_id; 

    const journalLines = []; 
    if (settlementCents > 0n) {
      journalLines.push({ accountId: apAccountId, debit: settlementTotal, credit: "0.00", description: `A/P settlement ${vp.payment_no}` }); 
    }
    if (unappliedCents > 0n) {
      journalLines.push({ accountId: settings.ap_prepayments_account_id, debit: unappliedAmount, credit: "0.00", description: `Vendor prepayment ${vp.payment_no}` }); 
    }
    if (discountCents > 0n) {
      journalLines.push({ accountId: settings.ap_discount_income_account_id, debit: "0.00", credit: discountTotal, description: `Early payment discount ${vp.payment_no}` }); 
    }
    journalLines.push({ accountId: cashAccountId, debit: "0.00", credit: bigIntToDecimalString(amountTotalCents, 2), description: `Cash/Bank payment ${vp.payment_no}` }); 

    const idempotencyKey = `vendor_payment:${id}:post`; 

    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: vp.payment_date,
        typeCode: "GENERAL",
        memo: `Vendor payment ${vp.payment_no}`,
        idempotencyKey,
        lines: journalLines
      }
    }); 
    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client }); 

    // Update vendor payment as posted
    const { rows: updatedVP } = await client.query(
      `
      UPDATE vendor_payments
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

    // Update each bill status to paid if fully settled (based on all posted allocations)
    for (const a of allocations) {
      const outstandingAfter = await getBillOutstanding(orgId, a.bill_id, client); 
      if (outstandingAfter !== null && outstandingAfter <= 0) {
        await client.query(
          `
          UPDATE bills
          SET status='paid', updated_at=NOW()
          WHERE organization_id=$1 AND id=$2 AND status IN ('issued','paid')
          `,
          [orgId, a.bill_id]
        ); 
      }
    }

    return updatedVP[0]; 
  }); 
}

async function voidVendorPayment({ orgId, actorUserId, id, reason }) {
  const { withTransaction } = require("../../../../db/tx"); 
  return withTransaction(async (client) => {
    const { rows: vpRows } = await client.query(
      `SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, id]
    ); 
    if (!vpRows.length) throw new AppError(404, "Vendor payment not found"); 
    const vp = vpRows[0]; 
    if (vp.status !== "posted") throw new AppError(409, "Only posted vendor payments can be voided"); 
    if (!vp.journal_entry_id) throw new AppError(500, "Vendor payment missing journal reference"); 

    const out = await journalIF.voidPostedJournal({
      orgId,
      journalId: vp.journal_entry_id,
      actorUserId,
      reason,
      client
    }); 

    const { rows } = await client.query(
    `
    UPDATE vendor_payments
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

    // After void, bills may no longer be fully paid. Recompute status for affected bills.
    const { rows: affectedBills } = await client.query(
      `SELECT bill_id FROM vendor_payment_allocations WHERE vendor_payment_id=$1`,
      [id]
    ); 

    for (const r of affectedBills) {
      const outstanding = await getBillOutstanding(orgId, r.bill_id, client); 
      if (outstanding !== null && outstanding > 0) {
        await client.query(
          `
          UPDATE bills
          SET status='issued', updated_at=NOW()
          WHERE organization_id=$1 AND id=$2 AND status IN ('paid','issued')
          `,
          [orgId, r.bill_id]
        ); 
      }
    }

    return { vendorPayment: rows[0], reversalJournalId: out.reversalJournalId }; 
  }); 
}

module.exports = {
  createDraftVendorPayment,
  getVendorPaymentDetails,
  listVendorPayments,
  autoAllocateVendorPayment,
  reallocateVendorPayment,
  postVendorPayment,
  voidVendorPayment
}; 
