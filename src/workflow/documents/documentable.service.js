const { AppError } = require("../../shared/errors/AppError");
const { withTransaction } = require("../../db/tx");
const documentsSvc = require("./documents.service");
const repo = require("./documents.repository");
const registry = require("./documentable.registry");
const rulesSvc = require("./documentWorkflowRules.service");

function getConfig(entityType) {
  const cfg = registry.getDocumentable(entityType);
  if (!cfg) throw new AppError(500, `Documentable entity not registered: ${entityType}`);
  return cfg;
}

function buildSnapshotPayload({ entityType, entityId, snapshot }) {
  return {
    schema_version: 1,
    entity_type: entityType,
    entity_id: entityId,
    snapshot_at: new Date().toISOString(),
    ...(snapshot || {})
  };
}

async function ensureDocumentTypeForEntity({ orgId, entityType, client }) {
  const cfg = getConfig(entityType);
  let dt = await repo.getDocumentTypeByCode({ orgId, code: cfg.documentTypeCode, client, includeGlobal: false });
  if (!dt) {
    dt = await documentsSvc.createDocumentType({
      orgId,
      payload: {
        code: cfg.documentTypeCode,
        name: cfg.documentTypeName,
        description: `${cfg.documentTypeName} approvals`
      },
      client
    });
  }
  return dt;
}

async function getApprovalContext({ orgId, entityType, client }) {
  const cfg = getConfig(entityType);
  const documentType = await ensureDocumentTypeForEntity({ orgId, entityType, client });
  const ladder = await repo.listApprovalLadderForDocumentType({ orgId, documentTypeId: documentType.id, client, includeGlobalFallback: true });
  const rules = await rulesSvc.getRules({ orgId, documentTypeId: documentType.id, entityType, client });
  return { config: cfg, documentType, ladder, rules, approvalRequired: ladder.length > 0 };
}

async function ensureWorkflowDocumentForEntity({ orgId, actorUserId, entityType, entity, workflowDocumentId, client }) {
  const cfg = getConfig(entityType);
  const documentType = await ensureDocumentTypeForEntity({ orgId, entityType, client });
  if (workflowDocumentId) {
    const existing = await repo.getDocumentById({ orgId, documentId: workflowDocumentId, client });
    if (existing) return existing;
  }

  return documentsSvc.createDocument({
    orgId,
    userId: actorUserId,
    payload: {
      document_type_id: documentType.id,
      title: typeof cfg.title === "function" ? cfg.title(entity) : `${cfg.documentTypeName} ${entity.id}`,
      description: typeof cfg.description === "function" ? cfg.description(entity) : null,
      entity_type: entityType,
      entity_id: entity.id,
      entity_ref: entity.invoice_no || entity.bill_no || entity.code || null
    },
    client
  });
}

async function snapshotEntityToDocument({ orgId, actorUserId, entityType, entity, documentId, snapshot, client }) {
  const cfg = getConfig(entityType);
  const payload = buildSnapshotPayload({ entityType, entityId: entity.id, snapshot });
  return documentsSvc.addVersionFromBuffer({
    orgId,
    documentId,
    userId: actorUserId,
    originalFilename: typeof cfg.versionFilename === "function" ? cfg.versionFilename(entity) : `${entityType}-${entity.id}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
    client
  });
}

async function submitEntityForApproval({ orgId, actorUserId, entityType, entity, workflowDocumentId, snapshot, client, persistWorkflowDocumentId }) {
  const doc = await ensureWorkflowDocumentForEntity({
    orgId,
    actorUserId,
    entityType,
    entity,
    workflowDocumentId,
    client
  });

  if (!workflowDocumentId && typeof persistWorkflowDocumentId === "function") {
    await persistWorkflowDocumentId(doc.id);
  }

  await snapshotEntityToDocument({
    orgId,
    actorUserId,
    entityType,
    entity,
    documentId: doc.id,
    snapshot,
    client
  });

  const submitted = await documentsSvc.submitDocument({ orgId, documentId: doc.id, client });
  return submitted.document;
}

async function approveEntityDocument({ orgId, actorUserId, entityType, workflowDocumentId, creatorUserId, comment, client }) {
  const { config, documentType, rules } = await getApprovalContext({ orgId, entityType, client });
  rulesSvc.assertCanApprove({ rules, creatorUserId, actorUserId, noun: config.noun });
  return documentsSvc.approveDocument({
    orgId,
    documentId: workflowDocumentId,
    userId: actorUserId,
    comment: comment || null,
    client,
    creatorUserId,
    documentTypeId: documentType.id,
    entityType
  });
}

async function rejectEntityDocument({ orgId, actorUserId, entityType, workflowDocumentId, creatorUserId, comment, client }) {
  const { config, documentType, rules } = await getApprovalContext({ orgId, entityType, client });
  rulesSvc.assertCanReject({ rules, creatorUserId, actorUserId, noun: config.noun });
  rulesSvc.assertRejectionCommentRequired({ rules, comment });
  return documentsSvc.rejectDocument({
    orgId,
    documentId: workflowDocumentId,
    userId: actorUserId,
    comment: comment || null,
    client,
    creatorUserId,
    documentTypeId: documentType.id,
    entityType
  });
}

async function assertEntityApprovedForAction({ orgId, entityType, workflowDocumentId, client, actionLabel = null }) {
  const { config, approvalRequired } = await getApprovalContext({ orgId, entityType, client });
  if (!approvalRequired) return;

  const action = actionLabel || config.blockedActionLabel || "post";
  if (!workflowDocumentId) {
    throw new AppError(409, `${config.documentTypeName} requires approval before ${action} (missing workflow document)`);
  }

  const doc = await repo.getDocumentById({ orgId, documentId: workflowDocumentId, client });
  if (!doc) {
    throw new AppError(409, `${config.documentTypeName} workflow document not found`);
  }
  if (doc.workflow_state_code !== "APPROVED") {
    throw new AppError(409, `${config.documentTypeName} requires approval before ${action} (current state: ${doc.workflow_state_code})`);
  }
}

module.exports = {
  getApprovalContext,
  ensureDocumentTypeForEntity,
  ensureWorkflowDocumentForEntity,
  snapshotEntityToDocument,
  submitEntityForApproval,
  approveEntityDocument,
  rejectEntityDocument,
  assertEntityApprovedForAction
};
