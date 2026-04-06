const path = require("path");
const { AppError } = require("../../shared/errors/AppError");
const { env } = require("../../config/env");
const repo = require("./documents.repository");
const storage = require("./documentStorage.local");
const entityResolver = require("../../interfaces/entityResolver.interface");
const { withTransaction } = require("../../db/tx");
const workflowRulesSvc = require("./documentWorkflowRules.service");

function safeFilename(name) {
  return path.basename(name || "file");
}

async function createDocument({ orgId, userId, payload, client = null }) {
  const resolution = await entityResolver.resolveEntity({
    orgId,
    entityType: payload.entity_type,
    entityId: payload.entity_id,
  });

  if (!resolution.exists) {
    throw new AppError(400, "Invalid entity reference (entity_type/entity_id)");
  }

  const enriched = {
    ...payload,
    entity_ref: payload.entity_ref || resolution.entity_ref || null,
  };

  return repo.createDocument({ orgId, userId, payload: enriched, client });
}

async function listDocuments({ orgId, query, client = null }) {
  return repo.listDocuments({ orgId, query, client });
}

async function getDocumentDetails({ orgId, documentId, client = null }) {
  const details = await repo.getDocumentDetails({ orgId, documentId, client });
  if (!details) throw new AppError(404, "Document not found");
  return details;
}

async function addVersionFromBuffer({
  orgId,
  documentId,
  userId,
  originalFilename,
  mimeType,
  buffer,
  client = null,
}) {
  const doc = await repo.getDocumentById({ orgId, documentId, client });
  if (!doc) throw new AppError(404, "Document not found");
  if (doc.workflow_state_code !== "DRAFT") {
    throw new AppError(409, "Cannot upload new versions unless document is in DRAFT state");
  }
  const versionNo = await repo.getNextVersionNo({ documentId, client });
  const filename = safeFilename(originalFilename);
  const relpath = path.posix.join(
    "orgs",
    orgId,
    "documents",
    documentId,
    "versions",
    String(versionNo),
    filename,
  );

  const rootDir = env.FILE_STORAGE_ROOT;
  const stored = await storage.storeBuffer({ rootDir, relpath, buffer });
  const version = await repo.insertVersion({
    documentId,
    versionNo,
    originalFilename: filename,
    mimeType,
    sizeBytes: stored.size_bytes,
    checksum: stored.checksum_sha256,
    relpath: stored.relpath,
    userId,
    client,
  });
  return { document: doc, version };
}

async function submitDocument({ orgId, documentId, client = null }) {
  return withTransaction(async (txClient) => {
    const doc = await repo.getDocumentById({
      orgId,
      documentId,
      client: txClient,
      forUpdate: true,
    });

    if (!doc) throw new AppError(404, "Document not found");
    if (doc.workflow_state_code !== "DRAFT") {
      throw new AppError(409, "Only DRAFT documents can be submitted");
    }
    if ((doc.current_version_no || 0) < 1) {
      throw new AppError(409, "Upload at least one document version before submitting");
    }
    if (!doc.document_type_id) throw new AppError(409, "Document type required");

    const ladder = await repo.listApprovalLadderForDocumentType({
      orgId,
      documentTypeId: doc.document_type_id,
      client: txClient,
    });

    if (ladder.length) {
      await repo.createApprovals({ documentId, ladder, client: txClient });
    }

    const updated = await repo.setDocumentState({
      orgId,
      documentId,
      stateCode: "SUBMITTED",
      client: txClient,
    });

    return { document: updated };
  }, client);
}

async function getGlobalApprovalLadder({ orgId, client = null }) {
  return repo.listGlobalApprovalLadder({ orgId, client });
}

async function getDocumentTypeLadder({ orgId, documentTypeId, client = null }) {
  return repo.listApprovalLadderForDocumentType({ orgId, documentTypeId, client, includeGlobalFallback: true });
}

async function approveDocument({ orgId, documentId, userId, comment, client = null, creatorUserId = null, documentTypeId = null, entityType = null }) {
  return withTransaction(async (txClient) => {
    const doc = await repo.getDocumentById({
      orgId,
      documentId,
      client: txClient,
      forUpdate: true,
    });
    if (!doc) throw new AppError(404, "Document not found");
    if (doc.workflow_state_code !== "SUBMITTED") {
      throw new AppError(409, "Only SUBMITTED documents can be approved");
    }

    const rules = await workflowRulesSvc.getRules({
      orgId,
      documentTypeId: documentTypeId || doc.document_type_id || null,
      entityType: entityType || doc.entity_type || null,
      client: txClient
    });
    workflowRulesSvc.assertCanApprove({
      rules,
      creatorUserId: creatorUserId || doc.created_by_user_id || null,
      actorUserId: userId,
      noun: entityType || doc.entity_type || "document"
    });

    const cur = await repo.getCurrentPendingApproval({ documentId, client: txClient });
    if (!cur) throw new AppError(409, "No pending approval step for this document");
    const assignees = await repo.listApprovalLevelUsers({
      orgId,
      levelId: cur.approval_level_id,
      client: txClient,
    });
    const isAssigned = assignees.length === 0 || assignees.some((a) => String(a.id) === String(userId));
    if (!isAssigned) throw new AppError(403, "You are not assigned to approve this level");

    const { updated, next } = await repo.approveCurrentLevel({
      documentId,
      approverUserId: userId,
      comment,
      client: txClient,
    });
    if (!updated) throw new AppError(409, "No pending approval step for this document");

    if (!next) {
      const fin = await repo.setDocumentState({
        orgId,
        documentId,
        stateCode: "APPROVED",
        client: txClient,
      });
      return { document: fin, approval: updated, next: null };
    }
    const fresh = await repo.getDocumentById({ orgId, documentId, client: txClient });
    return {
      document: fresh,
      approval: updated,
      next: { sequence: next.sequence },
    };
  }, client);
}

async function getApprovalLevelUsers({ orgId, levelId, client = null }) {
  return repo.listApprovalLevelUsers({ orgId, levelId, client });
}

async function setApprovalLevelUsers({ orgId, levelId, userIds, client = null }) {
  const ok = await repo.replaceApprovalLevelUsers({ orgId, levelId, userIds, client });
  if (!ok) throw new AppError(404, "Approval level not found");
  return { ok: true };
}

async function rejectDocument({ orgId, documentId, userId, comment, client = null, creatorUserId = null, documentTypeId = null, entityType = null }) {
  return withTransaction(async (txClient) => {
    const doc = await repo.getDocumentById({
      orgId,
      documentId,
      client: txClient,
      forUpdate: true,
    });
    if (!doc) throw new AppError(404, "Document not found");
    if (doc.workflow_state_code !== "SUBMITTED") {
      throw new AppError(409, "Only SUBMITTED documents can be rejected");
    }

    const rules = await workflowRulesSvc.getRules({
      orgId,
      documentTypeId: documentTypeId || doc.document_type_id || null,
      entityType: entityType || doc.entity_type || null,
      client: txClient
    });
    workflowRulesSvc.assertCanReject({
      rules,
      creatorUserId: creatorUserId || doc.created_by_user_id || null,
      actorUserId: userId,
      noun: entityType || doc.entity_type || "document"
    });
    workflowRulesSvc.assertRejectionCommentRequired({ rules, comment });

    const rejected = await repo.rejectCurrentLevel({
      documentId,
      approverUserId: userId,
      comment,
      client: txClient,
    });
    if (!rejected) throw new AppError(409, "No pending approval step for this document");
    const fin = await repo.setDocumentState({
      orgId,
      documentId,
      stateCode: "REJECTED",
      client: txClient,
    });
    return { document: fin, approval: rejected };
  }, client);
}

async function getVersionStream({ orgId, documentId, versionId, client = null }) {
  const version = await repo.getVersion({ orgId, documentId, versionId, client });
  if (!version) throw new AppError(404, "Document version not found");
  const rootDir = env.FILE_STORAGE_ROOT;
  const stream = storage.createReadStream({
    rootDir,
    relpath: version.storage_relpath,
  });
  return { version, stream };
}

async function createDocumentType({ orgId, payload, client = null }) {
  return repo.createDocumentType({ orgId, payload, client });
}

async function listDocumentTypes({ orgId, client = null }) {
  return repo.listDocumentTypes({ orgId, client });
}

async function createApprovalLevel({ orgId, payload, client = null }) {
  return repo.createApprovalLevel({ orgId, payload, client });
}

async function listApprovalLevels({ orgId, client = null }) {
  return repo.listApprovalLevels({ orgId, client });
}

async function setGlobalApprovalLevels({ orgId, approvalLevelIds, client = null }) {
  await repo.replaceGlobalApprovalLevels({
    orgId,
    approvalLevelIds,
    client,
  });
  return { ok: true };
}

async function setDocumentTypeApprovalLevels({ orgId, documentTypeId, approvalLevelIds, client = null }) {
  const ok = await repo.replaceDocumentTypeApprovalLevels({
    orgId,
    documentTypeId,
    approvalLevelIds,
    client,
  });
  if (!ok) throw new AppError(404, "Document type not found");
  return { ok: true };
}

module.exports = {
  createDocumentType,
  listDocumentTypes,
  createApprovalLevel,
  listApprovalLevels,
  getGlobalApprovalLadder,
  setGlobalApprovalLevels,
  setDocumentTypeApprovalLevels,
  createDocument,
  listDocuments,
  getDocumentDetails,
  addVersionFromBuffer,
  submitDocument,
  approveDocument,
  rejectDocument,
  getVersionStream,
  getDocumentTypeLadder,
  getApprovalLevelUsers,
  setApprovalLevelUsers,
};
