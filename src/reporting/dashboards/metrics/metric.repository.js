const { pool } = require('../../../db/pool');

async function baseCurrency(organizationId) {
  const { rows } = await pool.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1 LIMIT 1`, [organizationId]
  );
  return rows[0]?.base_currency_code || 'GHS';
}

async function hasPermission({ organizationId, userId, permission }) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM user_roles ur
       JOIN roles r ON r.id=ur.role_id AND r.organization_id=$2
       JOIN role_permissions rp ON rp.role_id=r.id
       JOIN permissions p ON p.id=rp.permission_id
      WHERE ur.user_id=$1 AND p.code=$3
      LIMIT 1`,
    [userId, organizationId, permission]
  );
  return rows.length > 0;
}

function dateClause(column, filters, params, startIndex) {
  const clauses = [];
  let i = startIndex;
  if (filters?.fromDate) { clauses.push(`${column} >= $${i++}::date`); params.push(filters.fromDate); }
  if (filters?.toDate) { clauses.push(`${column} <= $${i++}::date`); params.push(filters.toDate); }
  return clauses;
}

async function accountingProfit({ organizationId, filters = {}, kind, groupBy }) {
  const params = [organizationId];
  const dates = dateClause('je.entry_date', filters, params, 2);
  const accountCodes = kind === 'revenue' ? ['REVENUE'] : ['EXPENSE'];
  params.push(accountCodes);
  const codeParam = params.length;
  // journal_entry_lines.amount_base is the canonical exact base-currency amount.
  // Never recompute financial totals with JavaScript Number or nominal FX arithmetic here.
  const amount = `CASE
    WHEN at.code='REVENUE' THEN CASE WHEN jel.credit>0 THEN jel.amount_base ELSE -jel.amount_base END
    ELSE CASE WHEN jel.debit>0 THEN jel.amount_base ELSE -jel.amount_base END
  END`;
  if (groupBy === 'month') {
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('month',je.entry_date),'YYYY-MM') AS label,
              COALESCE(SUM(${amount}),0)::numeric AS value
         FROM journal_entries je
         JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
         JOIN chart_of_accounts coa ON coa.id=jel.account_id AND coa.organization_id=je.organization_id
         JOIN account_types at ON at.id=coa.account_type_id
        WHERE je.organization_id=$1 AND je.status='posted'
          AND at.code=ANY($${codeParam}::text[]) ${dates.length ? `AND ${dates.join(' AND ')}` : ''}
        GROUP BY date_trunc('month',je.entry_date)
        ORDER BY date_trunc('month',je.entry_date)`, params);
    return { kind:'series', points: rows };
  }
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${amount}),0)::numeric AS value
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
       JOIN chart_of_accounts coa ON coa.id=jel.account_id AND coa.organization_id=je.organization_id
       JOIN account_types at ON at.id=coa.account_type_id
      WHERE je.organization_id=$1 AND je.status='posted'
        AND at.code=ANY($${codeParam}::text[]) ${dates.length ? `AND ${dates.join(' AND ')}` : ''}`,
    params
  );
  return { kind:'scalar', value: rows[0]?.value || '0' };
}

async function accountingNetProfit({ organizationId, filters = {}, groupBy }) {
  const params = [organizationId];
  const dates = dateClause('je.entry_date', filters, params, 2);
  const amount = `CASE
    WHEN at.code='REVENUE' THEN CASE WHEN jel.credit>0 THEN jel.amount_base ELSE -jel.amount_base END
    WHEN at.code='EXPENSE' THEN -(CASE WHEN jel.debit>0 THEN jel.amount_base ELSE -jel.amount_base END)
    ELSE 0::numeric
  END`;
  if (groupBy === 'month') {
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('month',je.entry_date),'YYYY-MM') AS label,
              COALESCE(SUM(${amount}),0)::numeric AS value
         FROM journal_entries je
         JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
         JOIN chart_of_accounts coa ON coa.id=jel.account_id AND coa.organization_id=je.organization_id
         JOIN account_types at ON at.id=coa.account_type_id
        WHERE je.organization_id=$1 AND je.status='posted'
          AND at.code IN ('REVENUE','EXPENSE') ${dates.length ? `AND ${dates.join(' AND ')}` : ''}
        GROUP BY date_trunc('month',je.entry_date)
        ORDER BY date_trunc('month',je.entry_date)`, params);
    return { kind:'series', points: rows };
  }
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${amount}),0)::numeric AS value
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id
       JOIN chart_of_accounts coa ON coa.id=jel.account_id AND coa.organization_id=je.organization_id
       JOIN account_types at ON at.id=coa.account_type_id
      WHERE je.organization_id=$1 AND je.status='posted'
        AND at.code IN ('REVENUE','EXPENSE') ${dates.length ? `AND ${dates.join(' AND ')}` : ''}`,
    params
  );
  return { kind:'scalar', value: rows[0]?.value || '0' };
}

async function postedJournalCount({ organizationId, filters = {}, groupBy }) {
  const params=[organizationId]; const dates=dateClause('entry_date',filters,params,2);
  if (groupBy==='month') {
    const { rows }=await pool.query(
      `SELECT to_char(date_trunc('month',entry_date),'YYYY-MM') AS label, COUNT(*)::int AS value
       FROM journal_entries WHERE organization_id=$1 AND status='posted' ${dates.length?`AND ${dates.join(' AND ')}`:''}
       GROUP BY date_trunc('month',entry_date) ORDER BY date_trunc('month',entry_date)`,params);
    return { kind:'series', points:rows };
  }
  const {rows}=await pool.query(`SELECT COUNT(*)::int AS value FROM journal_entries WHERE organization_id=$1 AND status='posted' ${dates.length?`AND ${dates.join(' AND ')}`:''}`,params);
  return {kind:'scalar',value:rows[0]?.value||0};
}

async function openItems({ organizationId, filters={}, side, overdue=false, groupBy }) {
  const view=side==='ar'?'reporting_ar_open_items':'reporting_ap_open_items';
  const dateCol=side==='ar'?'invoice_date':'bill_date';
  const params=[organizationId]; const dates=dateClause(dateCol,filters,params,2);
  const overdueSql=overdue?`AND due_date < CURRENT_DATE`:'';
  if (groupBy==='currency') {
    const {rows}=await pool.query(`SELECT currency_code AS label, COALESCE(SUM(outstanding),0)::numeric AS value FROM ${view} WHERE organization_id=$1 AND outstanding>0 ${overdueSql} ${dates.length?`AND ${dates.join(' AND ')}`:''} GROUP BY currency_code ORDER BY currency_code`,params);
    return {kind:'series',points:rows};
  }
  const {rows}=await pool.query(`SELECT currency_code, COALESCE(SUM(outstanding),0)::numeric AS value FROM ${view} WHERE organization_id=$1 AND outstanding>0 ${overdueSql} ${dates.length?`AND ${dates.join(' AND ')}`:''} GROUP BY currency_code ORDER BY currency_code`,params);
  if (rows.length===1) return {kind:'scalar',value:rows[0].value,currencyCode:rows[0].currency_code};
  return {kind:'series',points:rows.map(r=>({label:r.currency_code,value:r.value,currencyCode:r.currency_code}))};
}

async function bankingUnmatched({ organizationId }) {
  const {rows}=await pool.query(`SELECT COALESCE(SUM(unmatched_count),0)::int AS value FROM reporting_bank_statement_status WHERE organization_id=$1`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}
async function activeBankAccounts({ organizationId }) {
  const {rows}=await pool.query(`SELECT COUNT(*)::int AS value FROM bank_accounts WHERE organization_id=$1 AND is_active=TRUE`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}
async function treasuryCash({ organizationId }) {
  const {rows}=await pool.query(
    `SELECT ba.currency_code AS label,
            COALESCE(SUM(CASE WHEN je.status='posted' THEN (jel.debit-jel.credit) ELSE 0 END),0)::numeric AS value
       FROM bank_accounts ba
       LEFT JOIN journal_entry_lines jel ON jel.account_id=ba.gl_account_id AND jel.currency_code=ba.currency_code
       LEFT JOIN journal_entries je ON je.id=jel.journal_entry_id AND je.organization_id=ba.organization_id
      WHERE ba.organization_id=$1 AND ba.is_active=TRUE
      GROUP BY ba.currency_code ORDER BY ba.currency_code`,[organizationId]);
  return {kind:'series',points:rows.map(r=>({...r,currencyCode:r.label}))};
}
async function treasuryApprovedOutflows({ organizationId }) {
  const {rows}=await pool.query(
    `WITH outflows AS (
       SELECT currency_code, COALESCE(control_total,(SELECT COALESCE(SUM(l.amount),0) FROM payment_run_lines l WHERE l.payment_run_id=pr.id)) AS amount
         FROM payment_runs pr WHERE organization_id=$1 AND status='approved'
       UNION ALL
       SELECT COALESCE(source_currency_code,ba.currency_code) AS currency_code, (bt.amount+bt.fee_amount) AS amount
         FROM bank_transfers bt JOIN bank_accounts ba ON ba.id=bt.from_bank_account_id AND ba.organization_id=bt.organization_id
        WHERE bt.organization_id=$1 AND bt.status='approved'
     ) SELECT currency_code AS label, COALESCE(SUM(amount),0)::numeric AS value FROM outflows GROUP BY currency_code ORDER BY currency_code`,[organizationId]);
  return {kind:'series',points:rows.map(r=>({...r,currencyCode:r.label}))};
}

async function inventoryValue({ organizationId }) {
  const currencyCode=await baseCurrency(organizationId);
  const {rows}=await pool.query(`SELECT COALESCE(SUM(extended_value),0)::numeric AS value FROM reporting_inventory_valuation_current WHERE organization_id=$1`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||'0',currencyCode};
}
async function lowStock({ organizationId }) {
  const {rows}=await pool.query(
    `SELECT COUNT(*)::int AS value FROM inventory_items i
      WHERE i.organization_id=$1 AND i.is_active=TRUE AND COALESCE(i.reorder_point,0)>0
        AND COALESCE((SELECT SUM(b.qty_on_hand) FROM inventory_balances b WHERE b.organization_id=i.organization_id AND b.item_id=i.id),0) <= i.reorder_point`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}
async function inventoryExceptions({ organizationId }) {
  const {rows}=await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM inventory_balances b WHERE b.organization_id=$1 AND (b.qty_on_hand<0 OR b.avg_unit_cost<0))::int
       + (SELECT COUNT(*) FROM inventory_transactions t WHERE t.organization_id=$1 AND t.status='approved' AND t.journal_entry_id IS NULL)::int AS value`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}

async function assetSummary({ organizationId, field }) {
  const currencyCode=await baseCurrency(organizationId);
  const {rows}=await pool.query(
    `WITH dep AS (SELECT asset_id,COALESCE(SUM(amount),0)::numeric AS accumulated FROM asset_depreciation_transactions WHERE organization_id=$1 GROUP BY asset_id),
          rev AS (SELECT asset_id,COALESCE(SUM(CASE WHEN payload_json ? 'delta' THEN (payload_json->>'delta')::numeric ELSE 0 END),0)::numeric AS delta FROM asset_events WHERE organization_id=$1 AND event_type='revaluation' GROUP BY asset_id)
     SELECT COUNT(*) FILTER (WHERE a.status='active')::int AS active_assets,
            COALESCE(SUM(COALESCE(dep.accumulated,0)) FILTER (WHERE a.status IN ('active','retired')),0)::numeric AS accumulated_depreciation,
            COALESCE(SUM(a.cost+COALESCE(rev.delta,0)-COALESCE(dep.accumulated,0)-COALESCE(a.impairment_total,0)) FILTER (WHERE a.status IN ('active','retired')),0)::numeric AS carrying_value
       FROM fixed_assets a LEFT JOIN dep ON dep.asset_id=a.id LEFT JOIN rev ON rev.asset_id=a.id WHERE a.organization_id=$1`,[organizationId]);
  const value=rows[0]?.[field] ?? (field==='active_assets'?0:'0');
  return field==='active_assets'?{kind:'scalar',value}:{kind:'scalar',value,currencyCode};
}

async function taxWithholdingOpen({ organizationId }) {
  const currencyCode=await baseCurrency(organizationId);
  const {rows}=await pool.query(`SELECT COALESCE(SUM(withheld_amount),0)::numeric AS value FROM ghana_withholding_events WHERE organization_id=$1 AND status='open'`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||'0',currencyCode};
}
async function evatPending({ organizationId }) {
  const {rows}=await pool.query(`SELECT COUNT(*)::int AS value FROM fiscal_transmission_queue WHERE organization_id=$1 AND status IN ('queued','claimed','retry','failed','dead_letter')`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}
async function evatRejected({ organizationId }) {
  const {rows}=await pool.query(`SELECT COUNT(*)::int AS value FROM fiscal_documents WHERE organization_id=$1 AND status IN ('rejected','failed')`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}

async function commerceSales({ organizationId, filters={}, groupBy }) {
  const params=[organizationId]; const dates=dateClause('sale_date',filters,params,2);
  if (groupBy==='month') {
    const {rows}=await pool.query(`SELECT to_char(date_trunc('month',sale_date),'YYYY-MM') AS label, currency_code, COALESCE(SUM(total_amount),0)::numeric AS value FROM pos_sales WHERE organization_id=$1 AND status IN ('completed','posted','partially_returned','partially_refunded') ${dates.length?`AND ${dates.join(' AND ')}`:''} GROUP BY date_trunc('month',sale_date),currency_code ORDER BY date_trunc('month',sale_date),currency_code`,params);
    return {kind:'table',rows};
  }
  const {rows}=await pool.query(`SELECT currency_code AS label, COALESCE(SUM(total_amount),0)::numeric AS value FROM pos_sales WHERE organization_id=$1 AND status IN ('completed','posted','partially_returned','partially_refunded') ${dates.length?`AND ${dates.join(' AND ')}`:''} GROUP BY currency_code ORDER BY currency_code`,params);
  return {kind:'series',points:rows.map(r=>({...r,currencyCode:r.label}))};
}
async function commerceGrossMargin({ organizationId, filters={} }) {
  const params=[organizationId]; const dates=dateClause('sale_date',filters,params,2);
  const {rows}=await pool.query(`SELECT currency_code AS label, COALESCE(SUM(total_amount-cogs_amount),0)::numeric AS value FROM pos_sales WHERE organization_id=$1 AND status IN ('completed','posted','partially_returned','partially_refunded') ${dates.length?`AND ${dates.join(' AND ')}`:''} GROUP BY currency_code ORDER BY currency_code`,params);
  return {kind:'series',points:rows.map(r=>({...r,currencyCode:r.label}))};
}

async function hrHeadcount({ organizationId, groupBy }) {
  if (groupBy==='department') {
    const {rows}=await pool.query(`SELECT COALESCE(d.name,'Unassigned') AS label, COUNT(*)::int AS value FROM hr_employees e LEFT JOIN hr_departments d ON d.id=e.department_id AND d.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.status='active' GROUP BY COALESCE(d.name,'Unassigned') ORDER BY value DESC,label`,[organizationId]);
    return {kind:'series',points:rows};
  }
  const {rows}=await pool.query(`SELECT COUNT(*)::int AS value FROM hr_employees WHERE organization_id=$1 AND status='active'`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}
async function hrPayroll({ organizationId, filters={} }) {
  const params=[organizationId]; const dates=dateClause('pr.pay_date',filters,params,2);
  const {rows}=await pool.query(`SELECT l.currency AS label, COALESCE(SUM(l.gross_pay),0)::numeric AS value FROM hr_payroll_run_lines l JOIN hr_payroll_runs pr ON pr.id=l.payroll_run_id AND pr.organization_id=l.organization_id WHERE l.organization_id=$1 AND pr.status IN ('calculated','posted') ${dates.length?`AND ${dates.join(' AND ')}`:''} GROUP BY l.currency ORDER BY l.currency`,params);
  return {kind:'series',points:rows.map(r=>({...r,currencyCode:r.label}))};
}

async function planningCount({ organizationId, table, statusValues }) {
  const {rows}=await pool.query(`SELECT COUNT(*)::int AS value FROM ${table} WHERE organization_id=$1 AND status=ANY($2::text[])`,[organizationId,statusValues]);
  return {kind:'scalar',value:rows[0]?.value||0};
}
async function pendingApprovals({ organizationId }) {
  const {rows}=await pool.query(`SELECT COUNT(*)::int AS value FROM document_approvals da JOIN documents d ON d.id=da.document_id WHERE d.organization_id=$1 AND da.status='PENDING'`,[organizationId]);
  return {kind:'scalar',value:rows[0]?.value||0};
}

module.exports={
  baseCurrency,hasPermission,accountingProfit,accountingNetProfit,postedJournalCount,openItems,bankingUnmatched,activeBankAccounts,
  treasuryCash,treasuryApprovedOutflows,inventoryValue,lowStock,inventoryExceptions,assetSummary,taxWithholdingOpen,
  evatPending,evatRejected,commerceSales,commerceGrossMargin,hrHeadcount,hrPayroll,planningCount,pendingApprovals,
};
