const { pool } = require("../../db/pool");

async function createDocument({ orgId, userId, payload }) {
  const r = await pool.query(
    `
    INSERT INTO documents
      (organization_id, document_type_id, title, description, entity_type, entity_id, entity_ref, created_by_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [
      orgId,
      payload.document_type_id || null,
      payload.title,
      payload.description || null,
      payload.entity_type,
      payload.entity_id,
      payload.entity_ref || null,
      userId || null
    ]
  );
  return r.rows[0];
}

async function getDocumentById({ orgId, documentId }) {
  const r = await pool.query(
    `SELECT * FROM documents WHERE organization_id=$1 AND id=$2`,
    [orgId, documentId]
  );
  return r.rows[0] || null;
}

async function listDocuments({ orgId, query }) {
  const limit = query.limit || 50;
  const offset = query.offset || 0;

  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (query.entity_type) {
    params.push(query.entity_type);
    where += ` AND entity_type=$${params.length}`;
  }
  if (query.entity_id) {
    params.push(query.entity_id);
    where += ` AND entity_id=$${params.length}`;
  }
  if (query.status) {
    params.push(query.status);
    where += ` AND workflow_state_code=$${params.length}`;
  }
  params.push(limit);
  params.push(offset);

  const r = await pool.query(
    `
    SELECT *
    FROM documents
    ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );
  return r.rows;
}

async function getDocumentDetails({ orgId, documentId }) {
  const doc = await getDocumentById({ orgId, documentId });
  if (!doc) return null;
  const versions = await pool.query(
    `SELECT * FROM document_versions WHERE document_id=$1 ORDER BY version_no DESC`,
    [documentId]
  );
  const approvals = await pool.query(
    `
    SELECT da.*, al.code as approval_level_code, al.name as approval_level_name
    FROM document_approvals da
    JOIN approval_levels al ON al.id = da.approval_level_id
    WHERE da.document_id=$1
    ORDER BY da.sequence ASC
    `,
    [documentId]
  );
  return { document: doc, versions: versions.rows, approvals: approvals.rows };
}

async function getNextVersionNo({ documentId }) {
  const r = await pool.query(
    `SELECT COALESCE(MAX(version_no), 0) AS max_no FROM document_versions WHERE document_id=$1`,
    [documentId]
  );
  return (r.rows[0]?.max_no || 0) + 1;
}

async function insertVersion({ documentId, versionNo, originalFilename, mimeType, sizeBytes, checksum, relpath, userId }) {
  const r = await pool.query(
    `
    INSERT INTO document_versions
      (document_id, version_no, original_filename, mime_type, size_bytes, checksum_sha256, storage_relpath, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [documentId, versionNo, originalFilename, mimeType || null, sizeBytes, checksum, relpath, userId || null]
  );
  await pool.query(
    `UPDATE documents SET current_version_no=$2 WHERE id=$1`,
    [documentId, versionNo]
  );
  return r.rows[0];
}

async function getVersion({ orgId, documentId, versionId }) {
  // ensure org scoping via join
  const r = await pool.query(
    `
    SELECT dv.*
    FROM document_versions dv
    JOIN documents d ON d.id = dv.document_id
    WHERE d.organization_id=$1 AND dv.document_id=$2 AND dv.id=$3
    `,
    [orgId, documentId, versionId]
  );
  return r.rows[0] || null;
}

async function setDocumentState({ orgId, documentId, stateCode }) {
  const r = await pool.query(
    `
    UPDATE documents SET workflow_state_code=$3
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, documentId, stateCode]
  );
  return r.rows[0] || null;
}

async function listApprovalLadderForDocumentType({ orgId, documentTypeId }) {
  const r = await pool.query(
    `
    SELECT al.*
    FROM document_type_approval_levels dtal
    JOIN approval_levels al ON al.id = dtal.approval_level_id
    JOIN document_types dt ON dt.id = dtal.document_type_id
    WHERE dt.organization_id=$1 AND dt.id=$2 AND al.is_active=TRUE
    ORDER BY al.sequence ASC
    `,
    [orgId, documentTypeId]
  );
  return r.rows;
}

async function createApprovals({ documentId, ladder }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < ladder.length; i += 1) {
      const level = ladder[i];
      const status = i === 0 ? "PENDING" : "QUEUED";
      await client.query(
        `
        INSERT INTO document_approvals (document_id, approval_level_id, sequence, status)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (document_id, approval_level_id) DO NOTHING
        `,
        [documentId, level.id, level.sequence, status]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getCurrentPendingApproval({ documentId }) {
  const r = await pool.query(
    `
    SELECT da.*, al.code as approval_level_code, al.name as approval_level_name
    FROM document_approvals da
    JOIN approval_levels al ON al.id = da.approval_level_id
    WHERE da.document_id=$1 AND da.status='PENDING'
    ORDER BY da.sequence ASC
    LIMIT 1
    `,
    [documentId]
  );
  return r.rows[0] || null;
}

async function approveCurrentLevel({ documentId, approverUserId, comment }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      `SELECT * FROM document_approvals WHERE document_id=$1 AND status='PENDING' ORDER BY sequence ASC LIMIT 1 FOR UPDATE`,
      [documentId]
    );
    const current = cur.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return { updated: null, next: null };
    }
    const updated = await client.query(
      `
      UPDATE document_approvals
      SET status='APPROVED', acted_by_user_id=$2, acted_at=NOW(), comment=COALESCE($3, comment)
      WHERE id=$1
      RETURNING *
      `,
      [current.id, approverUserId || null, comment || null]
    );

    const nxt = await client.query(
      `
      SELECT * FROM document_approvals
      WHERE document_id=$1 AND status='QUEUED'
      ORDER BY sequence ASC
      LIMIT 1
      FOR UPDATE
      `,
      [documentId]
    );
    const next = nxt.rows[0] || null;
    if (next) {
      await client.query(
        `UPDATE document_approvals SET status='PENDING' WHERE id=$1`,
        [next.id]
      );
    }
    await client.query("COMMIT");
    return { updated: updated.rows[0], next };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function rejectCurrentLevel({ documentId, approverUserId, comment }) {
  const r = await pool.query(
    `
    UPDATE document_approvals
    SET status='REJECTED', acted_by_user_id=$2, acted_at=NOW(), comment=$3
    WHERE id = (
      SELECT id FROM document_approvals WHERE document_id=$1 AND status='PENDING' ORDER BY sequence ASC LIMIT 1
    )
    RETURNING *
    `,
    [documentId, approverUserId || null, comment || null]
  );
  return r.rows[0] || null;
}

module.exports = {
  createDocument,
  // configuration
  createDocumentType,
  listDocumentTypes,
  createApprovalLevel,
  listApprovalLevels,
  replaceDocumentTypeApprovalLevels,
  getDocumentById,
  getDocumentDetails,
  listDocuments,
  getNextVersionNo,
  insertVersion,
  getVersion,
  setDocumentState,
  listApprovalLadderForDocumentType,
  createApprovals,
  getCurrentPendingApproval,
  approveCurrentLevel,
  rejectCurrentLevel
};

async function createDocumentType({ orgId, payload }) {
  const r = await pool.query(
    `
    INSERT INTO document_types (organization_id, code, name, description, is_active)
    VALUES ($1,$2,$3,$4,COALESCE($5, TRUE))
    RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.description || null, payload.is_active]
  );
  return r.rows[0];
}

async function listDocumentTypes({ orgId }) {
  const r = await pool.query(
    `SELECT * FROM document_types WHERE organization_id=$1 OR organization_id IS NULL ORDER BY code ASC`,
    [orgId]
  );
  return r.rows;
}

async function createApprovalLevel({ orgId, payload }) {
  const r = await pool.query(
    `
    INSERT INTO approval_levels (organization_id, code, name, sequence, is_active)
    VALUES ($1,$2,$3,$4,COALESCE($5, TRUE))
    RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.sequence, payload.is_active]
  );
  return r.rows[0];
}

async function listApprovalLevels({ orgId }) {
  const r = await pool.query(
    `SELECT * FROM approval_levels WHERE organization_id=$1 ORDER BY sequence ASC`,
    [orgId]
  );
  return r.rows;
}

async function replaceDocumentTypeApprovalLevels({ orgId, documentTypeId, approvalLevelIds }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // ensure document type belongs to org
    const dt = await client.query(
      `SELECT id FROM document_types WHERE id=$1 AND (organization_id=$2 OR organization_id IS NULL)`,
      [documentTypeId, orgId]
    );
    if (!dt.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `DELETE FROM document_type_approval_levels WHERE document_type_id=$1`,
      [documentTypeId]
    );
    for (const levelId of approvalLevelIds) {
      // ensure level belongs to org
      await client.query(
        `
        INSERT INTO document_type_approval_levels (document_type_id, approval_level_id)
        SELECT $1, id FROM approval_levels WHERE id=$2 AND organization_id=$3
        `,
        [documentTypeId, levelId, orgId]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
