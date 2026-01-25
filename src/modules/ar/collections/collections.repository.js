const { AppError } = require('../../../shared/errors/AppError'); 

async function listQueue({ orgId, asOfDate, minDaysPastDue = 1, includeDisputed = false, client }) {
  const params = [orgId, asOfDate, minDaysPastDue]; 
  const disputedClause = includeDisputed ? '' : `AND NOT EXISTS (
      SELECT 1 FROM disputes d
      WHERE d.organization_id=$1 AND d.entity_type='invoice' AND d.entity_id=oi.invoice_id AND d.status='open'
    )`; 

  const { rows } = await client.query(
    `SELECT
        oi.customer_id AS partner_id,
        p.name AS partner_name,
        COUNT(*) AS open_invoices,
        SUM(GREATEST(oi.outstanding,0)) AS amount_due,
        MIN(oi.due_date) AS earliest_due_date,
        -- FIXED: Using integer arithmetic instead of DATE_PART
        MAX(GREATEST(0, $2::date - oi.due_date::date)) AS max_days_past_due
     FROM reporting_ar_open_items oi
     JOIN business_partners p ON p.id = oi.customer_id AND p.organization_id = oi.organization_id
     WHERE oi.organization_id=$1
       AND (oi.outstanding > 0)
       AND (oi.due_date IS NOT NULL)
       -- FIXED: Using integer arithmetic
       AND ($2::date - oi.due_date::date) >= $3
       ${disputedClause}
     GROUP BY oi.customer_id, p.name
     ORDER BY max_days_past_due DESC, amount_due DESC`,
    params
  ); 
  return rows.map(r => ({
    partnerId: Number(r.partner_id),
    partnerName: r.partner_name,
    openInvoices: Number(r.open_invoices),
    amountDue: Number(r.amount_due || 0),
    earliestDueDate: r.earliest_due_date,
    maxDaysPastDue: Number(r.max_days_past_due || 0)
  })); 
}

async function listPartnerOpenInvoices({ orgId, partnerId, asOfDate, client }) {
  const { rows } = await client.query(
    `SELECT
        oi.invoice_id,
        oi.invoice_no,
        oi.invoice_date,
        oi.due_date,
        oi.currency_code,
        oi.total,
        oi.allocated,
        oi.notes_applied,
        COALESCE(oi.written_off,0) AS written_off,
        oi.outstanding,
        GREATEST(0, DATE_PART('day', $3::date - oi.due_date::date)) AS days_past_due,
        EXISTS(
          SELECT 1 FROM disputes d
          WHERE d.organization_id=$1 AND d.entity_type='invoice' AND d.entity_id=oi.invoice_id AND d.status='open'
        ) AS is_disputed
     FROM reporting_ar_open_items oi
     WHERE oi.organization_id=$1 AND oi.customer_id=$2 AND oi.outstanding > 0
     ORDER BY oi.due_date ASC, oi.invoice_id ASC`,
    [orgId, partnerId, asOfDate]
  ); 
  return rows.map(r => ({
    invoiceId: Number(r.invoice_id),
    invoiceNo: r.invoice_no,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    currencyCode: r.currency_code,
    total: Number(r.total || 0),
    allocated: Number(r.allocated || 0),
    notesApplied: Number(r.notes_applied || 0),
    writtenOff: Number(r.written_off || 0),
    outstanding: Number(r.outstanding || 0),
    daysPastDue: Number(r.days_past_due || 0),
    isDisputed: !!r.is_disputed
  })); 
}

// Templates
async function listTemplates({ orgId, client }) {
  const { rows } = await client.query(
    `SELECT * FROM dunning_templates WHERE organization_id=$1 ORDER BY id DESC`,
    [orgId]
  ); 
  return rows; 
}

async function createTemplate({ orgId, payload, client }) {
  const { rows } = await client.query(
    `INSERT INTO dunning_templates (organization_id, name, channel, subject, body, is_active)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orgId, payload.name, payload.channel || 'email', payload.subject || null, payload.body, payload.is_active !== false]
  ); 
  return rows[0]; 
}

async function updateTemplate({ orgId, id, payload, client }) {
  const { rows } = await client.query(
    `UPDATE dunning_templates
        SET name=COALESCE($3,name),
            channel=COALESCE($4,channel),
            subject=COALESCE($5,subject),
            body=COALESCE($6,body),
            is_active=COALESCE($7,is_active),
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, id, payload.name || null, payload.channel || null, payload.subject || null, payload.body || null, payload.is_active]
  ); 
  if (!rows.length) throw new AppError(404, 'Template not found'); 
  return rows[0]; 
}

async function deleteTemplate({ orgId, id, client }) {
  await client.query(`DELETE FROM dunning_templates WHERE organization_id=$1 AND id=$2`, [orgId, id]); 
  return { ok: true }; 
}

// Rules
async function listRules({ orgId, client }) {
  const { rows } = await client.query(
    `SELECT r.*, t.name AS template_name
       FROM dunning_rules r
       LEFT JOIN dunning_templates t ON t.id = r.template_id
      WHERE r.organization_id=$1
      ORDER BY r.id DESC`,
    [orgId]
  ); 
  return rows; 
}

async function createRule({ orgId, payload, client }) {
  const { rows } = await client.query(
    `INSERT INTO dunning_rules (organization_id, name, is_active, start_days_past_due, cadence_days, max_reminders, severity, template_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [orgId, payload.name, payload.is_active !== false, payload.start_days_past_due ?? 1, payload.cadence_days ?? 7, payload.max_reminders ?? 6, payload.severity || 'soft', payload.template_id || null]
  ); 
  return rows[0]; 
}

async function updateRule({ orgId, id, payload, client }) {
  const { rows } = await client.query(
    `UPDATE dunning_rules
        SET name=COALESCE($3,name),
            is_active=COALESCE($4,is_active),
            start_days_past_due=COALESCE($5,start_days_past_due),
            cadence_days=COALESCE($6,cadence_days),
            max_reminders=COALESCE($7,max_reminders),
            severity=COALESCE($8,severity),
            template_id=COALESCE($9,template_id),
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, id, payload.name || null, payload.is_active, payload.start_days_past_due, payload.cadence_days, payload.max_reminders, payload.severity, payload.template_id]
  ); 
  if (!rows.length) throw new AppError(404, 'Rule not found'); 
  return rows[0]; 
}

async function deleteRule({ orgId, id, client }) {
  await client.query(`DELETE FROM dunning_rules WHERE organization_id=$1 AND id=$2`, [orgId, id]); 
  return { ok: true }; 
}

// Cases
async function listCases({ orgId, status, client }) {
  const { rows } = await client.query(
    `SELECT c.*, p.name AS partner_name
       FROM collections_cases c
       JOIN business_partners p ON p.id=c.partner_id AND p.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND ($2::text IS NULL OR c.status=$2)
      ORDER BY c.opened_at DESC, c.id DESC`,
    [orgId, status || null]
  ); 
  return rows; 
}

async function createCase({ orgId, actorUserId, payload, client }) {
  const { rows } = await client.query(
    `INSERT INTO collections_cases (organization_id, partner_id, status, assigned_to_user_id, notes, created_by)
     VALUES ($1,$2,'open',$3,$4,$5)
     RETURNING *`,
    [orgId, payload.partner_id, payload.assigned_to_user_id || null, payload.notes || null, actorUserId]
  ); 
  return rows[0]; 
}

async function addCaseAction({ orgId, caseId, actorUserId, action_type, payload, client }) {
  const { rows } = await client.query(
    `INSERT INTO collections_actions (organization_id, case_id, action_type, payload, actor_user_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [orgId, caseId, action_type, payload || null, actorUserId]
  ); 
  return rows[0]; 
}

async function updateCase({ orgId, caseId, payload, client }) {
  const { rows } = await client.query(
    `UPDATE collections_cases
        SET status=COALESCE($3,status),
            assigned_to_user_id=COALESCE($4,assigned_to_user_id),
            notes=COALESCE($5,notes),
            closed_at = CASE WHEN COALESCE($3,status)='closed' THEN NOW() ELSE closed_at END,
            updated_at=NOW()
      WHERE organization_id=$1 AND id=$2
      RETURNING *`,
    [orgId, caseId, payload.status || null, payload.assigned_to_user_id, payload.notes]
  ); 
  if (!rows.length) throw new AppError(404, 'Case not found'); 
  return rows[0]; 
}

async function getCaseDetails({ orgId, caseId, client }) {
  const { rows } = await client.query(
    `SELECT c.*, p.name AS partner_name
       FROM collections_cases c
       JOIN business_partners p ON p.id=c.partner_id AND p.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND c.id=$2`,
    [orgId, caseId]
  ); 
  if (!rows.length) throw new AppError(404, 'Case not found'); 
  const c = rows[0]; 
  const actions = await client.query(
    `SELECT * FROM collections_actions WHERE organization_id=$1 AND case_id=$2 ORDER BY created_at DESC, id DESC`,
    [orgId, caseId]
  ); 
  return { ...c, actions: actions.rows }; 
}

// Dunning runs
async function generateDunningRun({ orgId, actorUserId, ruleId, asOfDate, client }) {
  const ruleRes = await client.query(`SELECT * FROM dunning_rules WHERE organization_id=$1 AND id=$2`, [orgId, ruleId]); 
  if (!ruleRes.rows.length) throw new AppError(404, 'Rule not found'); 
  const rule = ruleRes.rows[0]; 
  if (!rule.is_active) throw new AppError(400, 'Rule is inactive'); 

  const tpl = rule.template_id
    ? (await client.query(`SELECT * FROM dunning_templates WHERE organization_id=$1 AND id=$2`, [orgId, rule.template_id])).rows[0]
    : null; 

  const { rows: runRows } = await client.query(
    `INSERT INTO dunning_runs (organization_id, rule_id, status, run_at, created_by)
     VALUES ($1,$2,'generated',$3,$4)
     RETURNING *`,
    [orgId, ruleId, asOfDate, actorUserId]
  ); 
  const run = runRows[0]; 

  // Select eligible invoices
  const { rows: invoices } = await client.query(
    `SELECT
        oi.invoice_id,
        oi.customer_id AS partner_id,
        oi.invoice_no,
        oi.due_date,
        oi.currency_code,
        GREATEST(0, DATE_PART('day', $2::date - oi.due_date::date)) AS days_past_due,
        GREATEST(oi.outstanding,0) AS amount_due
     FROM reporting_ar_open_items oi
     WHERE oi.organization_id=$1
       AND oi.outstanding > 0
       AND oi.due_date IS NOT NULL
       AND DATE_PART('day', $2::date - oi.due_date::date) >= $3
       AND NOT EXISTS (
         SELECT 1 FROM disputes d
         WHERE d.organization_id=$1 AND d.entity_type='invoice' AND d.entity_id=oi.invoice_id AND d.status='open'
       )`,
    [orgId, asOfDate, rule.start_days_past_due]
  ); 

  for (const inv of invoices) {
    const preview = tpl
      ? {
          channel: tpl.channel,
          subject: tpl.subject || 'Payment reminder',
          body: tpl.body
            .replace(/{{customer_name}}/g, '')
            .replace(/{{invoice_no}}/g, String(inv.invoice_no || ''))
            .replace(/{{amount_due}}/g, String(inv.amount_due || '0'))
            .replace(/{{days_past_due}}/g, String(inv.days_past_due || '0'))
        }
      : null; 
    await client.query(
      `INSERT INTO dunning_run_items (organization_id, run_id, partner_id, invoice_id, days_past_due, amount_due, message_preview, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [orgId, run.id, inv.partner_id, inv.invoice_id, Math.floor(inv.days_past_due || 0), inv.amount_due, preview]
    ); 
  }

  return run; 
}

async function getDunningRun({ orgId, runId, client }) {
  const run = await client.query(`SELECT * FROM dunning_runs WHERE organization_id=$1 AND id=$2`, [orgId, runId]); 
  if (!run.rows.length) throw new AppError(404, 'Run not found'); 
  const items = await client.query(
    `SELECT i.*, p.name AS partner_name
       FROM dunning_run_items i
       JOIN business_partners p ON p.id=i.partner_id AND p.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.run_id=$2
      ORDER BY i.days_past_due DESC, i.amount_due DESC`,
    [orgId, runId]
  ); 
  return { ...run.rows[0], items: items.rows }; 
}

module.exports = {
  listQueue,
  listPartnerOpenInvoices,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  listCases,
  createCase,
  updateCase,
  addCaseAction,
  getCaseDetails,
  generateDunningRun,
  getDunningRun
}; 
