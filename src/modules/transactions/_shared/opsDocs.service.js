const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const documentableSvc = require("../../../workflow/documents/documentable.service");
const partnerIF = require("../../../interfaces/partnerManagement.interface");
const { buildOperationalDocumentJournal } = require("./operationalDocPosting.service");
const { runApprovalPostingHook } = require("./approvalPostingHooks");
const repo = require("./opsDocs.repository");
const { resolveLineTaxes, round2: roundTax2, loadLineTaxDetails, summarizeResolvedTaxes } = require("../../../shared/tax/multiTax");
const { multiplyQtyByUnitPriceToMoney, parseDecimalToBigInt, bigIntToDecimalString } = require("../../../shared/utils/money");
const { enrichLines, buildDetailMeta } = require("./detailEnrichment");
const journalIF = require("../../../interfaces/journalPosting.interface");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const { assertSourceNotInFinalizedTaxReturn } = require("../../../shared/tax/taxVoidCompliance");

async function getOrgBaseCurrency(client, orgId) {
  const { rows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, "Invalid organization");
  return rows[0].base_currency_code;
}

async function assertPostableActiveAccount({ orgId, accountId }) {
  if (!accountId) return;
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `Invalid account: ${accountId}`);
  if (!rows[0].is_postable) throw new AppError(400, "Non-postable account used");
  if (rows[0].status !== "active") throw new AppError(400, "Inactive account used");
}

async function assertTaxCodeBelongsToOrg({ orgId, taxCodeId }) {
  if (!taxCodeId) return null;
  const { rows } = await pool.query(
    `
    SELECT id, code, name, tax_type, rate, direction, box_code, status,
           effective_from, effective_to
    FROM tax_codes
    WHERE organization_id=$1 AND id=$2
    `,
    [orgId, taxCodeId]
  );
  if (!rows.length) throw new AppError(400, `Invalid tax code: ${taxCodeId}`);
  const taxCode = rows[0];
  if (taxCode.status !== "active") throw new AppError(400, "Inactive tax code used");
  return taxCode;
}

function round2(n) {
  return Number((Number(n || 0)).toFixed(2));
}

async function computeLinesWithTax({ client, orgId, lines = [], context = {} }) {
  let subtotalCents = 0n;
  let taxTotalCents = 0n;
  const computed = [];

  for (const line of (lines || [])) {
    const quantity = line.quantity == null ? 1 : line.quantity;
    const unitPrice = line.unitPrice == null ? 0 : line.unitPrice;
    const enteredLineCents = line.lineTotal == null
      ? multiplyQtyByUnitPriceToMoney(quantity, unitPrice, 4, 2)
      : parseDecimalToBigInt(line.lineTotal, 2);
    const enteredLineAmount = bigIntToDecimalString(enteredLineCents, 2);

    const tax = await resolveLineTaxes({
      client,
      orgId,
      line,
      defaultTaxableAmount: enteredLineAmount,
      context: {
        ...context,
        supplyType: line.supplyType || context.supplyType || null,
        placeOfSupplyCountryCode: line.placeOfSupplyCountryCode || context.placeOfSupplyCountryCode || null,
      }
    });
    const resolvedTaxSummary = summarizeResolvedTaxes(tax.components);
    const taxableCents = line.taxableAmount == null
      ? enteredLineCents - parseDecimalToBigInt(resolvedTaxSummary.inclusiveNonWithholdingTax, 2)
      : parseDecimalToBigInt(line.taxableAmount, 2);
    const taxableAmount = bigIntToDecimalString(taxableCents, 2);
    const taxAmount = resolvedTaxSummary.totalNonWithholdingTax;

    subtotalCents += taxableCents;
    taxTotalCents += parseDecimalToBigInt(taxAmount, 2);

    computed.push({
      ...line,
      quantity,
      unitPrice,
      taxableAmount,
      taxAmount,
      taxCodeId: tax.selectedTaxCodeId || null,
      taxDetails: tax.components,
      lineTotal: enteredLineAmount
    });
  }

  return {
    lines: computed,
    subtotal: bigIntToDecimalString(subtotalCents, 2),
    taxTotal: bigIntToDecimalString(taxTotalCents, 2),
    total: bigIntToDecimalString(subtotalCents + taxTotalCents, 2)
  };
}

function createOpsDocService(config) {
  const {
    moduleCode,
    entityType,
    prefix,
    partnerRole,
    finalAction = "issue",
    defaultMeta = () => ({}),
    runPostingHookOnApproval = finalAction === "post"
  } = config;

  async function assertCounterparty({ orgId, partnerId }) {
    if (!partnerId) return null;
    const partner = await partnerIF.getPartnerForOrg({ orgId, partnerId });
    if (!partner) throw new AppError(404, "Partner not found");
    if (partnerRole && partner.type !== partnerRole) {
      throw new AppError(400, `Partner is not a ${partnerRole}`);
    }
    if (partner.status !== "active") throw new AppError(400, "Partner is inactive");
    return partner;
  }

  async function createDraft({ orgId, actorUserId, payload }) {
    await assertCounterparty({ orgId, partnerId: payload.partnerId || null });
    await assertPostableActiveAccount({ orgId, accountId: payload.cashAccountId || null });
    await assertPostableActiveAccount({ orgId, accountId: payload.primaryAccountId || null });
    for (const line of payload.lines || []) {
      await assertPostableActiveAccount({ orgId, accountId: line.accountId || null });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const computed = await computeLinesWithTax({
        client,
        orgId,
        lines: payload.lines || [],
        context: {
          partnerId: payload.partnerId || null,
          partnerType: partnerRole || null,
          transactionScope: partnerRole === 'customer' ? 'sales' : 'purchases',
          documentType: moduleCode,
          documentDate: payload.date || null,
          jurisdictionId: payload.jurisdictionId || null,
          pricingMode: payload.pricingMode || payload.pricing_mode || null,
          supplyType: payload.supplyType || null,
          placeOfSupplyCountryCode: payload.placeOfSupplyCountryCode || null,
          industry: payload.industry || null
        }
      });
      const amountTotal = payload.amountTotal == null ? computed.total : bigIntToDecimalString(parseDecimalToBigInt(payload.amountTotal, 2), 2);
      const baseCurrency = payload.currencyCode || await getOrgBaseCurrency(client, orgId);
      const documentNo = await repo.nextDocumentNo(client, orgId, moduleCode, prefix);
      const doc = await repo.insertDocument(client, {
        orgId,
        moduleCode,
        documentNo,
        partnerId: payload.partnerId || null,
        employeeId: payload.employeeId || null,
        date: payload.date,
        dueDate: payload.dueDate || null,
        memo: payload.memo || null,
        reference: payload.reference || null,
        sourceDocumentId: payload.sourceDocumentId || null,
        cashAccountId: payload.cashAccountId || null,
        primaryAccountId: payload.primaryAccountId || null,
        amountTotal,
        subtotal: computed.subtotal,
        taxTotal: computed.taxTotal,
        currencyCode: baseCurrency,
        meta: { ...(defaultMeta(payload) || {}), ...(payload.meta || {}) },
        createdBy: actorUserId,
        status: "draft"
      });

      for (let i = 0; i < computed.lines.length; i++) {
        await repo.insertLine(client, doc.id, i + 1, computed.lines[i]);
      }

      await client.query("COMMIT");
      return doc;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async function updateDraft({ orgId, actorUserId, documentId, payload }) {
    await assertCounterparty({ orgId, partnerId: payload.partnerId || null });
    await assertPostableActiveAccount({ orgId, accountId: payload.cashAccountId || null });
    await assertPostableActiveAccount({ orgId, accountId: payload.primaryAccountId || null });
    for (const line of payload.lines || []) {
      await assertPostableActiveAccount({ orgId, accountId: line.accountId || null });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const header = await repo.getLockedDocument(client, orgId, documentId);
      if (!header || header.module_code !== moduleCode) throw new AppError(404, 'Document not found');
      if (header.status !== 'draft') throw new AppError(409, `Only draft ${moduleCode} documents can be edited`);

      const computed = await computeLinesWithTax({
        client, orgId, lines: payload.lines || [],
        context: {
          partnerId: payload.partnerId || null,
          partnerType: partnerRole || null,
          transactionScope: partnerRole === 'customer' ? 'sales' : 'purchases',
          documentType: moduleCode,
          documentDate: payload.date || null,
          jurisdictionId: payload.jurisdictionId || null,
          pricingMode: payload.pricingMode || payload.pricing_mode || null,
          supplyType: payload.supplyType || null,
          placeOfSupplyCountryCode: payload.placeOfSupplyCountryCode || null,
          industry: payload.industry || null
        }
      });
      const amountTotal = payload.amountTotal == null ? computed.total : bigIntToDecimalString(parseDecimalToBigInt(payload.amountTotal, 2), 2);
      const meta = { ...(defaultMeta(payload) || {}), ...(payload.meta || {}) };
      const { rows } = await client.query(
        `UPDATE operational_documents
            SET counterparty_partner_id=$3, employee_id=$4, document_date=$5, due_date=$6,
                memo=$7, reference=$8, source_document_id=$9, cash_account_id=$10,
                primary_account_id=$11, amount_total=$12, subtotal=$13, tax_total=$14,
                meta=$15::jsonb, updated_by=$16, updated_at=NOW()
          WHERE organization_id=$1 AND id=$2 RETURNING *`,
        [orgId, documentId, payload.partnerId || null, payload.employeeId || null, payload.date, payload.dueDate || null,
         payload.memo || null, payload.reference || null, payload.sourceDocumentId || null, payload.cashAccountId || null,
         payload.primaryAccountId || null, amountTotal, computed.subtotal, computed.taxTotal, JSON.stringify(meta), actorUserId]
      );
      await client.query(`DELETE FROM operational_document_lines WHERE document_id=$1`, [documentId]);
      for (let i = 0; i < computed.lines.length; i++) await repo.insertLine(client, documentId, i + 1, computed.lines[i]);
      await writeAudit({ organizationId: orgId, actorUserId, action: `${entityType}.draft_updated`, entityType, entityId: documentId, before: header, after: rows[0], client });
      await client.query('COMMIT');
      return rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function list({ orgId, query }) {
    return repo.listDocuments({ orgId, moduleCode, query });
  }

  async function getDetails({ orgId, documentId, currentUserId }) {
    const header = await repo.getDocumentById(orgId, documentId, currentUserId);
    if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
    const lines = await repo.getDocumentLines(documentId);
    const taxMap = await loadLineTaxDetails({ client: pool, tableName: "operational_doc_line_tax_details", lineIds: lines.map((l) => l.id) });
    const enrichedLines = await enrichLines({ client: pool, lines: lines.map((l) => ({ ...l, taxes: taxMap.get(l.id) || [] })) });
    return { header, lines: enrichedLines, detail_meta: buildDetailMeta({ header, lines: enrichedLines }) };
  }

  async function submitForApproval({ orgId, actorUserId, documentId }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const header = await repo.getLockedDocument(client, orgId, documentId);
      if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
      if (!["draft", "rejected"].includes(header.status)) throw new AppError(409, "Only draft or rejected documents can be submitted");
      const lines = await repo.getDocumentLines(documentId, client);

      const workflowDocument = await documentableSvc.submitEntityForApproval({
        orgId,
        actorUserId,
        entityType,
        entity: header,
        workflowDocumentId: header.workflow_document_id,
        snapshot: {
          header,
          lines,
          totals: { amountTotal: header.amount_total, subtotal: header.subtotal, taxTotal: header.tax_total },
          meta: { moduleCode }
        },
        client,
        persistWorkflowDocumentId: async (workflowDocumentId) => {
          await repo.setWorkflowDocumentId(client, orgId, documentId, workflowDocumentId);
        }
      });

      const updated = await repo.setStatus(client, orgId, documentId, "submitted", actorUserId);
      await client.query("COMMIT");
      return { document: updated, workflowDocument };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async function approveWorkflow({ orgId, actorUserId, documentId, comment }) {
    const client = await pool.connect();
    let updated;
    let workflowDocument;
    let isFinalApproval = false;
    try {
      await client.query("BEGIN");
      const header = await repo.getLockedDocument(client, orgId, documentId);
      if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
      if (!header.workflow_document_id) throw new AppError(409, "Document has no workflow document");
      if (!["submitted","draft", "approved"].includes(header.status)) throw new AppError(409, "Only submitted documents can be approved");

      workflowDocument = await documentableSvc.approveEntityDocument({
        orgId,
        actorUserId,
        entityType,
        workflowDocumentId: header.workflow_document_id,
        creatorUserId: header.created_by,
        comment,
        client
      });

      isFinalApproval = !workflowDocument?.next;
      updated = await repo.setStatus(client, orgId, documentId, isFinalApproval ? "approved" : "submitted", actorUserId);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    let posting = null;
    if (runPostingHookOnApproval && isFinalApproval) {
      posting = await runApprovalPostingHook({ entityType, orgId, actorUserId, entityId: documentId });
      if (posting?.status === "success" && posting.entity) {
        updated = posting.entity;
      }
    }

    return { document: updated, workflowDocument, posting };
  }

  async function rejectWorkflow({ orgId, actorUserId, documentId, comment }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const header = await repo.getLockedDocument(client, orgId, documentId);
      if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
      if (!header.workflow_document_id) throw new AppError(409, "Document has no workflow document");
      if (header.status !== "submitted") throw new AppError(409, "Only submitted documents can be rejected");

      const workflowDocument = await documentableSvc.rejectEntityDocument({
        orgId,
        actorUserId,
        entityType,
        workflowDocumentId: header.workflow_document_id,
        creatorUserId: header.created_by,
        comment,
        client
      });

      const updated = await repo.setStatus(client, orgId, documentId, "rejected", actorUserId, { rejection_comment: comment || null });
      await client.query("COMMIT");
      return { document: updated, workflowDocument };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async function finalize({ orgId, actorUserId, documentId }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const header = await repo.getLockedDocument(client, orgId, documentId);
      if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
      if (finalAction === "post" && header.status === "posted") {
        await client.query("COMMIT");
        return header;
      }
      if (finalAction === "issue" && header.status === "issued") {
        await client.query("COMMIT");
        return header;
      }
      if (!["draft", "approved"].includes(header.status)) throw new AppError(409, `Only draft or approved documents can be ${finalAction}ed`);

      await documentableSvc.assertEntityApprovedForAction({
        orgId,
        entityType,
        workflowDocumentId: header.workflow_document_id,
        client,
        actionLabel: finalAction
      });

      const lines = await repo.getDocumentLines(documentId, client);
      let finalEntity = header;
      if (finalAction === "post") {
        await buildOperationalDocumentJournal({ orgId, actorUserId, header, lines, client });
        finalEntity = await repo.setStatus(client, orgId, documentId, "posted", actorUserId, {
          posted_at: new Date(),
          posted_by: actorUserId
        });
      } else {
        finalEntity = await repo.setStatus(client, orgId, documentId, "issued", actorUserId, {
          issued_at: new Date(),
          issued_by: actorUserId
        });
      }

      await writeAudit({
        organizationId: orgId,
        actorUserId,
        action: `${entityType}.${finalAction}ed`,
        entityType,
        entityId: documentId,
        before: header,
        after: finalEntity,
        client
      });

      await client.query("COMMIT");
      return finalEntity;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async function voidDocument({ orgId, actorUserId, documentId, reason }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const header = await repo.getLockedDocument(client, orgId, documentId);
      if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
      if (header.status === "void") {
        await client.query("COMMIT");
        return header;
      }
      if (!["issued", "posted"].includes(header.status)) {
        throw new AppError(409, "Only issued or posted documents can be voided");
      }

      await assertSourceNotInFinalizedTaxReturn({
        client, orgId, sourceType: moduleCode, sourceId: documentId
      });

      let reversalJournalId = header.reversal_journal_entry_id || null;
      if (header.journal_entry_id && !reversalJournalId) {
        const reversal = await journalIF.voidPostedJournal({
          orgId,
          journalId: header.journal_entry_id,
          actorUserId,
          reason: reason || `Void ${moduleCode} ${header.document_no}`,
          client
        });
        reversalJournalId = reversal?.reversalJournalId || reversal?.journalId || reversal?.id || reversal?.journal_id || null;
      }

      const finalEntity = await repo.setStatus(client, orgId, documentId, "void", actorUserId, {
        voided_at: new Date(),
        voided_by: actorUserId,
        void_reason: reason || null,
        reversal_journal_entry_id: reversalJournalId
      });

      await writeAudit({
        organizationId: orgId,
        actorUserId,
        action: `${entityType}.voided`,
        entityType,
        entityId: documentId,
        before: header,
        after: finalEntity,
        client
      });

      await client.query("COMMIT");
      return finalEntity;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    createDraft,
    updateDraft,
    list,
    getDetails,
    submitForApproval,
    approveWorkflow,
    rejectWorkflow,
    finalize,
    voidDocument
  };
}

module.exports = {
  createOpsDocService
};
