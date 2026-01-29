const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
  const { withTransaction } = require("../../../db/tx");

const periodIF = require("../../../interfaces/periodManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");
const documentsSvc = require("../../../workflow/documents/documents.service");
const partnerIF = require("../../../interfaces/partnerManagement.interface");

const {
  multiplyQtyByUnitPriceToMoney,
  bigIntToDecimalString
} = require("../../../shared/utils/money");

async function getOrgBaseCurrency(client, orgId) {
  const { rows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, "Invalid organization");
  return rows[0].base_currency_code;
}

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
  let subtotalCents = 0n;

  const computed = lines.map((l) => {
    const qty = l.quantity ?? 1;
    const unitPrice = l.unitPrice ?? 0;

    // quantity in NUMERIC(18,4), unit price in NUMERIC(18,2)
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

    const baseCurrency = await getOrgBaseCurrency(client, orgId);

    const invoiceNo = await nextInvoiceNo(client, orgId);

    const { rows: invRows } = await client.query(
      `
      INSERT INTO invoices(
        organization_id, customer_id, invoice_no, invoice_date, due_date,
        currency_code, fx_rate, status, memo, subtotal, total
      )
      VALUES ($1,$2,$3,$4,$5,$6,1,'draft',$7,$8,$9)
      RETURNING *
      `,
      [orgId, payload.customerId, invoiceNo, payload.invoiceDate, payload.dueDate, baseCurrency, payload.memo || null, subtotal, total]
    );

    const invoice = invRows[0];

    for (let i = 0;i < computed.length;i++) {
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
  `SELECT 
    i.*,
    bp.name as customer_name
   FROM invoices i
   LEFT JOIN business_partners bp ON i.customer_id = bp.id
   WHERE i.organization_id=$1 AND i.id=$2`,
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
  const where = ["i.organization_id=$1"]; // Added i. prefix
  let i = 2;

  if (query?.status) { 
    where.push(`i.status=$${i++}`);
    params.push(query.status);
  }
  if (query?.customerId) { 
    where.push(`i.customer_id=$${i++}`);
    params.push(query.customerId);
  }

  const { rows } = await pool.query(
    `SELECT 
      i.*,
      bp.name as customer_name
     FROM invoices i
     LEFT JOIN business_partners bp ON i.customer_id = bp.id
     WHERE ${where.join(" AND ")} 
     ORDER BY i.invoice_date DESC, i.created_at DESC`,
    params
  );
  return rows;
}
async function getCustomerOutstandingAR({ orgId, customerId, client }) {
  const db = client || pool;
  const { rows } = await db.query(
    `
    WITH inv AS (
      SELECT id, total
      FROM invoices
      WHERE organization_id=$1 AND customer_id=$2 AND status IN ('issued','paid')
    ), ralloc AS (
      SELECT cra.invoice_id, SUM(cra.amount_applied + COALESCE(cra.discount_taken,0)) AS allocated
      FROM customer_receipt_allocations cra
      JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
      WHERE cr.organization_id=$1 AND cr.status='posted'
      GROUP BY cra.invoice_id
    ), cnalloc AS (
      SELECT cna.invoice_id, SUM(cna.amount_applied) AS applied
      FROM credit_note_applications cna
      JOIN credit_notes cn ON cn.id = cna.credit_note_id
      WHERE cna.organization_id=$1 AND cn.status='issued'
      GROUP BY cna.invoice_id
    )
    SELECT
      COALESCE(SUM(inv.total),0) AS inv_total,
      COALESCE(SUM(ralloc.allocated),0) AS receipts_allocated,
      COALESCE(SUM(cnalloc.applied),0) AS credit_applied
    FROM inv
    LEFT JOIN ralloc ON ralloc.invoice_id = inv.id
    LEFT JOIN cnalloc ON cnalloc.invoice_id = inv.id
    `,
    [orgId, customerId]
  );
  const r = rows[0] || {};
  const out = Number(r.inv_total || 0) - Number(r.receipts_allocated || 0) - Number(r.credit_applied || 0);
  return Number(out.toFixed(2));
}

async function assertCustomerCreditPolicyAllowsIssue({ orgId, customerId, invoiceTotal, client }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT credit_limit, hold_if_over FROM business_partner_credit_policies WHERE organization_id=$1 AND business_partner_id=$2`,
    [orgId, customerId]
  );
  if (!rows.length) return;
  const limit = Number(rows[0].credit_limit || 0);
  const hold = rows[0].hold_if_over === true;
  if (!hold) return;
  if (!limit || limit <= 0) return;
  const outstanding = await getCustomerOutstandingAR({ orgId, customerId, client });
  if ((outstanding + Number(invoiceTotal || 0)) > limit + 1e-9) {
    throw new AppError(409, `Customer is on credit hold: limit ${limit.toFixed(2)} exceeded`);
  }
}

async function assertInvoiceApprovalStateAllowsIssue({ orgId, invoice, client }) {
  // Only enforce if an approval ladder exists for the INVOICE document type.
  const db = client || pool;
  const { rows: dtRows } = await db.query(
    `SELECT id FROM document_types WHERE organization_id=$1 AND code='INVOICE' AND is_active=TRUE`,
    [orgId]
  );
  if (!dtRows.length) return;// No doc type configured => no enforcement

  const dtId = dtRows[0].id;
  const { rows: ladder } = await db.query(
    `SELECT 1 FROM document_type_approval_levels WHERE document_type_id=$1 LIMIT 1`,
    [dtId]
  );
  if (!ladder.length) return;// No ladder => no enforcement

  if (!invoice.workflow_document_id) {
    throw new AppError(409, "Invoice requires approval before issue (missing workflow document)");
  }

  const { rows: docRows } = await db.query(
    `SELECT workflow_state_code FROM documents WHERE organization_id=$1 AND id=$2`,
    [orgId, invoice.workflow_document_id]
  );
  if (!docRows.length) throw new AppError(409, "Invoice workflow document not found");
  if (docRows[0].workflow_state_code !== 'APPROVED') {
    throw new AppError(409, `Invoice requires approval before issue (current state: ${docRows[0].workflow_state_code})`);
  }
}

async function issueInvoice({ orgId, actorUserId, invoiceId }) {
  const { withTransaction } = require("../../../db/tx");
  return withTransaction(async (client) => {
    const { rows: invRows } = await client.query(
      `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, invoiceId]
    );
    if (!invRows.length) throw new AppError(404, "Invoice not found");
    const invoice = invRows[0];
    if (invoice.status !== "draft") throw new AppError(409, "Only draft invoices can be issued");

    await assertInvoiceApprovalStateAllowsIssue({ orgId, invoice, client });

    const { rows: lines } = await client.query(
      `SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`,
      [invoiceId]
    );
    if (!lines.length) throw new AppError(400, "Invoice has no lines");

    const customer = await partnerIF.getActiveCustomerForOrg({ orgId, customerId: invoice.customer_id, client });
    if (!customer.default_receivable_account_id) {
      throw new AppError(400, "Customer missing defaultReceivableAccountId");
    }

    await assertCustomerCreditPolicyAllowsIssue({ orgId, customerId: invoice.customer_id, invoiceTotal: invoice.total, client });

    const period = await periodIF.findOpenPeriodForDate({ orgId, date: invoice.invoice_date, client });

    const revenueMap = new Map();
    for (const l of lines) {
      await assertRevenueAccount({ orgId, accountId: l.revenue_account_id });
      revenueMap.set(l.revenue_account_id, (revenueMap.get(l.revenue_account_id) || 0) + Number(l.line_total));
    }

    const total = Number(invoice.total);
    const arAccountId = customer.default_receivable_account_id;

    const journalLines = [
      { accountId: arAccountId, debit: total, credit: 0, description: `A/R for ${invoice.invoice_no}` }
    ];
    for (const [accountId, amt] of revenueMap.entries()) {
      journalLines.push({ accountId, debit: 0, credit: Number(amt.toFixed(2)), description: `Revenue for ${invoice.invoice_no}` });
    }

    const idempotencyKey = `invoice:${invoiceId}:issue`;

    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      client,
      payload: {
        periodId: period.id,
        entryDate: invoice.invoice_date,
        typeCode: "GENERAL",
        memo: `Invoice ${invoice.invoice_no}` + (invoice.memo ? `: ${invoice.memo}` : ""),
        idempotencyKey,
        lines: journalLines
      }
    });

    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });

    const { rows: afterRows } = await client.query(
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
  });
}

// -----------------------------------------------------------------------------
// Stage 5: Invoice approval workflow integration (Tier 10 Documents)
// -----------------------------------------------------------------------------

async function ensureDocumentType({ orgId, code, name, client }) {
  // Attempt to find, otherwise create (no ladder is created automatically)
  const { rows } = await client.query(
    `SELECT id FROM document_types WHERE organization_id=$1 AND code=$2 AND is_active=TRUE`,
    [orgId, code]
  );
  if (rows.length) return rows[0].id;
  const created = await documentsSvc.createDocumentType({
    orgId,
    payload: { code, name, description: `${name} approvals` }
  });
  return created.id;
}

async function submitInvoiceForApproval({ orgId, actorUserId, invoiceId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, invoiceId]
    );
    if (!rows.length) throw new AppError(404, "Invoice not found");
    const invoice = rows[0];

    // Create or reuse a workflow document
    let documentId = invoice.workflow_document_id;

    if (!documentId) {
      const documentTypeId = await ensureDocumentType({ orgId, code: "INVOICE", name: "Invoice", client });
      const doc = await documentsSvc.createDocument({
        orgId,
        userId: actorUserId,
        payload: {
          document_type_id: documentTypeId,
          title: `Invoice ${invoice.invoice_no}`,
          description: invoice.memo || null,
          entity_type: "invoice",
          entity_id: invoice.id,
          entity_ref: invoice.invoice_no
        }
      });
      documentId = doc.id;

      await client.query(
        `UPDATE invoices SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
        [orgId, invoiceId, documentId]
      );
    }
    console.log("reached",documentId)

    // Snapshot current invoice + lines into version 1 (JSON)
    const { rows: lines } = await client.query(
      `SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`,
      [invoiceId]
    );
    const snapshot = {
      invoice,
      lines,
      snapshot_at: new Date().toISOString()
    };

    const buf = Buffer.from(JSON.stringify(snapshot, null, 2), "utf8");
    await documentsSvc.addVersionFromBuffer({
      orgId,
      documentId,
      userId: actorUserId,
      originalFilename: `invoice-${invoice.invoice_no}.json`,
      mimeType: "application/json",
      buffer: buf
    });

    const submitted = await documentsSvc.submitDocument({ orgId, documentId });
    console.log("submitted")
    return submitted.document;
  });
}

async function approveInvoiceWorkflow({ orgId, actorUserId, invoiceId, comment }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT workflow_document_id FROM invoices WHERE organization_id=$1 AND id=$2`,
      [orgId, invoiceId]
    );
    if (!rows.length) throw new AppError(404, "Invoice not found");
    if (!rows[0].workflow_document_id) throw new AppError(409, "Invoice has no workflow document");
    const result = await documentsSvc.approveDocument({
      orgId,
      documentId: rows[0].workflow_document_id,
      userId: actorUserId,
      comment: comment || null
    });
    return result.document;
  });
}

async function rejectInvoiceWorkflow({ orgId, actorUserId, invoiceId, comment }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT workflow_document_id FROM invoices WHERE organization_id=$1 AND id=$2`,
      [orgId, invoiceId]
    );
    if (!rows.length) throw new AppError(404, "Invoice not found");
    if (!rows[0].workflow_document_id) throw new AppError(409, "Invoice has no workflow document");
    const result = await documentsSvc.rejectDocument({
      orgId,
      documentId: rows[0].workflow_document_id,
      userId: actorUserId,
      comment: comment || null
    });
    return result.document;
  });
}

async function voidInvoice({ orgId, actorUserId, invoiceId, reason }) {
  return withTransaction(async (client) => {
    const { rows: invRows } = await client.query(
      `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, invoiceId]
    );
    if (!invRows.length) throw new AppError(404, "Invoice not found");
    const invoice = invRows[0];
    if (invoice.status !== "issued") throw new AppError(409, "Only issued invoices can be voided");
    if (!invoice.journal_entry_id) throw new AppError(500, "Invoice missing journal reference");

    const out = await journalIF.voidPostedJournal({
      orgId,
      journalId: invoice.journal_entry_id,
      actorUserId,
      reason,
      client
    });

    const { rows } = await client.query(
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
  });
}

module.exports = {
  createDraftInvoice,
  getInvoiceDetails,
  listInvoices,
  submitInvoiceForApproval,
  approveInvoiceWorkflow,
  rejectInvoiceWorkflow,
  issueInvoice,
  voidInvoice
};
