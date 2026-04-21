
const { AppError } = require("../../shared/errors/AppError");
const { createDraftJournal, postDraftJournal } = require("../../interfaces/journalPosting.interface");
const documentableSvc = require("../../workflow/documents/documentable.service");
const { propagateDocumentWorkflowToJournal } = require("../../modules/transactions/_shared/workflowJournalAudit.service");

function toISODate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function buildIfrs16IdempotencyKey(parts) {
  return ['IFRS16', ...parts].join(':');
}

async function assertLeaseApprovalStateAllowsAction({ orgId, lease, client, actionLabel = 'post' }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: 'lease',
    workflowDocumentId: lease.workflow_document_id,
    client,
    actionLabel,
  });
}

async function assertLeaseModificationApprovalStateAllowsAction({ orgId, modification, client, actionLabel = 'apply' }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: 'lease_modification',
    workflowDocumentId: modification.workflow_document_id,
    client,
    actionLabel,
  });
}

async function submitLeaseForApproval({ orgId, actorUserId, lease, snapshot, client }) {
  await documentableSvc.submitEntityForApproval({
    orgId,
    actorUserId,
    entityType: 'lease',
    entity: lease,
    workflowDocumentId: lease.workflow_document_id,
    snapshot,
    client,
    persistWorkflowDocumentId: async (workflowDocumentId) => {
      await client.query(
        `UPDATE leases SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
        [orgId, lease.id, workflowDocumentId]
      );
    },
  });

  const { rows } = await client.query(
    `UPDATE leases
        SET status=CASE WHEN status='rejected' THEN 'draft' ELSE status END,
            submitted_at=NOW(), submitted_by=$3,
            approved_at=NULL, approved_by=NULL,
            rejected_at=NULL, rejected_by=NULL, rejection_reason=NULL,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, lease.id, actorUserId]
  );
  return rows[0];
}

async function approveLeaseWorkflow({ orgId, actorUserId, lease, comment, client }) {
  if (!lease.workflow_document_id) throw new AppError(409, 'Lease has no workflow document');
  const approved = await documentableSvc.approveEntityDocument({
    orgId,
    actorUserId,
    entityType: 'lease',
    workflowDocumentId: lease.workflow_document_id,
    creatorUserId: lease.created_by,
    comment,
    client,
  });
  const finalApproval = !approved?.next;
  const { rows } = await client.query(
    `UPDATE leases
        SET approved_at=CASE WHEN $4 THEN NOW() ELSE approved_at END,
            approved_by=CASE WHEN $4 THEN $3 ELSE approved_by END,
            rejected_at=NULL, rejected_by=NULL, rejection_reason=NULL,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, lease.id, actorUserId, finalApproval]
  );
  return { ...rows[0], workflow_step_completed: true, final_approval: finalApproval };
}

async function rejectLeaseWorkflow({ orgId, actorUserId, lease, comment, client }) {
  if (!lease.workflow_document_id) throw new AppError(409, 'Lease has no workflow document');
  await documentableSvc.rejectEntityDocument({
    orgId,
    actorUserId,
    entityType: 'lease',
    workflowDocumentId: lease.workflow_document_id,
    creatorUserId: lease.created_by,
    comment,
    client,
  });
  const { rows } = await client.query(
    `UPDATE leases
        SET rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, lease.id, actorUserId, comment || null]
  );
  return rows[0];
}

async function submitLeaseModificationForApproval({ orgId, actorUserId, modification, snapshot, client }) {
  await documentableSvc.submitEntityForApproval({
    orgId,
    actorUserId,
    entityType: 'lease_modification',
    entity: modification,
    workflowDocumentId: modification.workflow_document_id,
    snapshot,
    client,
    persistWorkflowDocumentId: async (workflowDocumentId) => {
      await client.query(
        `UPDATE lease_modifications SET workflow_document_id=$3, updated_at=NOW() WHERE organization_id=$1 AND id=$2`,
        [orgId, modification.id, workflowDocumentId]
      );
    },
  });

  const { rows } = await client.query(
    `UPDATE lease_modifications
        SET status='submitted', submitted_at=NOW(), submitted_by=$3,
            approved_at=NULL, approved_by=NULL,
            rejected_at=NULL, rejected_by=NULL, rejection_reason=NULL,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, modification.id, actorUserId]
  );
  return rows[0];
}

async function approveLeaseModificationWorkflow({ orgId, actorUserId, modification, comment, client }) {
  if (!modification.workflow_document_id) throw new AppError(409, 'Lease modification has no workflow document');
  const approved = await documentableSvc.approveEntityDocument({
    orgId,
    actorUserId,
    entityType: 'lease_modification',
    workflowDocumentId: modification.workflow_document_id,
    creatorUserId: modification.created_by,
    comment,
    client,
  });
  const finalApproval = !approved?.next;
  const { rows } = await client.query(
    `UPDATE lease_modifications
        SET status=CASE WHEN $4 THEN 'approved' ELSE status END,
            approved_at=CASE WHEN $4 THEN NOW() ELSE approved_at END,
            approved_by=CASE WHEN $4 THEN $3 ELSE approved_by END,
            rejected_at=NULL, rejected_by=NULL, rejection_reason=NULL,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, modification.id, actorUserId, finalApproval]
  );
  return { ...rows[0], workflow_step_completed: true, final_approval: finalApproval };
}

async function rejectLeaseModificationWorkflow({ orgId, actorUserId, modification, comment, client }) {
  if (!modification.workflow_document_id) throw new AppError(409, 'Lease modification has no workflow document');
  await documentableSvc.rejectEntityDocument({
    orgId,
    actorUserId,
    entityType: 'lease_modification',
    workflowDocumentId: modification.workflow_document_id,
    creatorUserId: modification.created_by,
    comment,
    client,
  });
  const { rows } = await client.query(
    `UPDATE lease_modifications
        SET status='rejected', rejected_at=NOW(), rejected_by=$3, rejection_reason=$4, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, modification.id, actorUserId, comment || null]
  );
  return rows[0];
}

async function createAndPostWorkflowBackedJournal({ orgId, actorUserId, client, sourceDocument, payload }) {
  const draft = await createDraftJournal({ orgId, actorUserId, payload, client });
  await propagateDocumentWorkflowToJournal({
    client,
    journalId: draft.journalId,
    source: {
      orgId,
      workflowDocumentId: sourceDocument?.workflow_document_id || null,
      createdBy: sourceDocument?.created_by || actorUserId,
      submittedAt: sourceDocument?.submitted_at || null,
      submittedBy: sourceDocument?.submitted_by || null,
      approvedAt: sourceDocument?.approved_at || null,
      approvedBy: sourceDocument?.approved_by || null,
      updatedBy: actorUserId,
    },
  });

  if (sourceDocument?.approved_at) {
    await client.query(
      `UPDATE journal_entries
          SET status='approved', approved_at=COALESCE(approved_at,$3), approved_by=COALESCE(approved_by,$4), updated_at=NOW(), updated_by=$4
        WHERE organization_id=$1 AND id=$2`,
      [orgId, draft.journalId, sourceDocument.approved_at, sourceDocument.approved_by || actorUserId]
    );
  }

  const posted = await postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });
  return { ...posted, journalId: draft.journalId };
}

module.exports = {
  toISODate,
  buildIfrs16IdempotencyKey,
  assertLeaseApprovalStateAllowsAction,
  assertLeaseModificationApprovalStateAllowsAction,
  submitLeaseForApproval,
  approveLeaseWorkflow,
  rejectLeaseWorkflow,
  submitLeaseModificationForApproval,
  approveLeaseModificationWorkflow,
  rejectLeaseModificationWorkflow,
  createAndPostWorkflowBackedJournal,
};
