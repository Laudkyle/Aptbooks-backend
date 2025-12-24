const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

const periodIF = require("../../../interfaces/periodManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");
const partnerIF = require("../../../interfaces/partnerManagement.interface");

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
  const computed = lines.map((l) => {
    const qty = Number(l.quantity || 1);
    const up = Number(l.unitPrice || 0);
    const lineTotal = Number((qty * up).toFixed(2));
    return { ...l, quantity: qty, unitPrice: up, lineTotal };
  });
  const subtotal = Number(computed.reduce((s, l) => s + l.lineTotal, 0).toFixed(2));
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

    const billNo = await repo.nextBillNo(client, orgId);
    const bill = await repo.insertBill(client, {
      orgId,
      vendorId: payload.vendorId,
      billNo,
      billDate: payload.billDate,
      dueDate: payload.dueDate,
      memo: payload.memo,
      subtotal,
      total
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
  const { bill, lines } = await getBillDetails({ orgId, billId });
  if (bill.status !== "draft") throw new AppError(409, "Only draft bills can be issued");
  if (!lines.length) throw new AppError(400, "Bill has no lines");

  const vendor = await partnerIF.getPartnerForOrg({ orgId, partnerId: bill.vendor_id });
  if (!vendor.default_payable_account_id) throw new AppError(400, "Vendor missing defaultPayableAccountId");

  const period = await periodIF.findOpenPeriodForDate({ orgId, date: bill.bill_date });

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
    payload: {
      periodId: period.id,
      entryDate: bill.bill_date,
      typeCode: "GENERAL",
      memo: `Bill ${bill.bill_no}` + (bill.memo ? `: ${bill.memo}` : ""),
      idempotencyKey,
      lines: journalLines
    }
  });

  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });

  const { rows } = await pool.query(
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
}

async function voidBill({ orgId, actorUserId, billId, reason }) {
  const bill = await repo.getBillById(orgId, billId);
  if (!bill) throw new AppError(404, "Bill not found");
  if (bill.status !== "issued" && bill.status !== "paid") throw new AppError(409, "Only issued/paid bills can be voided");
  if (!bill.journal_entry_id) throw new AppError(500, "Bill missing journal reference");

  const out = await journalIF.voidPostedJournal({ orgId, journalId: bill.journal_entry_id, actorUserId, reason });

  const { rows } = await pool.query(
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
}

module.exports = { createDraftBill, getBillDetails, listBills, issueBill, voidBill };
