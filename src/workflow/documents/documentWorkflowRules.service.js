const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");
const repo = require("./documents.repository");

const DEFAULT_RULES = Object.freeze({
  creator_can_approve: false,
  creator_can_post: false,
  allow_self_approval: false,
  require_comment_on_rejection: true,
  notify_creator_on_approval: true,
  notify_creator_on_rejection: true
});

function q(client) {
  return client || pool;
}

function isSameUser(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

async function getRules({ orgId, documentTypeId = null, documentTypeCode = null, entityType = null, client = null }) {
  let resolvedDocumentTypeId = documentTypeId || null;
  if (!resolvedDocumentTypeId && documentTypeCode) {
    const dt = await repo.getDocumentTypeByCode({ orgId, code: documentTypeCode, client });
    resolvedDocumentTypeId = dt?.id || null;
  }

  const conditions = ["organization_id = $1"];
  const params = [orgId];

  if (resolvedDocumentTypeId) {
    params.push(resolvedDocumentTypeId);
    conditions.push(`(document_type_id = $${params.length} OR document_type_id IS NULL)`);
  } else {
    conditions.push("document_type_id IS NULL");
  }

  if (entityType) {
    params.push(entityType);
    conditions.push(`(entity_type = $${params.length} OR entity_type IS NULL)`);
  } else {
    conditions.push("entity_type IS NULL");
  }

  const r = await q(client).query(
    `
    SELECT
      creator_can_approve,
      creator_can_post,
      allow_self_approval,
      require_comment_on_rejection,
      notify_creator_on_approval,
      notify_creator_on_rejection,
      document_type_id,
      entity_type,
      updated_at,
      created_at
    FROM document_workflow_statics
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE WHEN document_type_id IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN entity_type IS NOT NULL THEN 0 ELSE 1 END,
      updated_at DESC,
      created_at DESC
    LIMIT 1
    `,
    params
  );

  return r.rows[0] || { ...DEFAULT_RULES };
}

function assertCanApprove({ rules, creatorUserId, actorUserId, noun = "document" }) {
  if (!isSameUser(creatorUserId, actorUserId)) return;
  if (rules.allow_self_approval || rules.creator_can_approve) return;
  throw new AppError(403, `Workflow settings do not allow the creator to approve this ${noun}`);
}

function assertCanReject({ rules, creatorUserId, actorUserId, noun = "document" }) {
  if (!isSameUser(creatorUserId, actorUserId)) return;
  if (rules.allow_self_approval || rules.creator_can_approve) return;
  throw new AppError(403, `Workflow settings do not allow the creator to reject this ${noun}`);
}

function assertCanPost({ rules, creatorUserId, actorUserId, noun = "document" }) {
  if (!isSameUser(creatorUserId, actorUserId)) return;
  if (rules.creator_can_post) return;
  throw new AppError(403, `Workflow settings do not allow the creator to post this ${noun}`);
}

function assertRejectionCommentRequired({ rules, comment }) {
  if (rules.require_comment_on_rejection && !String(comment || "").trim()) {
    throw new AppError(400, "Rejection comment is required by workflow settings");
  }
}

module.exports = {
  DEFAULT_RULES,
  getRules,
  isSameUser,
  assertCanApprove,
  assertCanReject,
  assertCanPost,
  assertRejectionCommentRequired
};
