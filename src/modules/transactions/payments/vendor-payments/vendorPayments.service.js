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
const { buildDetailMeta, round2 } = require("../../_shared/detailEnrichment");
const ghWithholdingSvc = require("../../../../core/accounting/tax/ghanaWithholding.service");
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
  return normalizeMoney(rows[0].outstanding || "0");
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
  if (!term || term.discount_days == null || term.discount_rate == null) return "0.00";

  const outstandingCents = moneyUnits(outstanding);
  const cashAppliedCents = moneyUnits(cashApplied);
  const maxDiscountCents = applyFractionToMoneyUnits(outstandingCents, term.discount_rate || "0");
  if (maxDiscountCents <= 0n) return "0.00";

  const billDt = new Date(billDate);
  const cutoff = new Date(billDt);
  cutoff.setDate(cutoff.getDate() + Number(term.discount_days));
  const pdt = new Date(paymentDate);
  if (pdt.getTime() > cutoff.getTime()) return "0.00";

  const requiredCashCents = outstandingCents - maxDiscountCents;
  if (cashAppliedCents < requiredCashCents) return "0.00";

  const rawDiscountCents = outstandingCents - cashAppliedCents;
  if (rawDiscountCents <= 0n) return "0.00";
  return moneyStringFromUnits(minUnits(maxDiscountCents, rawDiscountCents));
}

async function createDraftVendorPayment({ orgId, actorUserId, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId });
  if (vendor.type !== "vendor") throw new AppError(400, "Partner is not a vendor");
  if (vendor.status !== "active") throw new AppError(400, "Vendor is inactive");
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

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

    const { accountId: paymentAccountId } = await resolvePaymentAccount({
      orgId, paymentMethodId: payload.paymentMethodId, cashAccountId: payload.cashAccountId, client
    });
    const baseCurrency = await getOrgBaseCurrency(client, orgId);

    const paymentNo = await repo.nextPaymentNo(client, orgId);
    const vp = await repo.insertVendorPayment(client, {
      orgId,
      vendorId: payload.vendorId,
      paymentNo,
      paymentDate: payload.paymentDate,
      paymentMethodId: payload.paymentMethodId,
      cashAccountId: paymentAccountId,
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

async function updateDraftVendorPayment({ orgId, actorUserId, id, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId });
  if (vendor.type !== "vendor") throw new AppError(400, "Partner is not a vendor");
  if (vendor.status !== "active") throw new AppError(400, "Vendor is inactive");
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

  return require("../../../../db/tx").withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Vendor payment not found");
    const before = rows[0];
    if (before.status !== 'draft') throw new AppError(409, "Only draft vendor payments can be edited");
    const { accountId: paymentAccountId } = await resolvePaymentAccount({
      orgId, paymentMethodId: payload.paymentMethodId, cashAccountId: payload.cashAccountId, client
    });

    const allocations = Array.isArray(payload.allocations) ? payload.allocations : [];
    let sumAllocCents = 0n;
    for (const a of allocations) {
      const bill = await getBillForAllocation(orgId, a.billId, client);
      if (!bill) throw new AppError(400, `Invalid billId: ${a.billId}`);
      if (bill.vendor_id !== payload.vendorId) throw new AppError(400, "Allocation bill vendor mismatch");
      if (!['issued','paid'].includes(bill.status)) throw new AppError(409, "Can only allocate to issued/paid bills");
      const outstanding = await getBillOutstanding(orgId, a.billId, client);
      if (outstanding === null) throw new AppError(400, `Invalid billId: ${a.billId}`);
      const appliedCents = parseDecimalToBigInt(a.amountApplied, 2);
      if (appliedCents > parseDecimalToBigInt(outstanding, 2)) throw new AppError(409, "Allocation exceeds bill outstanding");
      sumAllocCents += appliedCents;
    }
    const amountTotalCents = parseDecimalToBigInt(payload.amountTotal, 2);
    if (sumAllocCents > amountTotalCents) throw new AppError(409, "Allocations sum exceeds payment amountTotal");
    const amountTotal = bigIntToDecimalString(amountTotalCents, 2);

    const { rows: updatedRows } = await client.query(
      `UPDATE vendor_payments
          SET vendor_id=$3, payment_date=$4, payment_method_id=$5, cash_account_id=$6,
              amount_total=$7, unapplied_amount=0, discount_total=0, settlement_total=0, updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, id, payload.vendorId, payload.paymentDate, payload.paymentMethodId || null, paymentAccountId, amountTotal]
    );
    await repo.deleteAllocations(client, id);
    for (const a of allocations) {
      await repo.upsertAllocation(client, {
        vendorPaymentId: id, billId: a.billId,
        amountApplied: bigIntToDecimalString(parseDecimalToBigInt(a.amountApplied, 2), 2), discountTaken: '0.00'
      });
    }
    await writeAudit({ organizationId: orgId, actorUserId, action: 'vendor_payment.draft_updated', entityType: 'vendor_payments', entityId: id, before, after: updatedRows[0], client });
    return updatedRows[0];
  });
}

async function autoAllocateVendorPayment({ orgId, actorUserId, id, rule }) {
  const { vendorPayment: vp, allocations: current } = await getVendorPaymentDetails({ orgId, id, currentUserId: actorUserId });
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

  let remainingCents = moneyUnits(vp.amount_total || "0");
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
        paymentDate: vp.payment_date,
        billDate: r.bill_date
      });
      if (moneyUnits(discount) > 0n && remainingCents >= requiredCashCents) {
        proposed.push({ billId: r.bill_id, amountApplied: moneyStringFromUnits(requiredCashCents), discountTaken: discount });
        remainingCents -= requiredCashCents;
        continue;
      }
    }

    const cashCents = minUnits(remainingCents, outstandingCents);
    proposed.push({ billId: r.bill_id, amountApplied: moneyStringFromUnits(cashCents), discountTaken: "0.00" });
    remainingCents -= cashCents;
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

  return getVendorPaymentDetails({ orgId, id, currentUserId: actorUserId });
}

async function reallocateVendorPayment({ orgId, actorUserId, id, allocations }) {
  const { vendorPayment: vp, allocations: before } = await getVendorPaymentDetails({ orgId, id, currentUserId: actorUserId });

  const isPosted = vp.status === "posted";
  if (vp.status !== "draft" && vp.status !== "posted") {
    throw new AppError(409, "Only draft/posted vendor payments can be reallocated");
  }

  if (isPosted) {
    const expectedCashCents = moneyUnits(vp.amount_total || "0") - moneyUnits(vp.unapplied_amount || "0");
    const sumCashCents = (allocations || []).reduce((sum, allocation) => sum + moneyUnits(allocation.amountApplied || "0"), 0n);
    if (sumCashCents !== expectedCashCents) {
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
    const cashAppliedCents = moneyUnits(a.amountApplied || "0");
    if (outstanding === null) throw new AppError(400, `Invalid billId: ${a.billId}`);
    if (cashAppliedCents <= 0n) throw new AppError(400, "Allocation amountApplied must be > 0");
    if (cashAppliedCents > moneyUnits(outstanding)) throw new AppError(409, "Allocation exceeds bill outstanding");
    const cashApplied = moneyStringFromUnits(cashAppliedCents);

    const discount = computeEarlyPaymentDiscount({
      outstanding,
      cashApplied,
      term,
      paymentDate: vp.payment_date,
      billDate: bill.bill_date
    });

    const settlementCents = cashAppliedCents + moneyUnits(discount);
    if (settlementCents > moneyUnits(outstanding)) {
      throw new AppError(409, "Allocation (cash+discount) exceeds bill outstanding");
    }

    proposed.push({ billId: a.billId, amountApplied: cashApplied, discountTaken: discount });
    sumCashCents += cashAppliedCents;
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

  return getVendorPaymentDetails({ orgId, id, currentUserId: actorUserId });
}

async function getVendorPaymentDetails({ orgId, id, currentUserId }) {
  const vp = await repo.getVendorPaymentById(orgId, id, currentUserId);
  if (!vp) throw new AppError(404, "Vendor payment not found");
  const allocations = await repo.getAllocations(id);
  const billIds = allocations.map((a) => a.bill_id).filter(Boolean);
  let billMap = new Map();
  if (billIds.length) {
    const { rows } = await pool.query(
      `SELECT id, bill_no, bill_date, due_date, total, status, currency_code FROM bills WHERE organization_id=$1 AND id = ANY($2::uuid[])`,
      [orgId, billIds]
    );
    billMap = new Map(rows.map((row) => [row.id, row]));
  }
  const enrichedAllocations = allocations.map((allocation) => {
    const bill = billMap.get(allocation.bill_id) || null;
    return {
      ...allocation,
      bill,
      display_amounts: {
        amount_applied: round2(allocation.amount_applied || 0),
        discount_taken: round2(allocation.discount_taken || 0),
        settled_total: moneyNumber(addMoney(allocation.amount_applied || "0", allocation.discount_taken || "0")),
      }
    };
  });
  return {
    vendorPayment: vp,
    allocations: enrichedAllocations,
    detail_meta: buildDetailMeta({ header: vp, lines: [], extra: { outstanding: vp.unapplied_amount ?? 0 } }),
    allocation_summary: {
      allocation_count: enrichedAllocations.length,
      applied_total: moneyNumber(moneyStringFromUnits(enrichedAllocations.reduce((sum, item) => sum + moneyUnits(item.amount_applied || "0"), 0n))),
      discount_total: moneyNumber(moneyStringFromUnits(enrichedAllocations.reduce((sum, item) => sum + moneyUnits(item.discount_taken || "0"), 0n))),
      unapplied_amount: round2(vp.unapplied_amount || 0),
    }
  };
}

async function listVendorPayments({ orgId, query }) {
  return repo.listVendorPayments({ orgId, query });
}



async function assertVendorPaymentApprovalStateAllowsPost({ orgId, vendorPayment, client = null }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "payment_out",
    workflowDocumentId: vendorPayment.workflow_document_id,
    client,
    actionLabel: "post"
  });
}

async function submitVendorPaymentForApproval({ orgId, actorUserId, id }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Vendor payment not found");
    const vp = rows[0];
    const allocations = await repo.getAllocations(id);

    const doc = await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "payment_out",
      entity: vp,
      workflowDocumentId: vp.workflow_document_id,
      snapshot: {
        header: vp,
        allocations,
        totals: {
          amount_total: vp.amount_total,
          unapplied_amount: vp.unapplied_amount || null,
          settlement_amount: vp.settlement_amount || null,
          discount_amount: vp.discount_amount || null,
        },
        meta: {
          status: vp.status,
          journal_entry_id: vp.journal_entry_id || null,
          period_id: vp.period_id || null,
        }
      },
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(`UPDATE vendor_payments SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, workflowDocumentId]);
      }
    });

    await client.query(`UPDATE vendor_payments SET status='submitted', submitted_at=NOW(), submitted_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, actorUserId]);
    await client.query("COMMIT");
    return doc;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function approveVendorPaymentWorkflow({ orgId, actorUserId, id, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Vendor payment not found");
    const vp = rows[0];
    if (!vp.workflow_document_id) throw new AppError(409, "Vendor payment has no workflow document");

    const approved = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "payment_out",
      workflowDocumentId: vp.workflow_document_id,
      creatorUserId: vp.created_by || null,
      comment,
      client
    });

    if (approved?.next) {
      await client.query(`UPDATE vendor_payments SET status='submitted', updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id]);
    } else {
      await client.query(`UPDATE vendor_payments SET status='approved', approved_at=NOW(), approved_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, actorUserId]);
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

async function rejectVendorPaymentWorkflow({ orgId, actorUserId, id, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM vendor_payments WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [orgId, id]);
    if (!rows.length) throw new AppError(404, "Vendor payment not found");
    const vp = rows[0];
    if (!vp.workflow_document_id) throw new AppError(409, "Vendor payment has no workflow document");

    const rejected = await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "payment_out",
      workflowDocumentId: vp.workflow_document_id,
      creatorUserId: vp.created_by || null,
      comment,
      client
    });

    await client.query(`UPDATE vendor_payments SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, id, actorUserId, comment || null]);
    await client.query("COMMIT");
    return rejected;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
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
    if (!["draft","approved"].includes(vp.status)) throw new AppError(409, "Only draft/approved vendor payments can be posted");

  await assertVendorPaymentApprovalStateAllowsPost({ orgId, vendorPayment: vp, client });

    const { rows: allocations } = await client.query(
      `SELECT * FROM vendor_payment_allocations WHERE vendor_payment_id=$1 ORDER BY created_at ASC`,
      [id]
    );
    // allocations may be empty (vendor prepayments)

    const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: vp.vendor_id, client });
    if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

    await assertPostableActiveAccount({ orgId, accountId: vp.cash_account_id, errMsg: "Invalid cashAccountId", client });

    const term = await getPaymentTerm({ orgId, paymentTermsId: vendor.payment_terms_id, client });
    const settings = await paymentIF.getPaymentSettings({ orgId, client });

    // Re-validate allocations at post-time (race safety), compute discounts
    let cashAppliedCents = 0n;
    let discountCents = 0n;
    let vatWithholdingCents = 0n;
    let settlementCents = 0n;
    for (const a of allocations) {
      const bill = await getBillForAllocation(orgId, a.bill_id, client);
      if (!bill) throw new AppError(400, `Invalid billId: ${a.bill_id}`);
      if (bill.vendor_id !== vp.vendor_id) throw new AppError(400, "Allocation bill vendor mismatch");
      if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid bills");
      if (bill.status === "voided") throw new AppError(409, "Cannot allocate to voided bill");

      const outstanding = await getBillOutstanding(orgId, a.bill_id, client);
      const cashAppliedCentsCurrent = moneyUnits(a.amount_applied || "0");
      if (cashAppliedCentsCurrent <= 0n) throw new AppError(400, "Allocation amount_applied must be > 0");
      if (cashAppliedCentsCurrent > moneyUnits(outstanding)) throw new AppError(409, "Allocation exceeds bill outstanding");
      const cashApplied = moneyStringFromUnits(cashAppliedCentsCurrent);

      const discount = computeEarlyPaymentDiscount({
        outstanding,
        cashApplied,
        term,
        paymentDate: vp.payment_date,
        billDate: bill.bill_date
      });

      const whvat = await ghWithholdingSvc.computeVendorBillVatWithholding({
        orgId,
        partnerId: vp.vendor_id,
        billId: a.bill_id,
        cashAmount: bigIntToDecimalString(parseDecimalToBigInt(cashApplied, 2), 2),
        client,
      });
      const whvatCents = parseDecimalToBigInt(whvat.withheldAmount || '0', 2);
      const settlementCurrentCents = cashAppliedCentsCurrent + moneyUnits(discount) + whvatCents;
      const outstandingCents = parseDecimalToBigInt(outstanding, 2);
      if (settlementCurrentCents > outstandingCents) throw new AppError(409, "Allocation (cash + discount + VAT withholding) exceeds bill outstanding");

      await client.query(
        `UPDATE vendor_payment_allocations
            SET discount_taken=$3,vat_withholding_basis=$4,vat_withholding_applied=$5
          WHERE vendor_payment_id=$1 AND bill_id=$2`,
        [id, a.bill_id, discount, whvat.taxableBasis || '0.00', whvat.withheldAmount || '0.00']
      );

      cashAppliedCents += cashAppliedCentsCurrent;
      discountCents += moneyUnits(discount);
      vatWithholdingCents += whvatCents;
      settlementCents += settlementCurrentCents;
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

    let ghTaxSettings = null;
    if (vatWithholdingCents > 0n) {
      ghTaxSettings = await ghWithholdingSvc.getSettings({ orgId, client });
      if (!ghTaxSettings.vat_withholding_payable_account_id) {
        throw new AppError(409, 'VAT withholding payable account is not configured');
      }
      await assertPostableActiveAccount({ orgId, accountId: ghTaxSettings.vat_withholding_payable_account_id, errMsg: 'Invalid VAT withholding payable account', client });
    }

    const cashApplied = bigIntToDecimalString(cashAppliedCents, 2);
    const discountTotal = bigIntToDecimalString(discountCents, 2);
    const settlementTotal = bigIntToDecimalString(settlementCents, 2);
    const vatWithholdingTotal = bigIntToDecimalString(vatWithholdingCents, 2);
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
    if (vatWithholdingCents > 0n) {
      journalLines.push({ accountId: ghTaxSettings.vat_withholding_payable_account_id, debit: "0.00", credit: vatWithholdingTotal, description: `VAT withholding payable ${vp.payment_no}` });
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
    await propagateDocumentWorkflowToJournal({
      client,
      journalId: draft.journalId,
      source: {
        orgId,
        workflowDocumentId: vp.workflow_document_id || null,
        createdBy: vp.created_by || actorUserId,
        submittedAt: vp.submitted_at || null,
        submittedBy: vp.submitted_by || null,
        approvedAt: vp.approved_at || null,
        approvedBy: vp.approved_by || null,
        updatedBy: actorUserId
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
          vat_withholding_total=$8,
          posted_at=NOW(),
          posted_by=$9,
          updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
      `,
      [orgId, id, period.id, posted.journalId, settlementTotal, discountTotal, unappliedAmount, vatWithholdingTotal, actorUserId]
    );

    // Capture Ghana income-WHT / VAT-withholding events at the actual payment event.
    // This is idempotent per vendor-payment/bill/regime and does not create a second event on retry.
    await ghWithholdingSvc.captureVendorPaymentWithholding({
      orgId,
      actorUserId,
      vendorPaymentId: id,
      client,
    });

    // Update each bill status to paid if fully settled (based on all posted allocations)
    for (const a of allocations) {
      const outstandingAfter = await getBillOutstanding(orgId, a.bill_id, client);
      if (outstandingAfter !== null && moneyUnits(outstandingAfter) <= 0n) {
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

    const postedPayment = updatedVP[0];
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "vendor_payment.posted",
      entityType: "vendor_payments",
      entityId: id,
      after: postedPayment,
      client
    });

    return postedPayment;
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

    await ghWithholdingSvc.voidVendorPaymentWithholding({ orgId, vendorPaymentId: id, client });

    for (const r of affectedBills) {
      const outstanding = await getBillOutstanding(orgId, r.bill_id, client);
      if (outstanding !== null && moneyUnits(outstanding) > 0n) {
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

    const result = { vendorPayment: rows[0], reversalJournalId: out.reversalJournalId };
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "vendor_payment.voided",
      entityType: "vendor_payments",
      entityId: id,
      after: result,
      client
    });

    return result;
  });
}

module.exports = {
  createDraftVendorPayment,
  updateDraftVendorPayment,
  getVendorPaymentDetails,
  listVendorPayments,
  autoAllocateVendorPayment,
  reallocateVendorPayment,
  submitVendorPaymentForApproval,
  approveVendorPaymentWorkflow,
  rejectVendorPaymentWorkflow,
  assertVendorPaymentApprovalStateAllowsPost,
  postVendorPayment,
  voidVendorPayment
};
