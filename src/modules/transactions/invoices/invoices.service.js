const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

const periodIF = require("../../../interfaces/periodManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");
const partnerIF = require("../../../interfaces/partnerManagement.interface");

async function assertRevenueAccount({ orgId, accountId }) {
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, "Invalid revenueAccountId");
  if (!rows[0].is_postable) throw new AppError(400, "Non-postable revenue account used");
  if (rows[0].status !== "active") throw new AppError(400, "Inactive revenue account used");
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

async function nextInvoiceNo(client, orgId) {
  await client.query(
    `INSERT INTO invoice_sequences(organization_id, next_no)
     VALUES ($1, 1) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId]
  );

  const { rows } = await client.query(
    `UPDATE invoice_sequences SET next_no = next_no + 1, updated_at=NOW()
     WHERE organization_id=$1 RETURNING next_no`,
    [orgId]
  );

  const no = BigInt(rows[0].next_no) - 1n;
  return `INV-${String(no).padStart(6, "0")}`;
}

async function createDraftInvoice({ orgId, actorUserId, payload }) {
  // CHANGED: use formal interface helper
  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: payload.customerId });

  if (!customer.default_receivable_account_id) {
    throw new AppError(400, "Customer missing defaultReceivableAccountId");
  }
  if (payload.dueDate < payload.invoiceDate) {
    throw new AppError(400, "dueDate must be on or after invoiceDate");
  }

  for (const l of payload.lines) await assertRevenueAccount({ orgId, accountId: l.revenueAccountId });

  const { computed, subtotal, total } = calcTotals(payload.lines);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const invoiceNo = await nextInvoiceNo(client, orgId);

    const { rows: invRows } = await client.query(
      `
      INSERT INTO invoices(
        organization_id, customer_id, invoice_no, invoice_date, due_date,
        currency_code, fx_rate, status, memo, subtotal, total
      )
      VALUES ($1,$2,$3,$4,$5,'GHS',1,'draft',$6,$7,$8)
      RETURNING *
      `,
      [orgId, payload.customerId, invoiceNo, payload.invoiceDate, payload.dueDate, payload.memo || null, subtotal, total]
    );

    const invoice = invRows[0];

    for (let i = 0; i < computed.length; i++) {
      const l = computed[i];
      await client.query(
        `
        INSERT INTO invoice_lines(
          invoice_id, line_no, description, quantity, unit_price, line_total, revenue_account_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [invoice.id, i + 1, l.description, l.quantity, l.unitPrice, l.lineTotal, l.revenueAccountId]
      );
    }

    await client.query("COMMIT");
    return invoice;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}


async function getInvoiceDetails({ orgId, invoiceId }) {
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2`,
    [orgId, invoiceId]
  );
  if (!rows.length) throw new AppError(404, "Invoice not found");
  const invoice = rows[0];

  const { rows: lines } = await pool.query(
    `SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`,
    [invoiceId]
  );

  return { invoice, lines };
}

async function listInvoices({ orgId, query }) {
  const params = [orgId];
  const where = ["organization_id=$1"];
  let i = 2;

  if (query?.status) { where.push(`status=$${i++}`); params.push(query.status); }
  if (query?.customerId) { where.push(`customer_id=$${i++}`); params.push(query.customerId); }

  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE ${where.join(" AND ")} ORDER BY invoice_date DESC, created_at DESC`,
    params
  );
  return rows;
}

async function issueInvoice({ orgId, actorUserId, invoiceId }) {
  const { invoice, lines } = await getInvoiceDetails({ orgId, invoiceId });
  if (invoice.status !== "draft") throw new AppError(409, "Only draft invoices can be issued");
  if (!lines.length) throw new AppError(400, "Invoice has no lines");

  // CHANGED: validate customer fully (active + type) via interface
  const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: invoice.customer_id });

  if (!customer.default_receivable_account_id) {
    throw new AppError(400, "Customer missing defaultReceivableAccountId");
  }

  const period = await periodIF.findOpenPeriodForDate({ orgId, date: invoice.invoice_date });

  // Aggregate revenue by account
  const revenueMap = new Map();
  for (const l of lines) {
    await assertRevenueAccount({ orgId, accountId: l.revenue_account_id });
    revenueMap.set(l.revenue_account_id, (revenueMap.get(l.revenue_account_id) || 0) + Number(l.line_total));
  }

  const total = Number(invoice.total);
  const arAccountId = customer.default_receivable_account_id;

  const journalLines = [{ accountId: arAccountId, debit: total, credit: 0, description: `A/R for ${invoice.invoice_no}` }];
  for (const [accountId, amt] of revenueMap.entries()) {
    journalLines.push({ accountId, debit: 0, credit: Number(amt.toFixed(2)), description: `Revenue for ${invoice.invoice_no}` });
  }

  const idempotencyKey = `invoice:${invoiceId}:issue`;

  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: period.id,
      entryDate: invoice.invoice_date,
      typeCode: "GENERAL",
      memo: `Invoice ${invoice.invoice_no}` + (invoice.memo ? `: ${invoice.memo}` : ""),
      idempotencyKey,
      lines: journalLines
    }
  });

  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId });

  const { rows: afterRows } = await pool.query(
    `
    UPDATE invoices
    SET status='issued',
        period_id=$3,
        journal_entry_id=$4,
        issued_at=NOW(),
        issued_by=$5,
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, invoiceId, period.id, posted.journalId, actorUserId]
  );

  return afterRows[0];
}

async function voidInvoice({ orgId, actorUserId, invoiceId, reason }) {
  const { invoice } = await getInvoiceDetails({ orgId, invoiceId });
  if (invoice.status !== "issued") throw new AppError(409, "Only issued invoices can be voided");
  if (!invoice.journal_entry_id) throw new AppError(500, "Invoice missing journal reference");

  const out = await journalIF.voidPostedJournal({
    orgId,
    journalId: invoice.journal_entry_id,
    actorUserId,
    reason
  });

  const { rows } = await pool.query(
    `
    UPDATE invoices
    SET status='voided',
        voided_at=NOW(),
        voided_by=$3,
        void_reason=$4,
        reversal_journal_entry_id=$5,
        updated_at=NOW()
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, invoiceId, actorUserId, reason, out.reversalJournalId || null]
  );

  return { invoice: rows[0], reversalJournalId: out.reversalJournalId };
}

module.exports = {
  createDraftInvoice,
  getInvoiceDetails,
  listInvoices,
  issueInvoice,
  voidInvoice
};
