const { pool } = require("../../../../db/pool");
const { AppError } = require("../../../../shared/errors/AppError");

const periodIF = require("../../../../interfaces/periodManagement.interface");
const journalIF = require("../../../../interfaces/journalPosting.interface");
const partnerIF = require("../../../../interfaces/partnerManagement.interface");

const repo = require("./vendorPayments.repository");

async function assertPostableActiveAccount({ orgId, accountId, errMsg }) {
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, errMsg || "Invalid account");
  if (!rows[0].is_postable) throw new AppError(400, "Non-postable account used");
  if (rows[0].status !== "active") throw new AppError(400, "Inactive account used");
}

async function getBillForAllocation(orgId, billId) {
  const { rows } = await pool.query(
    `SELECT * FROM bills WHERE organization_id=$1 AND id=$2`,
    [orgId, billId]
  );
  return rows[0] || null;
}

async function getBillOutstanding(orgId, billId) {
  const { rows: billRows } = await pool.query(
    `SELECT total FROM bills WHERE organization_id=$1 AND id=$2`,
    [orgId, billId]
  );
  if (!billRows.length) return null;

  const total = Number(billRows[0].total);

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
  return Number((total - paid).toFixed(2));
}

async function createDraftVendorPayment({ orgId, actorUserId, payload }) {
  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: payload.vendorId });
  if (vendor.type !== "vendor") throw new AppError(400, "Partner is not a vendor");
  if (vendor.status !== "active") throw new AppError(400, "Vendor is inactive");
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

  await assertPostableActiveAccount({ orgId, accountId: payload.cashAccountId, errMsg: "Invalid cashAccountId" });

  // Validate allocations: bills must be issued/paid (not voided/draft), same vendor, and not exceed outstanding
  let sumAlloc = 0;

  for (const a of payload.allocations) {
    const bill = await getBillForAllocation(orgId, a.billId);
    if (!bill) throw new AppError(400, `Invalid billId: ${a.billId}`);
    if (bill.vendor_id !== payload.vendorId) throw new AppError(400, "Allocation bill vendor mismatch");
    if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid bills");
    if (bill.status === "voided") throw new AppError(409, "Cannot allocate to voided bill");

    const outstanding = await getBillOutstanding(orgId, a.billId);
    if (outstanding === null) throw new AppError(400, `Invalid billId: ${a.billId}`);
    if (Number(a.amountApplied) > outstanding) throw new AppError(409, "Allocation exceeds bill outstanding");

    sumAlloc += Number(a.amountApplied);
  }

  sumAlloc = Number(sumAlloc.toFixed(2));
  const amountTotal = Number(payload.amountTotal.toFixed(2));
  if (sumAlloc <= 0) throw new AppError(400, "allocations must sum to > 0");
  if (sumAlloc > amountTotal) throw new AppError(409, "Allocations sum exceeds payment amountTotal");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const paymentNo = await repo.nextPaymentNo(client, orgId);
    const vp = await repo.insertVendorPayment(client, {
      orgId,
      vendorId: payload.vendorId,
      paymentNo,
      paymentDate: payload.paymentDate,
      paymentMethodId: payload.paymentMethodId,
      cashAccountId: payload.cashAccountId,
      amountTotal
    });

    for (const a of payload.allocations) {
      await repo.insertAllocation(client, {
        vendorPaymentId: vp.id,
        billId: a.billId,
        amountApplied: Number(a.amountApplied.toFixed(2))
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
  const { vendorPayment: vp, allocations } = await getVendorPaymentDetails({ orgId, id });
  if (vp.status !== "draft") throw new AppError(409, "Only draft vendor payments can be posted");
  if (!allocations.length) throw new AppError(400, "Vendor payment has no allocations");

  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: vp.vendor_id });
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

  await assertPostableActiveAccount({ orgId, accountId: vp.cash_account_id, errMsg: "Invalid cashAccountId" });

  // Re-validate allocations at post-time (race safety)
  let sumAlloc = 0;
  for (const a of allocations) {
    const bill = await getBillForAllocation(orgId, a.bill_id);
    if (!bill) throw new AppError(400, `Invalid billId: ${a.bill_id}`);
    if (bill.vendor_id !== vp.vendor_id) throw new AppError(400, "Allocation bill vendor mismatch");
    if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Can only allocate to issued/paid bills");
    if (bill.status === "voided") throw new AppError(409, "Cannot allocate to voided bill");

    const outstanding = await getBillOutstanding(orgId, a.bill_id);
    if (Number(a.amount_applied) > outstanding) throw new AppError(409, "Allocation exceeds bill outstanding");

    sumAlloc += Number(a.amount_applied);
  }
  sumAlloc = Number(sumAlloc.toFixed(2));

  const amountTotal = Number(vp.amount_total);
  if (sumAlloc <= 0) throw new AppError(400, "allocations must sum to > 0");
  if (sumAlloc > amountTotal) throw new AppError(409, "Allocations sum exceeds payment amountTotal");

  const period = await periodIF.findOpenPeriodForDate({ orgId, date: vp.payment_date });

  const apAccountId = vendor.default_payable_account_id;
  const cashAccountId = vp.cash_account_id;

  const journalLines = [
    { accountId: apAccountId, debit: sumAlloc, credit: 0, description: `A/P settlement ${vp.payment_no}` },
    { accountId: cashAccountId, debit: 0, credit: sumAlloc, description: `Cash/Bank payment ${vp.payment_no}` }
  ];

  const idempotencyKey = `vendor_payment:${id}:post`;

  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: period.id,
      entryDate: vp.payment_date,
      typeCode: "GENERAL",
      memo: `Vendor payment ${vp.payment_no}`,
      idempotencyKey,
      lines: journalLines
    }
  });

  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });

  // Update vendor payment as posted
  const { rows: vpRows } = await pool.query(
    `
    UPDATE vendor_payments
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

  // Update each bill status to paid if fully settled (based on all posted allocations)
  for (const a of allocations) {
    const outstandingAfter = await getBillOutstanding(orgId, a.bill_id);
    if (outstandingAfter !== null && outstandingAfter <= 0) {
      await pool.query(
        `
        UPDATE bills
        SET status='paid', updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 AND status IN ('issued','paid')
        `,
        [orgId, a.bill_id]
      );
    }
  }

  return vpRows[0];
}

async function voidVendorPayment({ orgId, actorUserId, id, reason }) {
  const vp = await repo.getVendorPaymentById(orgId, id);
  if (!vp) throw new AppError(404, "Vendor payment not found");
  if (vp.status !== "posted") throw new AppError(409, "Only posted vendor payments can be voided");
  if (!vp.journal_entry_id) throw new AppError(500, "Vendor payment missing journal reference");

  const out = await journalIF.voidPostedJournal({
    orgId,
    journalId: vp.journal_entry_id,
    actorUserId,
    reason
  });

  const { rows } = await pool.query(
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
  const { rows: affectedBills } = await pool.query(
    `SELECT bill_id FROM vendor_payment_allocations WHERE vendor_payment_id=$1`,
    [id]
  );

  for (const r of affectedBills) {
    const outstanding = await getBillOutstanding(orgId, r.bill_id);
    if (outstanding !== null && outstanding > 0) {
      await pool.query(
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
}

module.exports = {
  createDraftVendorPayment,
  getVendorPaymentDetails,
  listVendorPayments,
  postVendorPayment,
  voidVendorPayment
};
