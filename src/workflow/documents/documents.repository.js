const { pool } = require("../../db/pool");

function q(client) {
  return client || pool;
}

async function createDocument({ orgId, userId, payload, client = null }) {
  const r = await q(client).query(
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

async function getDocumentById({ orgId, documentId, client = null, forUpdate = false }) {
  const lock = forUpdate ? " FOR UPDATE NOWAIT" : "";
  const r = await q(client).query(
    `SELECT * FROM documents WHERE organization_id=$1 AND id=$2${lock}`,
    [orgId, documentId]
  );
  return r.rows[0] || null;
}

async function listDocuments({ orgId, query, client = null }) {
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

  const r = await q(client).query(
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

async function getDocumentDetails({ orgId, documentId, client = null }) {
  const doc = await getDocumentById({ orgId, documentId, client });
  if (!doc) return null;
  const versions = await q(client).query(
    `SELECT * FROM document_versions WHERE document_id=$1 ORDER BY version_no DESC`,
    [documentId]
  );
  const approvals = await q(client).query(
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

async function getNextVersionNo({ documentId, client = null }) {
  const r = await q(client).query(
    `SELECT COALESCE(MAX(version_no), 0) AS max_no FROM document_versions WHERE document_id=$1`,
    [documentId]
  );
  return (r.rows[0]?.max_no || 0) + 1;
}

async function insertVersion({ documentId, versionNo, originalFilename, mimeType, sizeBytes, checksum, relpath, userId, client = null }) {
  const db = q(client);
  const r = await db.query(
    `
    INSERT INTO document_versions
      (document_id, version_no, original_filename, mime_type, size_bytes, checksum_sha256, storage_relpath, created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [documentId, versionNo, originalFilename, mimeType || null, sizeBytes, checksum, relpath, userId || null]
  );
  await db.query(
    `UPDATE documents SET current_version_no=$2 WHERE id=$1`,
    [documentId, versionNo]
  );
  return r.rows[0];
}

async function getVersion({ orgId, documentId, versionId, client = null }) {
  const r = await q(client).query(
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

async function setDocumentState({ orgId, documentId, stateCode, client = null }) {
  const r = await q(client).query(
    `
    UPDATE documents SET workflow_state_code=$3
    WHERE organization_id=$1 AND id=$2
    RETURNING *
    `,
    [orgId, documentId, stateCode]
  );
  return r.rows[0] || null;
}

async function listApprovalLevelUsers({ orgId, levelId, client = null }) {
  const r = await q(client).query(
    `
    SELECT u.id, u.email, u.first_name, u.last_name, alu.assigned_at
    FROM approval_level_users alu
    JOIN users u ON u.id = alu.user_id
    JOIN approval_levels al ON al.id = alu.approval_level_id
    WHERE al.organization_id = $1 AND alu.approval_level_id = $2
    ORDER BY u.first_name ASC, u.last_name ASC
    `,
    [orgId, levelId]
  );
  return r.rows;
}
 
async function replaceApprovalLevelUsers({ orgId, levelId, userIds, client = null }) {
  const ownsClient = !client;
  const db = client || await pool.connect();
  try {
    if (ownsClient) await db.query("BEGIN");
 
    const al = await db.query(
      `SELECT id FROM approval_levels WHERE id = $1 AND organization_id = $2`,
      [levelId, orgId]
    );
    if (!al.rows[0]) {
      if (ownsClient) await db.query("ROLLBACK");
      return null;
    }
 
    await db.query(
      `DELETE FROM approval_level_users WHERE approval_level_id = $1`,
      [levelId]
    );
 
    for (const userId of userIds) {
      await db.query(
        `
        INSERT INTO approval_level_users (approval_level_id, user_id)
        SELECT $1, u.id FROM users u
        JOIN user_organizations ou ON ou.user_id = u.id
        WHERE u.id = $2 AND ou.organization_id = $3
        ON CONFLICT DO NOTHING
        `,
        [levelId, userId, orgId]
      );
    }
 
    if (ownsClient) await db.query("COMMIT");
    return true;
  } catch (e) {
    if (ownsClient) await db.query("ROLLBACK");
    throw e;
  } finally {
    if (ownsClient) db.release();
  }
}

async function listApprovalLadderForDocumentType({ orgId, documentTypeId, client = null }) {
  const r = await q(client).query(
    `
    SELECT al.*
    FROM document_type_approval_levels dtal
    JOIN approval_levels al ON al.id = dtal.approval_level_id
    JOIN document_types dt ON dt.id = dtal.document_type_id
    WHERE dt.organization_id=$1 AND dt.id=$2 AND al.is_active=TRUE
    ORDER BY dtal.position ASC 
    `,
    [orgId, documentTypeId]
  );
  return r.rows;
}

async function createApprovals({ documentId, ladder, client = null }) {
  for (let i = 0; i < ladder.length; i += 1) {
    const level = ladder[i];
    const status = i === 0 ? "PENDING" : "QUEUED";
    await q(client).query(
      `
      INSERT INTO document_approvals (document_id, approval_level_id, sequence, status)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (document_id, approval_level_id) DO NOTHING
      `,
      [documentId, level.id, level.sequence, status]
    );
  }
}

async function getCurrentPendingApproval({ documentId, client = null }) {
  const r = await q(client).query(
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

async function approveCurrentLevel({ documentId, approverUserId, comment, client = null }) {
  const db = q(client);
  const cur = await db.query(
    `SELECT * FROM document_approvals WHERE document_id=$1 AND status='PENDING' ORDER BY sequence ASC LIMIT 1 FOR UPDATE`,
    [documentId]
  );
  const current = cur.rows[0];
  if (!current) {
    return { updated: null, next: null };
  }
  const updated = await db.query(
    `
      UPDATE document_approvals
      SET status='APPROVED', acted_by_user_id=$2, acted_at=NOW(), comment=COALESCE($3, comment)
      WHERE id=$1
      RETURNING *
      `,
    [current.id, approverUserId || null, comment || null]
  );

  const nxt = await db.query(
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
    await db.query(
      `UPDATE document_approvals SET status='PENDING' WHERE id=$1`,
      [next.id]
    );
  }
  return { updated: updated.rows[0], next };
}

async function rejectCurrentLevel({ documentId, approverUserId, comment, client = null }) {
  const db = q(client);
  const cur = await db.query(
    `SELECT id FROM document_approvals WHERE document_id=$1 AND status='PENDING' ORDER BY sequence ASC LIMIT 1 FOR UPDATE`,
    [documentId]
  );
  if (!cur.rows.length) return null;
  const r = await db.query(
    `
    UPDATE document_approvals
    SET status='REJECTED', acted_by_user_id=$2, acted_at=NOW(), comment=$3
    WHERE id=$1
    RETURNING *
    `,
    [cur.rows[0].id, approverUserId || null, comment || null]
  );
  return r.rows[0] || null;
}

async function createDocumentType({ orgId, payload, client = null }) {
  const r = await q(client).query(
    `
    INSERT INTO document_types (organization_id, code, name, description, is_active)
    VALUES ($1,$2,$3,$4,COALESCE($5, TRUE))
    RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.description || null, payload.is_active]
  );
  return r.rows[0];
}

async function listDocumentTypes({ orgId, client = null }) {
  const r = await q(client).query(
    `SELECT * FROM document_types WHERE organization_id=$1 OR organization_id IS NULL ORDER BY code ASC`,
    [orgId]
  );
  return r.rows;
}

async function getDocumentTypeByCode({ orgId, code, client = null, includeGlobal = true }) {
  const scope = includeGlobal
    ? `AND (organization_id=$1 OR organization_id IS NULL)`
    : `AND organization_id=$1`;
  const r = await q(client).query(
    `SELECT * FROM document_types WHERE code=$2 ${scope} AND is_active=TRUE ORDER BY organization_id NULLS LAST LIMIT 1`,
    [orgId, code]
  );
  return r.rows[0] || null;
}

async function createApprovalLevel({ orgId, payload, client = null }) {
  const r = await q(client).query(
    `
    INSERT INTO approval_levels (organization_id, code, name, sequence, is_active)
    VALUES ($1,$2,$3,$4,COALESCE($5, TRUE))
    RETURNING *
    `,
    [orgId, payload.code, payload.name, payload.sequence, payload.is_active]
  );
  return r.rows[0];
}

async function listApprovalLevels({ orgId, client = null }) {
  const r = await q(client).query(
    `SELECT * FROM approval_levels WHERE organization_id=$1 ORDER BY sequence ASC`,
    [orgId]
  );
  return r.rows;
}

async function replaceDocumentTypeApprovalLevels({ orgId, documentTypeId, approvalLevelIds, client = null }) {
  const ownsClient = !client;
  const db = client || await pool.connect();
  try {
    if (ownsClient) await db.query("BEGIN");
    const dt = await db.query(
      `SELECT id FROM document_types WHERE id=$1 AND (organization_id=$2 OR organization_id IS NULL)`,
      [documentTypeId, orgId]
    );
    if (!dt.rows[0]) {
      if (ownsClient) await db.query("ROLLBACK");
      return null;
    }

    await db.query(
      `DELETE FROM document_type_approval_levels WHERE document_type_id=$1`,
      [documentTypeId]
    );
    for (let i = 0; i < approvalLevelIds.length; i++) {
      await db.query(
        `INSERT INTO document_type_approval_levels (document_type_id, approval_level_id, position)
         SELECT $1, id, $3 FROM approval_levels WHERE id=$2 AND organization_id=$4`,
        [documentTypeId, approvalLevelIds[i], i, orgId]
      );
    }
    if (ownsClient) await db.query("COMMIT");
    return true;
  } catch (e) {
    if (ownsClient) await db.query("ROLLBACK");
    throw e;
  } finally {
    if (ownsClient) db.release();
  }
}

module.exports = {
  createDocument,
  createDocumentType,
  listDocumentTypes,
  getDocumentTypeByCode,
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
  rejectCurrentLevel,
  replaceApprovalLevelUsers,
  listApprovalLevelUsers
};
