const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const documentableSvc = require("../../../workflow/documents/documentable.service");
const partnerIF = require("../../../interfaces/partnerManagement.interface");
const { buildOperationalDocumentJournal } = require("./operationalDocPosting.service");
const { runApprovalPostingHook } = require("./approvalPostingHooks");
const repo = require("./opsDocs.repository");

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

function round2(n) {
  return Number((Number(n || 0)).toFixed(2));
}

function computeLines(lines = []) {
  let total = 0;
  const computed = (lines || []).map((line) => {
    const quantity = line.quantity == null ? 1 : Number(line.quantity);
    const unitPrice = line.unitPrice == null ? 0 : Number(line.unitPrice);
    const lineTotal = line.lineTotal == null ? round2(quantity * unitPrice) : round2(line.lineTotal);
    total += lineTotal;
    return {
      ...line,
      quantity,
      unitPrice,
      lineTotal
    };
  });
  return { lines: computed, total: round2(total) };
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

    const computed = computeLines(payload.lines || []);
    const amountTotal = payload.amountTotal == null ? computed.total : round2(payload.amountTotal);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
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

  async function list({ orgId, query }) {
    return repo.listDocuments({ orgId, moduleCode, query });
  }

  async function getDetails({ orgId, documentId }) {
    const header = await repo.getDocumentById(orgId, documentId);
    if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
    const lines = await repo.getDocumentLines(documentId);
    return { header, lines };
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
          totals: { amountTotal: header.amount_total },
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
    try {
      await client.query("BEGIN");
      const header = await repo.getLockedDocument(client, orgId, documentId);
      if (!header || header.module_code !== moduleCode) throw new AppError(404, "Document not found");
      if (!header.workflow_document_id) throw new AppError(409, "Document has no workflow document");
      if (!["submitted", "approved"].includes(header.status)) throw new AppError(409, "Only submitted documents can be approved");

      workflowDocument = await documentableSvc.approveEntityDocument({
        orgId,
        actorUserId,
        entityType,
        workflowDocumentId: header.workflow_document_id,
        creatorUserId: header.created_by,
        comment,
        client
      });

      updated = await repo.setStatus(client, orgId, documentId, "approved", actorUserId);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    let posting = null;
    if (runPostingHookOnApproval) {
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

      const status = finalAction === "post" ? "posted" : "issued";
      const stampField = finalAction === "post" ? "posted_at" : "issued_at";
      const byField = finalAction === "post" ? "posted_by" : "issued_by";

      let periodId = header.period_id || null;
      let journalEntryId = header.journal_entry_id || null;
      if (finalAction === "post") {
        const lines = await repo.getDocumentLines(documentId, client);
        if (!lines.length && !Number(header.amount_total || 0)) {
          throw new AppError(400, "Document has no posting content");
        }
        const posting = await buildOperationalDocumentJournal({ orgId, actorUserId, header, lines, client });
        periodId = posting.period.id;
        journalEntryId = posting.journalId;
      }

      const { rows } = await client.query(
        `UPDATE operational_documents
            SET ${stampField} = NOW(),
                ${byField} = $3,
                updated_by = $3,
                updated_at = NOW(),
                status = $4,
                period_id = COALESCE($5, period_id),
                journal_entry_id = COALESCE($6, journal_entry_id)
          WHERE organization_id = $1 AND id = $2
      RETURNING *`,
        [orgId, documentId, actorUserId, status, periodId, journalEntryId]
      );
      await client.query("COMMIT");
      return rows[0];
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
      if (header.status === "void") throw new AppError(409, "Document already voided");
      if (header.status === "posted" || header.journal_entry_id) {
        throw new AppError(409, "Posted documents cannot be voided directly. Reverse the journal first.");
      }
      const { rows } = await client.query(
        `UPDATE operational_documents
            SET status = 'void',
                voided_at = NOW(),
                voided_by = $3,
                rejection_comment = COALESCE($4, rejection_comment),
                updated_by = $3,
                updated_at = NOW()
          WHERE organization_id = $1 AND id = $2
      RETURNING *`,
        [orgId, documentId, actorUserId, reason || null]
      );
      await client.query("COMMIT");
      return rows[0];
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    createDraft,
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
