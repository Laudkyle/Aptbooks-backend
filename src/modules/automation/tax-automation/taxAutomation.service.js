const { pool } = require('../../../db/pool');

async function dashboard({ orgId }) {
  const [{ rows: queuedEInv }, { rows: pendingFilings }, { rows: reconIssues }, { rows: rules }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM e_invoices WHERE organization_id=$1 AND status IN ('generated','queued')`, [orgId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM tax_filing_runs WHERE organization_id=$1 AND status IN ('queued','running')`, [orgId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM tax_reconciliation_items tri JOIN tax_reconciliation_runs trr ON trr.id=tri.run_id WHERE trr.organization_id=$1`, [orgId]),
    pool.query(`SELECT * FROM tax_automation_rules WHERE organization_id=$1 ORDER BY code`, [orgId])
  ]);
  return {
    queuedEinvoices: queuedEInv[0]?.count || 0,
    pendingFilings: pendingFilings[0]?.count || 0,
    reconciliationIssues: reconIssues[0]?.count || 0,
    rules
  };
}

async function upsertRule({ orgId, payload }) {
  const { rows } = await pool.query(
    `INSERT INTO tax_automation_rules(organization_id, code, name, is_enabled, trigger_type, config_json)
     VALUES($1,$2,$3,COALESCE($4,true),COALESCE($5,'scheduled'),$6::jsonb)
     ON CONFLICT (organization_id, code) DO UPDATE SET name=EXCLUDED.name, is_enabled=EXCLUDED.is_enabled, trigger_type=EXCLUDED.trigger_type, config_json=EXCLUDED.config_json, updated_at=NOW()
     RETURNING *`,
    [orgId, payload.code, payload.name, payload.isEnabled, payload.triggerType, JSON.stringify(payload.config || {})]
  );
  return rows[0];
}

async function runAdvisor({ orgId }) {
  const { rows: einvoiceRows } = await pool.query(`SELECT id, source_id, created_at FROM e_invoices WHERE organization_id=$1 AND status='generated' ORDER BY created_at ASC LIMIT 25`, [orgId]);
  const { rows: filingRows } = await pool.query(`SELECT id, tax_return_id, created_at FROM tax_filing_runs WHERE organization_id=$1 AND status='queued' ORDER BY created_at ASC LIMIT 25`, [orgId]);
  const { rows: returnsRows } = await pool.query(`SELECT id, tax_type, from_date, to_date, status FROM tax_returns WHERE organization_id=$1 AND status='draft' ORDER BY created_at DESC LIMIT 10`, [orgId]);
  return {
    recommendations: [
      ...(einvoiceRows.length ? [{ code: 'queue_einvoices', severity: 'medium', count: einvoiceRows.length, items: einvoiceRows }] : []),
      ...(filingRows.length ? [{ code: 'transmit_filing_runs', severity: 'high', count: filingRows.length, items: filingRows }] : []),
      ...(returnsRows.length ? [{ code: 'review_draft_returns', severity: 'medium', count: returnsRows.length, items: returnsRows }] : [])
    ]
  };
}

module.exports = { dashboard, upsertRule, runAdvisor };
