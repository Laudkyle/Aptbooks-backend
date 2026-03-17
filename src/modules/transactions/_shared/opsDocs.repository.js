const { pool } = require("../../../db/pool");

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
      cash_account_id, primary_account_id, amount_total, currency_code,
      meta, created_by, updated_by, status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15::jsonb,'{}'::jsonb),$16,$16,$17)
    RETURNING *
    `,
    [
      orgId, moduleCode, documentNo, partnerId || null, employeeId || null,
      date, dueDate || null, memo || null, reference || null, sourceDocumentId || null,
      cashAccountId || null, primaryAccountId || null, amountTotal, currencyCode,
      JSON.stringify(meta || {}), createdBy, status || "draft"
    ]
  );
  return rows[0];
}

async function insertLine(client, documentId, lineNo, line) {
  const { rows } = await client.query(
    `
    INSERT INTO operational_document_lines(
      document_id, line_no, description, quantity, unit_price, line_total,
      account_id, item_id, tax_code_id, meta
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::jsonb,'{}'::jsonb))
    RETURNING *
    `,
    [
      documentId,
      lineNo,
      line.description,
      line.quantity == null ? 1 : line.quantity,
      line.unitPrice == null ? 0 : line.unitPrice,
      line.lineTotal,
      line.accountId || null,
      line.itemId || null,
      line.taxCodeId || null,
      JSON.stringify(line.meta || {})
    ]
  );
  return rows[0];
}

function resolveDbArgs(a, b, c) {
  if (typeof a?.query === "function" && typeof b === "string") {
    return { db: a, orgId: b, documentId: c };
  }
  return { db: pool, orgId: a, documentId: b };
}

async function getDocumentById(a, b, c) {
  const { db, orgId, documentId } = resolveDbArgs(a, b, c);
  const { rows } = await db.query(
    `
    SELECT d.*,
           p.name AS partner_name,
           p.type AS partner_type,
           e.first_name AS employee_first_name,
           e.last_name AS employee_last_name,
           doc.workflow_state_code,
           LOWER(doc.workflow_state_code) AS workflow_status
      FROM operational_documents d
 LEFT JOIN business_partners p
        ON p.id = d.counterparty_partner_id
 LEFT JOIN hr_employees e
        ON e.id = d.employee_id
 LEFT JOIN documents doc
        ON doc.id = d.workflow_document_id
       AND doc.organization_id = d.organization_id
     WHERE d.organization_id = $1
       AND d.id = $2
    `,
    [orgId, documentId]
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
