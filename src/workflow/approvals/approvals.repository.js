const { pool } = require("../../db/pool");

async function listInbox({ orgId, limit = 50, offset = 0, documentTypeId = null, state = null }) {
  const params = [orgId];
  let where = "WHERE d.organization_id=$1 AND da.status='PENDING'";
  if (documentTypeId) {
    params.push(documentTypeId);
    where += ` AND d.document_type_id=$${params.length}`;
  }
  if (state) {
    params.push(state);
    where += ` AND d.workflow_state_code=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);

  const { rows } = await pool.query(
    `
    SELECT
      d.id AS document_id,
      d.title,
      d.document_type_id,
      dt.code AS document_type_code,
      dt.name AS document_type_name,
      d.workflow_state_code,
      d.created_at,
      d.updated_at,
      d.created_by,
      da.id AS approval_id,
      da.sequence,
      da.approval_level_id,
      al.code AS approval_level_code,
      al.name AS approval_level_name,
      da.status AS approval_status,
      da.acted_at,
      da.comment
    FROM document_approvals da
    JOIN documents d ON d.id = da.document_id
    JOIN document_types dt ON dt.id = d.document_type_id
    JOIN approval_levels al ON al.id = da.approval_level_id
    ${where}
    ORDER BY da.acted_at NULLS FIRST, da.sequence ASC, d.updated_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  return rows;
}

module.exports = { listInbox };
