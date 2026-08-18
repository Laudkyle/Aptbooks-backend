const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { withTransaction } = require("../../../db/tx");

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
const { resolveLineTaxes, insertLineTaxDetails, loadLineTaxDetails, upsertDocumentTaxSnapshot, summarizeResolvedTaxes } = require("../../../shared/tax/multiTax");
const { summarizeLineTaxDetails } = require("../../../shared/tax/posting");
const { enrichLines, buildDetailMeta } = require("../_shared/detailEnrichment");
const { propagateDocumentWorkflowToJournal } = require("../_shared/workflowJournalAudit.service");
const fiscalizationSvc = require("../../integrations/fiscalization/fiscalization.service");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const {
  moneyUnits,
  moneyStringFromUnits,
  moneyNumber,
} = require("../../../shared/utils/financialMath");

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

async function prepareInvoiceLines({ client, orgId, payload, lines }) {
  let subtotalCents = 0n;
  let taxTotalCents = 0n;
  let withholdingTotalCents = 0n;
  const computed = [];

  for (const l of lines) {
    const qty = l.quantity ?? 1;
    const unitPrice = l.unitPrice ?? 0;
    const lineCents = multiplyQtyByUnitPriceToMoney(qty, unitPrice, 4, 2);
    const enteredLineAmount = bigIntToDecimalString(lineCents, 2);
    const tax = await resolveLineTaxes({
      client,
      orgId,
      line: l,
      defaultTaxableAmount: enteredLineAmount,
      context: {
        partnerId: payload.customerId,
        partnerType: "customer",
        transactionScope: "sales",
        documentType: "invoice",
        documentDate: payload.invoiceDate,
        jurisdictionId: payload.jurisdictionId || null,
        supplyType: l.supplyType || payload.supplyType || null,
        placeOfSupplyCountryCode: l.placeOfSupplyCountryCode || payload.placeOfSupplyCountryCode || null,
        industry: payload.industry || null,
        partnerCountryCode: payload.placeOfSupplyCountryCode || null
      }
    });
    const resolvedTaxSummary = summarizeResolvedTaxes(tax.components);
    const inclusiveTaxCents = parseDecimalToBigInt(resolvedTaxSummary.inclusiveNonWithholdingTax, 2);
    const taxableCents = lineCents - inclusiveTaxCents;
    const taxableAmount = bigIntToDecimalString(taxableCents, 2);
    subtotalCents += taxableCents;
    taxTotalCents += parseDecimalToBigInt(resolvedTaxSummary.totalNonWithholdingTax, 2);
    withholdingTotalCents += parseDecimalToBigInt(resolvedTaxSummary.withholdingTax, 2);
    computed.push({
      ...l,
      quantity: qty,
      unitPrice,
      lineTotal: enteredLineAmount,
      taxableAmount,
      taxAmount: resolvedTaxSummary.totalNonWithholdingTax,
      taxCodeId: tax.selectedTaxCodeId || null,
      taxDetails: tax.components,
      taxSnapshot: tax.snapshot
    });
  }

  const subtotal = bigIntToDecimalString(subtotalCents, 2);
  const taxTotal = bigIntToDecimalString(taxTotalCents, 2);
  const withholdingTotal = bigIntToDecimalString(withholdingTotalCents, 2);
  const total = bigIntToDecimalString(subtotalCents + taxTotalCents, 2);
  const netSettlementTotal = bigIntToDecimalString(subtotalCents + taxTotalCents - withholdingTotalCents, 2);
  return { computed, subtotal, taxTotal, withholdingTotal, netSettlementTotal, total };
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { computed, subtotal, taxTotal, withholdingTotal, netSettlementTotal, total } = await prepareInvoiceLines({ client, orgId, payload, lines: payload.lines });
    const baseCurrency = await getOrgBaseCurrency(client, orgId);

    const invoiceNo = await nextInvoiceNo(client, orgId);

    const { rows: invRows } = await client.query(
      `
      INSERT INTO invoices(
        organization_id, customer_id, invoice_no, invoice_date, due_date,
        currency_code, fx_rate, status, memo, subtotal, tax_total, total, withholding_total, net_settlement_total, created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,1,'draft',$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
      `,
      [orgId, payload.customerId, invoiceNo, payload.invoiceDate, payload.dueDate, baseCurrency, payload.memo || null, subtotal, taxTotal, total, withholdingTotal, netSettlementTotal, actorUserId]
    );

    const invoice = invRows[0];

    for (let i = 0; i < computed.length; i++) {
      const l = computed[i];
      const { rows } = await client.query(
        `
        INSERT INTO invoice_lines(
          invoice_id, line_no, description, quantity, unit_price, line_total, revenue_account_id, tax_code_id, tax_amount, taxable_amount, tax_snapshot_json
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        RETURNING *
        `,
        [invoice.id, i + 1, l.description, l.quantity, l.unitPrice, l.lineTotal, l.revenueAccountId, l.taxCodeId || null, l.taxAmount || 0, l.taxableAmount || 0, JSON.stringify(l.taxSnapshot || {})]
      );
      await insertLineTaxDetails({ client, tableName: 'invoice_line_tax_details', lineId: rows[0].id, details: l.taxDetails || [] });
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

async function getInvoiceDetails({ orgId, invoiceId, currentUserId }) {
  const { rows } = await pool.query(
    `SELECT 
      i.*,
      LOWER(d.workflow_state_code) AS workflow_status,
      CASE
        WHEN d.id IS NOT NULL
         AND LOWER(d.workflow_state_code) = 'submitted'
         AND (
           d.created_by_user_id IS NULL
           OR d.created_by_user_id IS DISTINCT FROM $3::uuid
           OR COALESCE(dws.allow_self_approval, FALSE)
           OR COALESCE(dws.creator_can_approve, FALSE)
         )
         AND EXISTS (
           SELECT 1
           FROM document_approvals da
           WHERE da.document_id = d.id
             AND da.status = 'PENDING'
             AND (
               NOT EXISTS (
                 SELECT 1
                 FROM approval_level_users alu_any
                 WHERE alu_any.approval_level_id = da.approval_level_id
               )
               OR EXISTS (
                 SELECT 1
                 FROM approval_level_users alu_me
                 WHERE alu_me.approval_level_id = da.approval_level_id
                   AND alu_me.user_id = $3::uuid
               )
             )
         )
        THEN TRUE
        ELSE FALSE
      END AS can_approve,
      CASE
        WHEN d.created_by_user_id = $3
        THEN COALESCE(dws.creator_can_post, FALSE)
        ELSE FALSE
      END AS can_post
     FROM invoices i
     LEFT JOIN documents d
       ON d.id = i.workflow_document_id
      AND d.organization_id = i.organization_id
     LEFT JOIN LATERAL (
       SELECT
         s.creator_can_approve,
         s.creator_can_post,
         s.allow_self_approval
       FROM document_workflow_statics s
       WHERE s.organization_id = i.organization_id
         AND (
           s.document_type_id = d.document_type_id
           OR s.document_type_id IS NULL
         )
       ORDER BY
         CASE
           WHEN s.document_type_id = d.document_type_id THEN 0
           ELSE 1
         END
       LIMIT 1
     ) dws ON TRUE
     WHERE i.organization_id = $1 
       AND i.id = $2`,
    [orgId, invoiceId, currentUserId]
  );

  if (!rows.length) throw new AppError(404, "Invoice not found");

  const invoice = rows[0];

  const { rows: lines } = await pool.query(
    `SELECT * 
     FROM invoice_lines 
     WHERE invoice_id = $1 
     ORDER BY line_no`,
    [invoiceId]
  );
  const taxMap = await loadLineTaxDetails({ client: pool, tableName: 'invoice_line_tax_details', lineIds: lines.map((l) => l.id) });

  const enrichedLines = await enrichLines({ client: pool, lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })) });

  const { rows: appliedRows } = await pool.query(
    `
    WITH receipt_alloc AS (
      SELECT COALESCE(SUM(cra.amount_applied + COALESCE(cra.discount_taken,0)),0) AS receipt_amount
      FROM customer_receipt_allocations cra
      JOIN customer_receipts cr ON cr.id = cra.customer_receipt_id
      WHERE cra.invoice_id=$1 AND cr.organization_id=$2 AND cr.status='posted'
    ), credit_alloc AS (
      SELECT COALESCE(SUM(cna.amount_applied),0) AS credit_amount
      FROM credit_note_applications cna
      JOIN credit_notes cn ON cn.id = cna.credit_note_id
      WHERE cna.invoice_id=$1 AND cna.organization_id=$2 AND cn.status='issued'
    )
    SELECT receipt_amount, credit_amount FROM receipt_alloc CROSS JOIN credit_alloc
    `,
    [invoiceId, orgId]
  );
  const receiptsAppliedUnits = moneyUnits(appliedRows[0]?.receipt_amount || "0");
  const creditsAppliedUnits = moneyUnits(appliedRows[0]?.credit_amount || "0");
  const paidUnits = receiptsAppliedUnits + creditsAppliedUnits;
  const settlementUnits = moneyUnits((invoice.net_settlement_total ?? invoice.total) || "0");
  const outstandingUnits = settlementUnits > paidUnits ? settlementUnits - paidUnits : 0n;
  const paid = moneyNumber(moneyStringFromUnits(paidUnits));
  const outstanding = moneyNumber(moneyStringFromUnits(outstandingUnits));

  return {
    invoice,
    lines: enrichedLines,
    detail_meta: buildDetailMeta({ header: invoice, lines: enrichedLines, extra: { paid, outstanding } }),
    allocations_summary: {
      paid,
      outstanding,
      credits_applied: moneyNumber(moneyStringFromUnits(creditsAppliedUnits)),
      receipts_applied: moneyNumber(moneyStringFromUnits(receiptsAppliedUnits)),
    }
  };
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
  const outstandingUnits = moneyUnits(r.inv_total || "0") - moneyUnits(r.receipts_allocated || "0") - moneyUnits(r.credit_applied || "0");
  return moneyStringFromUnits(outstandingUnits > 0n ? outstandingUnits : 0n);
}

async function assertCustomerCreditPolicyAllowsIssue({ orgId, customerId, invoiceTotal, client }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT credit_limit, hold_if_over FROM business_partner_credit_policies WHERE organization_id=$1 AND business_partner_id=$2`,
    [orgId, customerId]
  );
  if (!rows.length) return;
  const limitUnits = moneyUnits(rows[0].credit_limit || "0");
  const hold = rows[0].hold_if_over === true;
  if (!hold) return;
  if (limitUnits <= 0n) return;
  const outstandingUnits = moneyUnits(await getCustomerOutstandingAR({ orgId, customerId, client }));
  const invoiceUnits = moneyUnits(invoiceTotal || "0");
  if (outstandingUnits + invoiceUnits > limitUnits) {
    throw new AppError(409, `Customer is on credit hold: limit ${moneyStringFromUnits(limitUnits)} exceeded`);
  }
}

async function assertInvoiceApprovalStateAllowsIssue({ orgId, invoice, client }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "invoice",
    workflowDocumentId: invoice.workflow_document_id,
    client,
    actionLabel: "issue"
  });
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
    if (!["draft", "approved"].includes(invoice.status)) throw new AppError(409, "Only draft or approved invoices can be issued");

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

    const taxMap = await loadLineTaxDetails({ client, tableName: "invoice_line_tax_details", lineIds: lines.map((l) => l.id) });
    const revenueMap = new Map();
    const postingLines = lines.map((l) => ({ ...l, taxDetails: taxMap.get(l.id) || [] }));
    const taxSummary = summarizeLineTaxDetails(postingLines);
    const exactTaxSummary = taxSummary.exact;
    for (const l of postingLines) {
      await assertRevenueAccount({ orgId, accountId: l.revenue_account_id });
      const lineTax = exactTaxSummary.byLineId.get(l.id) || { nonRecoverable: 0 };
      const revenueUnits = moneyUnits(l.taxable_amount ?? l.line_total ?? "0") + moneyUnits(lineTax.nonRecoverable || "0");
      revenueMap.set(l.revenue_account_id, (revenueMap.get(l.revenue_account_id) || 0n) + revenueUnits);
    }

    const arAccountId = customer.default_receivable_account_id;
    const { rows: taxSettingsRows } = await client.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
    const outputTaxAccountId = taxSettingsRows[0]?.output_tax_account_id || null;

    const journalLines = [];
    for (const [accountId, amountUnits] of revenueMap.entries()) {
      journalLines.push({ accountId, debit: "0.00", credit: moneyStringFromUnits(amountUnits), description: `Revenue for ${invoice.invoice_no}` });
    }
    const outputTaxUnits = moneyUnits(exactTaxSummary.outputTax || "0");
    if (outputTaxUnits > 0n) {
      if (!outputTaxAccountId) throw new AppError(409, 'Output tax account is not configured (tax_settings.output_tax_account_id)');
      journalLines.push({ accountId: outputTaxAccountId, debit: "0.00", credit: moneyStringFromUnits(outputTaxUnits), description: `Output tax for ${invoice.invoice_no}` });
    }
    const withholdingReceivableUnits = moneyUnits(exactTaxSummary.withholdingReceivable || "0");
    if (withholdingReceivableUnits > 0n) {
      const withholdingReceivableAccountId = taxSettingsRows[0]?.withholding_tax_receivable_account_id || null;
      if (!withholdingReceivableAccountId) {
        throw new AppError(409, 'Withholding tax receivable account is not configured (tax_settings.withholding_tax_receivable_account_id)');
      }
      journalLines.push({ accountId: withholdingReceivableAccountId, debit: moneyStringFromUnits(withholdingReceivableUnits), credit: "0.00", description: `Withholding tax receivable for ${invoice.invoice_no}` });
    }

    const computedReceivableUnits = journalLines.reduce(
      (sum, line) => sum + moneyUnits(line.credit || "0") - moneyUnits(line.debit || "0"),
      0n
    );
    if (computedReceivableUnits <= 0n) {
      throw new AppError(400, `Computed receivable is invalid for ${invoice.invoice_no}`);
    }
    journalLines.unshift({ accountId: arAccountId, debit: moneyStringFromUnits(computedReceivableUnits), credit: "0.00", description: `A/R for ${invoice.invoice_no}` });

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

    await propagateDocumentWorkflowToJournal({
      client,
      journalId: draft.journalId,
      source: {
        orgId,
        workflowDocumentId: invoice.workflow_document_id || null,
        createdBy: invoice.created_by || actorUserId,
        submittedAt: invoice.submitted_at || null,
        submittedBy: invoice.submitted_by || null,
        approvedAt: invoice.approved_at || null,
        approvedBy: invoice.approved_by || null,
        updatedBy: actorUserId
      }
    });

    const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });

    await upsertDocumentTaxSnapshot({
      client,
      orgId,
      sourceType: "invoice",
      sourceId: invoiceId,
      journalEntryId: posted.journalId,
      snapshot: {
        header: invoice,
        lines: postingLines,
        taxSummary,
        journalLines
      }
    });

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

    // GRA-5: when fiscalization is enabled, create the immutable fiscal snapshot
    // in the same transaction as invoice issuance. Network transmission remains
    // out-of-transaction via the durable fiscal queue.
    await fiscalizationSvc.autoPrepareForSource({
      db: client, orgId, actorUserId, sourceType: 'invoice', sourceId: invoiceId
    });

    const issuedInvoice = afterRows[0];
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "invoice.issued",
      entityType: "invoices",
      entityId: invoiceId,
      after: issuedInvoice,
      client
    });

    return issuedInvoice;
  });
}

// -----------------------------------------------------------------------------
// Stage 5: Invoice approval workflow integration (Tier 10 Documents)
// -----------------------------------------------------------------------------

async function submitInvoiceForApproval({ orgId, actorUserId, invoiceId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM invoices WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [orgId, invoiceId]
    );
    if (!rows.length) throw new AppError(404, "Invoice not found");
    const invoice = rows[0];

    const { rows: lines } = await client.query(
      `SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_no`,
      [invoiceId]
    );

    await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "invoice",
      entity: invoice,
      workflowDocumentId: invoice.workflow_document_id,
      snapshot: {
        header: invoice,
        lines,
        totals: {
          subtotal: invoice.subtotal,
          total: invoice.total
        },
        meta: {
          status: invoice.status,
          currency_code: invoice.currency_code
        }
      },
      client,
      persistWorkflowDocumentId: async (documentId) => {
        await client.query(
          `UPDATE invoices SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
          [orgId, invoiceId, documentId]
        );
      }
    });

    const { rows: updated } = await client.query(
      `
      UPDATE invoices
      SET status='submitted',
          submitted_at=NOW(),
          submitted_by=$3,
          approved_at=NULL,
          approved_by=NULL,
          rejected_at=NULL,
          rejected_by=NULL,
          rejection_reason=NULL,
          updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *
      `,
      [orgId, invoiceId, actorUserId]
    );

    return updated[0];
  });
}

async function approveInvoiceWorkflow({ orgId, actorUserId, invoiceId, comment }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, workflow_document_id, created_by FROM invoices WHERE organization_id=$1 AND id=$2`,
      [orgId, invoiceId]
    );
    if (!rows.length) throw new AppError(404, "Invoice not found");
    const invoice = rows[0];
    if (!invoice.workflow_document_id) throw new AppError(409, "Invoice has no workflow document");

    const result = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "invoice",
      workflowDocumentId: invoice.workflow_document_id,
      creatorUserId: invoice.created_by || null,
      comment: comment || null,
      client
    });

    if (result?.next) {
      const { rows: updated } = await client.query(
        `UPDATE invoices SET status='submitted', updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [orgId, invoiceId]
      );
      return updated[0];
    }

    const { rows: updated } = await client.query(
      `UPDATE invoices SET status='approved', approved_at=NOW(), approved_by=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, invoiceId, actorUserId]
    );
    return updated[0];
  });
}

async function rejectInvoiceWorkflow({ orgId, actorUserId, invoiceId, comment }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, workflow_document_id, created_by FROM invoices WHERE organization_id=$1 AND id=$2`,
      [orgId, invoiceId]
    );
    if (!rows.length) throw new AppError(404, "Invoice not found");
    const invoice = rows[0];
    if (!invoice.workflow_document_id) throw new AppError(409, "Invoice has no workflow document");

    await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "invoice",
      workflowDocumentId: invoice.workflow_document_id,
      creatorUserId: invoice.created_by || null,
      comment: comment || null,
      client
    });

    const { rows: updated } = await client.query(
      `UPDATE invoices SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,
      [orgId, invoiceId, actorUserId, comment || null]
    );
    return updated[0];
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

    const { rows: settlementRows } = await client.query(
      `SELECT 1
         FROM customer_receipt_allocations a
         JOIN customer_receipts r ON r.id=a.customer_receipt_id
        WHERE a.invoice_id=$1 AND r.organization_id=$2 AND r.status='posted'
        LIMIT 1`,
      [invoiceId, orgId]
    );
    if (settlementRows.length) {
      throw new AppError(409, "Cannot void an invoice with posted receipts; void the receipts first");
    }

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

    const result = { invoice: rows[0], reversalJournalId: out.reversalJournalId };
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: "invoice.voided",
      entityType: "invoices",
      entityId: invoiceId,
      after: result,
      client
    });

    return result;
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
