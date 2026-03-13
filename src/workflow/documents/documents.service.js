const path = require("path");
const { AppError } = require("../../shared/errors/AppError");
const { env } = require("../../config/env");
const repo = require("./documents.repository");
const storage = require("./documentStorage.local");
const entityResolver = require("../../interfaces/entityResolver.interface");
const { withTransaction } = require("../../db/tx");

function safeFilename(name) {
  // prevent path traversal; keep only basename
  return path.basename(name || "file");
}

function buildRelPath({ orgId, documentId, versionId, filename }) {
  return path.posix.join(
    "orgs",
    orgId,
    "documents",
    documentId,
    "versions",
    versionId,
    filename,
  );
}

async function createDocument({ orgId, userId, payload }) {
  // Validate entity references via interface (do not query other module tables here)
  const resolution = await entityResolver.resolveEntity({
    orgId,
    entityType: payload.entity_type,
    entityId: payload.entity_id,
  });

  if (!resolution.exists) {
    throw new AppError(400, "Invalid entity reference (entity_type/entity_id)");
  }

  // If caller did not provide an entity_ref, fill from resolver when available
  const enriched = {
    ...payload,
    entity_ref: payload.entity_ref || resolution.entity_ref || null,
  };

  return repo.createDocument({ orgId, userId, payload: enriched });
}

async function listDocuments({ orgId, query }) {
  return repo.listDocuments({ orgId, query });
}

async function getDocumentDetails({ orgId, documentId }) {
  const details = await repo.getDocumentDetails({ orgId, documentId });
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
}) {
  const doc = await repo.getDocumentById({ orgId, documentId });
  if (!doc) throw new AppError(404, "Document not found");
  if (doc.workflow_state_code !== "DRAFT") {
    throw new AppError(
      409,
      "Cannot upload new versions unless document is in DRAFT state",
    );
  }
  const versionNo = await repo.getNextVersionNo({ documentId });

  // Precreate a version id (so the path is stable)
  // We rely on DB-generated UUID by inserting after storage; but we need versionId for path.
  // Use a pseudo-id and store it as directory name via checksum pathing:
  // For simplicity, we store by versionNo directory and keep filename.
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
  });
  return { document: doc, version };
}
async function submitDocument({ orgId, documentId, client }) {
  // If no transaction exists, create one
  if (!client) {
    return withTransaction((txClient) =>
      submitDocument({ orgId, documentId, client: txClient }),
    );
  }

  console.log("submitDocument called", { orgId, documentId });

  const doc = await repo.getDocumentById({
    orgId,
    documentId,
    client,
    forUpdate: true,
  });

  console.log("Document fetched:", doc);

  if (!doc) throw new AppError(404, "Document not found");

  if (doc.workflow_state_code !== "DRAFT")
    throw new AppError(409, "Only DRAFT documents can be submitted");

  if ((doc.current_version_no || 0) < 1)
    throw new AppError(
      409,
      "Upload at least one document version before submitting",
    );

  if (!doc.document_type_id) throw new AppError(409, "Document type required");

  const ladder = await repo.listApprovalLadderForDocumentType({
    orgId,
    documentTypeId: doc.document_type_id,
    client,
  });

  // If ladder exists → create approval steps
  if (ladder.length) {
    await repo.createApprovals({ documentId, ladder, client });
  }

  // Always move document to SUBMITTED
  const updated = await repo.setDocumentState({
    orgId,
    documentId,
    stateCode: "SUBMITTED",
    client,
  });

  return { document: updated };
}
// service
async function getDocumentTypeLadder({ orgId, documentTypeId }) {
  return repo.listApprovalLadderForDocumentType({ orgId, documentTypeId });
}
async function approveDocument({ orgId, documentId, userId, comment }) {
  return withTransaction(async (client) => {
    // Lock document row first to ensure single writer for state transitions
    const doc = await repo.getDocumentById({
      orgId,
      documentId,
      client,
      forUpdate: true,
    });
    if (!doc) throw new AppError(404, "Document not found");
    if (doc.workflow_state_code !== "SUBMITTED")
      throw new AppError(409, "Only SUBMITTED documents can be approved");

    const cur = await repo.getCurrentPendingApproval({ documentId, client });
    if (!cur)
      throw new AppError(409, "No pending approval step for this document");
    const assignees = await repo.listApprovalLevelUsers({
      orgId,
      levelId: cur.approval_level_id,
    });
    const isAssigned =
      assignees.length === 0 || assignees.some((a) => a.id === userId);
    if (!isAssigned)
      throw new AppError(403, "You are not assigned to approve this level");
    const { updated, next } = await repo.approveCurrentLevel({
      documentId,
      approverUserId: userId,
      comment,
      client,
    });
    if (!updated)
      throw new AppError(409, "No pending approval step for this document");

    if (!next) {
      const fin = await repo.setDocumentState({
        orgId,
        documentId,
        stateCode: "APPROVED",
        client,
      });
      return { document: fin, approval: updated, next: null };
    }
    const fresh = await repo.getDocumentById({ orgId, documentId, client });
    return {
      document: fresh,
      approval: updated,
      next: { sequence: next.sequence },
    };
  });
}
async function getApprovalLevelUsers({ orgId, levelId }) {
  return repo.listApprovalLevelUsers({ orgId, levelId });
}

async function setApprovalLevelUsers({ orgId, levelId, userIds }) {
  const ok = await repo.replaceApprovalLevelUsers({ orgId, levelId, userIds });
  if (!ok) throw new AppError(404, "Approval level not found");
  return { ok: true };
}
async function rejectDocument({ orgId, documentId, userId, comment }) {
  return withTransaction(async (client) => {
    const doc = await repo.getDocumentById({
      orgId,
      documentId,
      client,
      forUpdate: true,
    });
    if (!doc) throw new AppError(404, "Document not found");
    if (doc.workflow_state_code !== "SUBMITTED")
      throw new AppError(409, "Only SUBMITTED documents can be rejected");

    const rejected = await repo.rejectCurrentLevel({
      documentId,
      approverUserId: userId,
      comment,
      client,
    });
    if (!rejected)
      throw new AppError(409, "No pending approval step for this document");
    const fin = await repo.setDocumentState({
      orgId,
      documentId,
      stateCode: "REJECTED",
      client,
    });
    return { document: fin, approval: rejected };
  });
}

async function getVersionStream({ orgId, documentId, versionId }) {
  const version = await repo.getVersion({ orgId, documentId, versionId });
  if (!version) throw new AppError(404, "Document version not found");
  const rootDir = env.FILE_STORAGE_ROOT;
  const stream = storage.createReadStream({
    rootDir,
    relpath: version.storage_relpath,
  });
  return { version, stream };
}

module.exports = {
  // configuration
  createDocumentType,
  listDocumentTypes,
  createApprovalLevel,
  listApprovalLevels,
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

async function createDocumentType({ orgId, payload }) {
  return repo.createDocumentType({ orgId, payload });
}

async function listDocumentTypes({ orgId }) {
  return repo.listDocumentTypes({ orgId });
}

async function createApprovalLevel({ orgId, payload }) {
  return repo.createApprovalLevel({ orgId, payload });
}

async function listApprovalLevels({ orgId }) {
  return repo.listApprovalLevels({ orgId });
}

async function setDocumentTypeApprovalLevels({
  orgId,
  documentTypeId,
  approvalLevelIds,
}) {
  const ok = await repo.replaceDocumentTypeApprovalLevels({
    orgId,
    documentTypeId,
    approvalLevelIds,
  });
  if (!ok) throw new AppError(404, "Document type not found");
  return { ok: true };
}
