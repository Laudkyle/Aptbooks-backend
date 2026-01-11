const { pool } = require("../../db/pool");

async function insertFinancialStatement({ orgId, periodId, statementType, templateId, asOfDate, comparePeriodId, mode, parameters, generatedByUserId, payload }) {
  const { rows } =  await pool.query(
  `
  INSERT INTO financial_statements(
    organization_id,
    period_id,
    template_id,
    statement_type,
    as_of_date,
    compare_period_id,
    mode,
    parameters_json,
    generated_by_user_id,
    generated_by,
    payload_json
  )
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,$10::jsonb)
  RETURNING id, organization_id, period_id, template_id, statement_type, as_of_date,
            compare_period_id, mode, generated_by_user_id, generated_by, generated_at, payload_json
  `,
  [
    orgId,
    periodId || null,
    templateId || null,
    statementType,
    asOfDate || null,
    comparePeriodId || null,
    mode || "period",
    JSON.stringify(parameters || {}),  // Convert to JSON string
    generatedByUserId || null,
    JSON.stringify(payload || {})      // Convert to JSON string
  ]
);
  return rows[0];
}

async function listFinancialStatements({ orgId, periodId, statementType, limit = 50 }) {
  const params = [orgId];
  let where = `WHERE organization_id=$1`;
  if (periodId) {
    params.push(periodId);
    where += ` AND period_id=$${params.length}`;
  }
  if (statementType) {
    params.push(statementType);
    where += ` AND statement_type=$${params.length}`;
  }
  params.push(Math.min(Number(limit || 50) || 50, 200));

  const { rows } = await pool.query(
    `
    SELECT id, period_id, statement_type, template_id, as_of_date, compare_period_id, mode,
           COALESCE(generated_by_user_id, generated_by) AS generated_by,
           generated_at, payload_json
    FROM financial_statements
    ${where}
    ORDER BY generated_at DESC
    LIMIT $${params.length}
    `,
    params
  );
  return rows;
}

async function getDefaultTemplate({ orgId, statementType }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM statement_templates
    WHERE organization_id=$1 AND statement_type=$2 AND is_default=true AND status='active'
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [orgId, statementType]
  );
  return rows[0] || null;
}

async function createTemplate({ orgId, statementType, name, description }) {
  const { rows } = await pool.query(
    `
    INSERT INTO statement_templates(organization_id, name, statement_type, description, is_default, status)
    VALUES ($1,$2,$3,$4,true,'active')
    RETURNING *
    `,
    [orgId, name, statementType, description || null]
  );
  return rows[0];
}

async function bulkInsertLines({ orgId, templateId, lines }) {
  if (!lines.length) return [];
  const values = [];
  const params = [];
  let i = 1;
  for (const ln of lines) {
    params.push(orgId, templateId, ln.line_no, ln.label, ln.line_type, ln.account_id || null, ln.expression || null, ln.sort_order || 0, ln.parent_line_id || null, ln.is_visible ?? true, ln.dr_cr_normal || null, ln.section_code || null);
    values.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
  }
  const { rows } = await pool.query(
    `
    INSERT INTO statement_lines(
      organization_id, template_id, line_no, label, line_type, account_id, expression, sort_order,
      parent_line_id, is_visible, dr_cr_normal, section_code
    )
    VALUES ${values.join(",")}
    RETURNING *
    `,
    params
  );
  return rows;
}

async function bulkInsertLineAccounts({ mappings }) {
  if (!mappings.length) return;
  const values = [];
  const params = [];
  let i = 1;
  for (const m of mappings) {
    params.push(m.line_id, m.account_id, m.weight ?? 1, m.sign_override || null);
    values.push(`($${i++},$${i++},$${i++},$${i++})`);
  }
  await pool.query(
    `
    INSERT INTO statement_line_accounts(line_id, account_id, weight, sign_override)
    VALUES ${values.join(",")}
    ON CONFLICT (line_id, account_id) DO UPDATE
      SET weight=EXCLUDED.weight, sign_override=EXCLUDED.sign_override
    `,
    params
  );
}

async function getTemplateGraph({ orgId, templateId }) {
  const { rows: lines } = await pool.query(
    `
    SELECT *
    FROM statement_lines
    WHERE organization_id=$1 AND template_id=$2
    ORDER BY sort_order, line_no
    `,
    [orgId, templateId]
  );
  if (!lines.length) return { lines: [], mappings: [] };
  const { rows: maps } = await pool.query(
    `
    SELECT sla.line_id, sla.account_id, sla.weight, sla.sign_override,
           coa.code AS account_code, coa.name AS account_name,
           at.normal_balance
    FROM statement_line_accounts sla
    JOIN chart_of_accounts coa ON coa.id = sla.account_id
    JOIN account_types at ON at.id = coa.account_type_id
    WHERE coa.organization_id=$1 AND sla.line_id = ANY($2::uuid[])
    `,
    [orgId, lines.map((l) => l.id)]
  );
  return { lines, mappings: maps };
}

module.exports = {
  insertFinancialStatement,
  listFinancialStatements,
  getDefaultTemplate,
  createTemplate,
  bulkInsertLines,
  bulkInsertLineAccounts,
  getTemplateGraph
};
