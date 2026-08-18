const { pool } = require("../../../db/pool");
const { insertLineTaxDetails } = require("../../../shared/tax/multiTax");

async function nextDocumentNo(client, orgId, moduleCode, prefix) {
  await client.query(
    `INSERT INTO operational_document_sequences(organization_id, module_code, next_no)
     VALUES ($1, $2, 1)
     ON CONFLICT (organization_id, module_code) DO NOTHING`,
    [orgId, moduleCode]
  );

  const { rows } = await client.query(
    `UPDATE operational_document_sequences
        SET next_no = next_no + 1,
            updated_at = NOW()
      WHERE organization_id = $1
        AND module_code = $2
    RETURNING next_no`,
    [orgId, moduleCode]
  );

  const no = BigInt(rows[0].next_no) - 1n;
  return `${prefix}-${String(no).padStart(6, "0")}`;
}

async function insertDocument(client, payload) {
  const {
    orgId,
    moduleCode,
    documentNo,
    partnerId,
    employeeId,
    date,
    dueDate,
    memo,
    reference,
    sourceDocumentId,
    cashAccountId,
    primaryAccountId,
    amountTotal,
    subtotal,
    taxTotal,
    currencyCode,
    meta,
    createdBy,
    status
  } = payload;

  const { rows } = await client.query(
    `
    INSERT INTO operational_documents(
      organization_id, module_code, document_no, counterparty_partner_id, employee_id,
      document_date, due_date, memo, reference, source_document_id,
      cash_account_id, primary_account_id, amount_total, subtotal, tax_total, currency_code,
      meta, created_by, updated_by, status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17::jsonb,'{}'::jsonb),$18,$18,$19)
    RETURNING *
    `,
    [
      orgId, moduleCode, documentNo, partnerId || null, employeeId || null,
      date, dueDate || null, memo || null, reference || null, sourceDocumentId || null,
      cashAccountId || null, primaryAccountId || null, amountTotal, subtotal || 0, taxTotal || 0, currencyCode,
      JSON.stringify(meta || {}), createdBy, status || "draft"
    ]
  );
  return rows[0];
}

async function insertLine(client, documentId, lineNo, line) {
  const { rows } = await client.query(
    `
    INSERT INTO operational_document_lines(
      document_id, line_no, description, quantity, unit_price, line_total, taxable_amount, tax_amount,
      account_id, item_id, tax_code_id, meta
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::jsonb,'{}'::jsonb))
    RETURNING *
    `,
    [
      documentId,
      lineNo,
      line.description,
      line.quantity == null ? 1 : line.quantity,
      line.unitPrice == null ? 0 : line.unitPrice,
      line.lineTotal,
      line.taxableAmount == null ? Math.max(Number(line.lineTotal || 0) - Number(line.taxAmount || 0), 0) : line.taxableAmount,
      line.taxAmount || 0,
      line.accountId || null,
      line.itemId || null,
      line.taxCodeId || null,
      JSON.stringify(line.meta || {})
    ]
  );
  await insertLineTaxDetails({ client, tableName: "operational_doc_line_tax_details", lineId: rows[0].id, details: line.taxDetails || [] });
  return rows[0];
}

function resolveDbArgs(a, b, c,d) {
  if (typeof a?.query === "function" && typeof b === "string") {
    return { db: a, orgId: b, documentId: c, currentUserId: d };
  }
  return { db: pool, orgId: a, documentId: b, currentUserId: c };
}

async function getDocumentById(a, b, c, d) {
  const { orgId, documentId, currentUserId, db} = resolveDbArgs(a, b, c, d);
  const { rows } = await db.query(
    `
    SELECT d.*,
           doc.created_by_user_id,
           $3::uuid AS current_user_id,
           doc.document_type_id,
           dws.creator_can_approve,
           dws.creator_can_post,
           p.name AS partner_name,
           p.type AS partner_type,
           e.first_name AS employee_first_name,
           e.last_name AS employee_last_name,
           doc.workflow_state_code,
           LOWER(doc.workflow_state_code) AS workflow_status,
           CASE
             WHEN doc.id IS NOT NULL
              AND LOWER(doc.workflow_state_code) = 'submitted'
              AND (
                doc.created_by_user_id IS NULL
                OR doc.created_by_user_id IS DISTINCT FROM $3::uuid
                OR COALESCE(dws.allow_self_approval, FALSE)
                OR COALESCE(dws.creator_can_approve, FALSE)
              )
              AND EXISTS (
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                JOIN role_permissions rp ON rp.role_id = r.id
                JOIN permissions p ON p.id = rp.permission_id
                WHERE ur.user_id = $3::uuid
                  AND r.organization_id = d.organization_id
                  AND p.code = 'approvals.act'
              )
              AND EXISTS (
                SELECT 1
                FROM document_approvals da
                WHERE da.document_id = doc.id
                  AND da.status = 'PENDING'
                  AND (
                    NOT EXISTS (
                      SELECT 1
                      FROM approval_level_users alu_any
                      WHERE alu_any.approval_level_id = da.approval_level_id
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM approval_level_users alu_me
                      WHERE alu_me.approval_level_id = da.approval_level_id
                        AND alu_me.user_id = $3::uuid
                    )
                  )
              )
             THEN TRUE
             ELSE FALSE
           END AS can_approve,
           CASE
             WHEN doc.id IS NOT NULL AND doc.created_by_user_id = $3::uuid
             THEN COALESCE(dws.creator_can_post, FALSE)
             ELSE FALSE
           END AS can_post
      FROM operational_documents d
 LEFT JOIN business_partners p
        ON p.id = d.counterparty_partner_id
 LEFT JOIN hr_employees e
        ON e.id = d.employee_id
 LEFT JOIN documents doc
        ON doc.id = d.workflow_document_id
       AND doc.organization_id = d.organization_id
 LEFT JOIN LATERAL (
       SELECT
         s.creator_can_approve,
         s.creator_can_post,
         s.allow_self_approval,
         s.document_type_id
       FROM document_workflow_statics s
       WHERE s.organization_id = d.organization_id
         AND (
           (doc.document_type_id IS NOT NULL AND s.document_type_id = doc.document_type_id)
           OR s.document_type_id IS NULL
         )
       ORDER BY
         CASE
           WHEN s.document_type_id = doc.document_type_id THEN 0
           ELSE 1
         END,
         s.document_type_id NULLS LAST
       LIMIT 1
     ) dws ON TRUE
     WHERE d.organization_id = $1
       AND d.id = $2
    `,
    [orgId, documentId, currentUserId]
  );
  return rows[0] || null;
}
async function getDocumentLines(documentId, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM operational_document_lines WHERE document_id = $1 ORDER BY line_no`,
    [documentId]
  );
  return rows;
}

async function listDocuments({ orgId, moduleCode, query = {} }) {
  const params = [orgId, moduleCode];
  const where = ["d.organization_id = $1", "d.module_code = $2"];
  let i = 3;

  if (query.status) {
    where.push(`d.status = $${i++}`);
    params.push(query.status);
  }
  if (query.partnerId) {
    where.push(`d.counterparty_partner_id = $${i++}`);
    params.push(query.partnerId);
  }
  if (query.employeeId) {
    where.push(`d.employee_id = $${i++}`);
    params.push(query.employeeId);
  }

  const { rows } = await pool.query(
    `
    SELECT d.*, p.name AS partner_name,
           doc.workflow_state_code,
           LOWER(doc.workflow_state_code) AS workflow_status
      FROM operational_documents d
 LEFT JOIN business_partners p ON p.id = d.counterparty_partner_id
 LEFT JOIN documents doc ON doc.id = d.workflow_document_id AND doc.organization_id = d.organization_id
     WHERE ${where.join(" AND ")}
  ORDER BY d.document_date DESC, d.created_at DESC
    `,
    params
  );

  return rows;
}

async function getLockedDocument(client, orgId, documentId) {
  const { rows } = await client.query(
    `SELECT * FROM operational_documents WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, documentId]
  );
  return rows[0] || null;
}

async function setWorkflowDocumentId(client, orgId, documentId, workflowDocumentId) {
  const { rows } = await client.query(
    `
    UPDATE operational_documents
       SET workflow_document_id = $3,
           updated_at = NOW()
     WHERE organization_id = $1
       AND id = $2
   RETURNING *
    `,
    [orgId, documentId, workflowDocumentId]
  );
  return rows[0] || null;
}

async function setStatus(client, orgId, documentId, status, actorUserId, extra = {}) {
  const params = [orgId, documentId, status, actorUserId];
  const sets = [
    `status = $3`,
    `updated_by = $4`,
    `updated_at = NOW()`
  ];
  let idx = 5;

  for (const [key, value] of Object.entries(extra || {})) {
    sets.push(`${key} = $${idx++}`);
    params.push(value);
  }

  const { rows } = await client.query(
    `
    UPDATE operational_documents
       SET ${sets.join(", ")}
     WHERE organization_id = $1
       AND id = $2
   RETURNING *
    `,
    params
  );
  return rows[0] || null;
}

module.exports = {
  nextDocumentNo,
  insertDocument,
  insertLine,
  getDocumentById,
  getDocumentLines,
  listDocuments,
  getLockedDocument,
  setWorkflowDocumentId,
  setStatus
};
