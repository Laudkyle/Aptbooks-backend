async function propagateDocumentWorkflowToJournal({ client, journalId, source = {} }) {
  if (!client || !journalId) return;
  await client.query(
    `
    UPDATE journal_entries
    SET created_by = COALESCE($3, created_by),
        submitted_at = COALESCE($4, submitted_at),
        submitted_by = COALESCE($5, submitted_by),
        approved_at = COALESCE($6, approved_at),
        approved_by = COALESCE($7, approved_by),
        updated_at = NOW(),
        updated_by = COALESCE($8, updated_by)
    WHERE organization_id = $1 AND id = $2
    `,
    [
      source.orgId,
      journalId,
      source.createdBy || null,
      source.submittedAt || null,
      source.submittedBy || null,
      source.approvedAt || null,
      source.approvedBy || null,
      source.updatedBy || source.approvedBy || source.submittedBy || source.createdBy || null
    ]
  );
}

module.exports = { propagateDocumentWorkflowToJournal };
