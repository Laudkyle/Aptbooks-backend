
const { pool } = require("../../../db/pool");

async function listTemplates({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT t.*,
           v.id AS current_version_id,
           v.version_no AS current_version_no,
           v.layout_config,
           v.branding_config,
           v.field_config,
           v.status AS version_status,
           v.is_published,
           v.published_at
      FROM document_templates t
 LEFT JOIN LATERAL (
       SELECT v.*
         FROM document_template_versions v
        WHERE v.template_id = t.id
          AND v.is_published = TRUE
        ORDER BY v.version_no DESC
        LIMIT 1
     ) v ON TRUE
     WHERE t.organization_id = $1
     ORDER BY t.is_default DESC, t.name ASC
    `,
    [orgId]
  );
  return rows;
}

async function getTemplateById({ orgId, templateId }) {
  const { rows } = await pool.query(
    `
    SELECT t.*,
           v.id AS current_version_id,
           v.version_no AS current_version_no,
           v.layout_config,
           v.branding_config,
           v.field_config,
           v.status AS version_status,
           v.is_published,
           v.published_at
      FROM document_templates t
 LEFT JOIN LATERAL (
       SELECT v.*
         FROM document_template_versions v
        WHERE v.template_id = t.id
          AND v.is_published = TRUE
        ORDER BY v.version_no DESC
        LIMIT 1
     ) v ON TRUE
     WHERE t.organization_id = $1
       AND t.id = $2
     LIMIT 1
    `,
    [orgId, templateId]
  );
  return rows[0] || null;
}

async function getTemplateByCode({ orgId, code, client = pool }) {
  const { rows } = await client.query(
    `SELECT * FROM document_templates WHERE organization_id = $1 AND code = $2 LIMIT 1`,
    [orgId, code]
  );
  return rows[0] || null;
}

async function createTemplate(client, payload) {
  const { rows } = await client.query(
    `
    INSERT INTO document_templates(
      organization_id, code, name, description, category, base_template_key,
      paper_size, orientation, is_active, is_system, is_default,
      created_by_user_id, updated_by_user_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
    RETURNING *
    `,
    [
      payload.orgId,
      payload.code,
      payload.name,
      payload.description || null,
      payload.category || 'transaction_document',
      payload.baseTemplateKey,
      payload.paperSize || 'A4',
      payload.orientation || 'portrait',
      payload.isActive !== false,
      payload.isSystem === true,
      payload.isDefault === true,
      payload.actorUserId || null
    ]
  );
  return rows[0];
}

async function nextVersionNo(client, templateId) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(version_no), 0) AS max_no FROM document_template_versions WHERE template_id = $1`,
    [templateId]
  );
  return Number(rows[0]?.max_no || 0) + 1;
}

async function createVersion(client, payload) {
  const versionNo = payload.versionNo || await nextVersionNo(client, payload.templateId);
  const { rows } = await client.query(
    `
    INSERT INTO document_template_versions(
      template_id, version_no, layout_config, branding_config, field_config,
      status, is_published, created_by_user_id, published_at
    )
    VALUES ($1,$2,COALESCE($3::jsonb,'{}'::jsonb),COALESCE($4::jsonb,'{}'::jsonb),COALESCE($5::jsonb,'{}'::jsonb),$6,$7,$8,$9)
    RETURNING *
    `,
    [
      payload.templateId,
      versionNo,
      JSON.stringify(payload.layoutConfig || {}),
      JSON.stringify(payload.brandingConfig || {}),
      JSON.stringify(payload.fieldConfig || {}),
      payload.status || 'published',
      payload.isPublished !== false,
      payload.actorUserId || null,
      null
    ]
  );
  if (payload.isPublished !== false) {
    const { rows: updatedRows } = await client.query(
      `UPDATE document_template_versions SET published_at = NOW() WHERE id = $1 RETURNING *`,
      [rows[0].id]
    );
    return updatedRows[0];
  }
  return rows[0];
}

async function updateTemplate(client, { orgId, templateId, actorUserId, patch }) {
  const fields = [];
  const values = [orgId, templateId];
  let idx = 3;
  const mapping = {
    code: 'code',
    name: 'name',
    description: 'description',
    baseTemplateKey: 'base_template_key',
    paperSize: 'paper_size',
    orientation: 'orientation',
    isActive: 'is_active',
    isDefault: 'is_default'
  };
  for (const [key, col] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${col} = $${idx++}`);
      values.push(patch[key]);
    }
  }
  fields.push(`updated_by_user_id = $${idx++}`);
  values.push(actorUserId || null);
  fields.push(`updated_at = NOW()`);
  const { rows } = await client.query(
    `UPDATE document_templates SET ${fields.join(', ')} WHERE organization_id = $1 AND id = $2 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function listAssignments({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT a.*, t.code AS template_code, t.name AS template_name,
           COALESCE(v.version_no, current_v.version_no) AS resolved_version_no,
           COALESCE(v.id, current_v.id) AS resolved_version_id
      FROM document_template_assignments a
      JOIN document_templates t ON t.id = a.template_id
 LEFT JOIN document_template_versions v ON v.id = a.template_version_id
 LEFT JOIN LATERAL (
       SELECT vv.id, vv.version_no
         FROM document_template_versions vv
        WHERE vv.template_id = a.template_id
          AND vv.is_published = TRUE
        ORDER BY vv.version_no DESC
        LIMIT 1
     ) current_v ON TRUE
     WHERE a.organization_id = $1
     ORDER BY a.entity_type ASC
    `,
    [orgId]
  );
  return rows;
}

async function upsertAssignment(client, payload) {
  const { rows } = await client.query(
    `
    INSERT INTO document_template_assignments(
      organization_id, entity_type, template_id, template_version_id,
      is_active, notes, created_by_user_id, updated_by_user_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (organization_id, entity_type)
    DO UPDATE SET
      template_id = EXCLUDED.template_id,
      template_version_id = EXCLUDED.template_version_id,
      is_active = EXCLUDED.is_active,
      notes = EXCLUDED.notes,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = NOW()
    RETURNING *
    `,
    [
      payload.orgId,
      payload.entityType,
      payload.templateId,
      payload.templateVersionId || null,
      payload.isActive !== false,
      payload.notes || null,
      payload.actorUserId || null
    ]
  );
  return rows[0];
}

async function getAssignmentByEntityType({ orgId, entityType, client = pool }) {
  const { rows } = await client.query(
    `
    SELECT a.*, t.code AS template_code, t.name AS template_name, t.base_template_key,
           COALESCE(v.id, current_v.id) AS resolved_version_id,
           COALESCE(v.version_no, current_v.version_no) AS resolved_version_no,
           COALESCE(v.layout_config, current_v.layout_config) AS layout_config,
           COALESCE(v.branding_config, current_v.branding_config) AS branding_config,
           COALESCE(v.field_config, current_v.field_config) AS field_config
      FROM document_template_assignments a
      JOIN document_templates t ON t.id = a.template_id
 LEFT JOIN document_template_versions v ON v.id = a.template_version_id
 LEFT JOIN LATERAL (
       SELECT vv.*
         FROM document_template_versions vv
        WHERE vv.template_id = a.template_id
          AND vv.is_published = TRUE
        ORDER BY vv.version_no DESC
        LIMIT 1
     ) current_v ON TRUE
     WHERE a.organization_id = $1
       AND a.entity_type = $2
       AND a.is_active = TRUE
     LIMIT 1
    `,
    [orgId, entityType]
  );
  return rows[0] || null;
}

async function getDefaultTemplate({ orgId, client = pool }) {
  const { rows } = await client.query(
    `
    SELECT t.*, v.id AS resolved_version_id, v.version_no AS resolved_version_no,
           v.layout_config, v.branding_config, v.field_config
      FROM document_templates t
 LEFT JOIN LATERAL (
       SELECT vv.*
         FROM document_template_versions vv
        WHERE vv.template_id = t.id
          AND vv.is_published = TRUE
        ORDER BY vv.version_no DESC
        LIMIT 1
     ) v ON TRUE
     WHERE t.organization_id = $1
       AND t.is_default = TRUE
       AND t.is_active = TRUE
     ORDER BY t.created_at ASC
     LIMIT 1
    `,
    [orgId]
  );
  return rows[0] || null;
}

async function unsetOtherDefaults(client, { orgId, exceptTemplateId }) {
  await client.query(
    `UPDATE document_templates SET is_default = FALSE, updated_at = NOW() WHERE organization_id = $1 AND id <> $2 AND is_default = TRUE`,
    [orgId, exceptTemplateId]
  );
}

async function insertRenderLog(client, payload) {
  await client.query(
    `
    INSERT INTO document_render_logs(
      organization_id, entity_type, entity_id, template_id, template_version_id,
      render_mode, rendered_by_user_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      payload.orgId,
      payload.entityType,
      payload.entityId || null,
      payload.templateId || null,
      payload.templateVersionId || null,
      payload.renderMode || 'preview',
      payload.actorUserId || null
    ]
  );
}

module.exports = {
  listTemplates,
  getTemplateById,
  getTemplateByCode,
  createTemplate,
  createVersion,
  updateTemplate,
  listAssignments,
  upsertAssignment,
  getAssignmentByEntityType,
  getDefaultTemplate,
  unsetOtherDefaults,
  insertRenderLog
};
