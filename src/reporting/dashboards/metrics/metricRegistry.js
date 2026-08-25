const repo = require('./metric.repository');

const V = Object.freeze({
  KPI:'kpi', TREND:'trend', LINE:'line', BAR:'bar', STACKED:'stacked_bar', AREA:'area', DONUT:'donut', TABLE:'table', PROGRESS:'progress', AGING:'aging', EXCEPTION:'exception'
});

function metric(def) {
  return Object.freeze({
    cacheTtlMs: 60_000,
    allowedVisualizations: [V.KPI,V.BAR,V.LINE,V.TABLE],
    allowedGroupBy: [],
    ...def,
  });
}

const metrics = [
  metric({ key:'accounting.revenue', domain:'Accounting', label:'Revenue', description:'Posted revenue in base currency.', type:'money', permission:'accounting.balances.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TREND,V.LINE,V.BAR,V.AREA,V.TABLE], allowedGroupBy:['month'], drilldown:'/accounting/profit-loss', execute:(ctx)=>repo.accountingProfit({...ctx,kind:'revenue'}) }),
  metric({ key:'accounting.expenses', domain:'Accounting', label:'Expenses', description:'Posted expenses in base currency.', type:'money', permission:'accounting.balances.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TREND,V.LINE,V.BAR,V.AREA,V.TABLE], allowedGroupBy:['month'], drilldown:'/accounting/profit-loss', execute:(ctx)=>repo.accountingProfit({...ctx,kind:'expenses'}) }),
  metric({ key:'accounting.net_profit', domain:'Accounting', label:'Net profit', description:'Posted revenue less posted expenses in base currency.', type:'money', permission:'accounting.balances.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TREND,V.LINE,V.BAR,V.AREA,V.TABLE], allowedGroupBy:['month'], drilldown:'/accounting/profit-loss', execute:repo.accountingNetProfit }),
  metric({ key:'accounting.posted_journals', domain:'Accounting', label:'Posted journals', description:'Count of posted journals.', type:'count', permission:'accounting.journal.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TREND,V.LINE,V.BAR,V.TABLE], allowedGroupBy:['month'], drilldown:'/accounting/journals', execute:repo.postedJournalCount }),

  metric({ key:'receivables.outstanding', domain:'Receivables', label:'Outstanding receivables', description:'Open customer invoice balances.', type:'money_multi_currency', permission:'reporting.ar.read', defaultVisualization:V.BAR, allowedVisualizations:[V.KPI,V.BAR,V.DONUT,V.TABLE], allowedGroupBy:['currency'], drilldown:'/reports/ar/open-items', execute:(ctx)=>repo.openItems({...ctx,side:'ar',overdue:false}) }),
  metric({ key:'receivables.overdue', domain:'Receivables', label:'Overdue receivables', description:'Customer balances past due.', type:'money_multi_currency', permission:'reporting.ar.read', defaultVisualization:V.BAR, allowedVisualizations:[V.KPI,V.BAR,V.DONUT,V.TABLE,V.EXCEPTION], allowedGroupBy:['currency'], drilldown:'/reports/ar/aging', execute:(ctx)=>repo.openItems({...ctx,side:'ar',overdue:true}) }),
  metric({ key:'payables.outstanding', domain:'Payables', label:'Outstanding payables', description:'Open supplier bill balances.', type:'money_multi_currency', permission:'reporting.ap.read', defaultVisualization:V.BAR, allowedVisualizations:[V.KPI,V.BAR,V.DONUT,V.TABLE], allowedGroupBy:['currency'], drilldown:'/reports/ap/open-items', execute:(ctx)=>repo.openItems({...ctx,side:'ap',overdue:false}) }),
  metric({ key:'payables.overdue', domain:'Payables', label:'Overdue payables', description:'Supplier balances past due.', type:'money_multi_currency', permission:'reporting.ap.read', defaultVisualization:V.BAR, allowedVisualizations:[V.KPI,V.BAR,V.DONUT,V.TABLE,V.EXCEPTION], allowedGroupBy:['currency'], drilldown:'/reports/ap/aging', execute:(ctx)=>repo.openItems({...ctx,side:'ap',overdue:true}) }),

  metric({ key:'banking.unmatched_lines', domain:'Banking', label:'Unmatched statement lines', description:'Statement lines still requiring matching.', type:'count', permission:'banking.statements.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.PROGRESS,V.EXCEPTION], drilldown:'/banking/reconciliation', execute:repo.bankingUnmatched }),
  metric({ key:'banking.active_accounts', domain:'Banking', label:'Active bank accounts', description:'Active bank and cash accounts.', type:'count', permission:'banking.accounts.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TABLE], drilldown:'/banking/accounts', execute:repo.activeBankAccounts }),
  metric({ key:'treasury.available_cash', domain:'Treasury', label:'Available cash by currency', description:'Posted bank GL position grouped by currency.', type:'money_multi_currency', permission:'banking.treasury.read', defaultVisualization:V.BAR, allowedVisualizations:[V.BAR,V.DONUT,V.TABLE], allowedGroupBy:['currency'], drilldown:'/banking/treasury', cacheTtlMs:30_000, execute:repo.treasuryCash }),
  metric({ key:'treasury.approved_outflows', domain:'Treasury', label:'Approved outflows', description:'Approved payment and transfer instructions awaiting execution.', type:'money_multi_currency', permission:'banking.treasury.read', defaultVisualization:V.BAR, allowedVisualizations:[V.BAR,V.DONUT,V.TABLE,V.EXCEPTION], allowedGroupBy:['currency'], drilldown:'/banking/treasury/payments', cacheTtlMs:30_000, execute:repo.treasuryApprovedOutflows }),

  metric({ key:'inventory.inventory_value', domain:'Inventory', label:'Inventory value', description:'Current inventory valuation in base currency.', type:'money', permission:'inventory.items.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TREND,V.TABLE], drilldown:'/inventory', execute:repo.inventoryValue }),
  metric({ key:'inventory.low_stock_items', domain:'Inventory', label:'Low stock items', description:'Active items at or below reorder point.', type:'count', permission:'inventory.reorder.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.EXCEPTION,V.PROGRESS], drilldown:'/inventory/stock-control', execute:repo.lowStock }),
  metric({ key:'inventory.integrity_exceptions', domain:'Inventory', label:'Inventory exceptions', description:'Negative balances and approved movements missing accounting provenance.', type:'count', permission:'inventory.transactions.read', defaultVisualization:V.EXCEPTION, allowedVisualizations:[V.KPI,V.EXCEPTION], drilldown:'/inventory', execute:repo.inventoryExceptions }),

  metric({ key:'assets.carrying_value', domain:'Fixed Assets', label:'Carrying value', description:'Gross cost plus revaluations less depreciation and impairment.', type:'money', permission:'assets.fixed_assets.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TREND,V.TABLE], drilldown:'/assets', execute:(ctx)=>repo.assetSummary({...ctx,field:'carrying_value'}) }),
  metric({ key:'assets.accumulated_depreciation', domain:'Fixed Assets', label:'Accumulated depreciation', description:'Posted accumulated depreciation.', type:'money', permission:'assets.fixed_assets.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TREND,V.TABLE], drilldown:'/assets/depreciation', execute:(ctx)=>repo.assetSummary({...ctx,field:'accumulated_depreciation'}) }),
  metric({ key:'assets.active_assets', domain:'Fixed Assets', label:'Active assets', description:'Active assets in the fixed asset register.', type:'count', permission:'assets.fixed_assets.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TABLE], drilldown:'/assets/register', execute:(ctx)=>repo.assetSummary({...ctx,field:'active_assets'}) }),

  metric({ key:'tax.withholding_open', domain:'Tax', label:'Open withholding exposure', description:'Open Ghana withholding events.', type:'money', permission:'tax.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.EXCEPTION,V.TABLE], drilldown:'/accounting/tax/withholding', execute:repo.taxWithholdingOpen }),
  metric({ key:'tax.evat_pending', domain:'Tax', label:'E-VAT queue pending', description:'Fiscal transmissions requiring processing or retry.', type:'count', permission:'fiscalization.read', defaultVisualization:V.EXCEPTION, allowedVisualizations:[V.KPI,V.EXCEPTION,V.PROGRESS], drilldown:'/accounting/tax/e-vat', execute:repo.evatPending }),
  metric({ key:'tax.evat_failures', domain:'Tax', label:'E-VAT failures', description:'Fiscal documents rejected or failed.', type:'count', permission:'fiscalization.read', defaultVisualization:V.EXCEPTION, allowedVisualizations:[V.KPI,V.EXCEPTION], drilldown:'/accounting/tax/e-vat', execute:repo.evatRejected }),

  metric({ key:'commerce.sales', domain:'Commerce', label:'Sales', description:'Completed and posted POS sales grouped by currency.', type:'money_multi_currency', permission:'pos.reports.view', defaultVisualization:V.BAR, allowedVisualizations:[V.BAR,V.DONUT,V.TABLE], allowedGroupBy:['currency','month'], drilldown:'/commerce', execute:repo.commerceSales }),
  metric({ key:'commerce.gross_margin', domain:'Commerce', label:'Gross margin', description:'Sales less recorded cost of goods sold.', type:'money_multi_currency', permission:'pos.reports.view', defaultVisualization:V.BAR, allowedVisualizations:[V.BAR,V.DONUT,V.TABLE], allowedGroupBy:['currency'], drilldown:'/commerce', execute:repo.commerceGrossMargin }),

  metric({ key:'hr.headcount', domain:'HR', label:'Active headcount', description:'Active employees.', type:'count', permission:'hr.employees.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.BAR,V.DONUT,V.TABLE], allowedGroupBy:['department'], drilldown:'/hr/employees', execute:repo.hrHeadcount }),
  metric({ key:'hr.payroll_cost', domain:'HR', label:'Payroll gross cost', description:'Calculated and posted gross payroll by currency.', type:'money_multi_currency', permission:'hr.payroll.read', defaultVisualization:V.BAR, allowedVisualizations:[V.BAR,V.DONUT,V.TABLE], allowedGroupBy:['currency'], drilldown:'/hr/payroll', execute:repo.hrPayroll }),

  metric({ key:'planning.active_projects', domain:'Planning', label:'Active projects', description:'Active projects.', type:'count', permission:'reporting.projects.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TABLE], drilldown:'/planning/projects', execute:(ctx)=>repo.planningCount({...ctx,table:'projects',statusValues:['active']}) }),
  metric({ key:'planning.active_budgets', domain:'Planning', label:'Active budgets', description:'Active budgets.', type:'count', permission:'reporting.budgets.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TABLE], drilldown:'/planning/budgets', execute:(ctx)=>repo.planningCount({...ctx,table:'budgets',statusValues:['active']}) }),
  metric({ key:'planning.active_forecasts', domain:'Planning', label:'Active forecasts', description:'Active forecasts.', type:'count', permission:'reporting.forecasts.read', defaultVisualization:V.KPI, allowedVisualizations:[V.KPI,V.TABLE], drilldown:'/planning/forecasts', execute:(ctx)=>repo.planningCount({...ctx,table:'forecasts',statusValues:['active']}) }),
  metric({ key:'workflow.pending_approvals', domain:'Workflow', label:'Pending approvals', description:'Document approvals awaiting action.', type:'count', permission:'approvals.inbox.read', defaultVisualization:V.EXCEPTION, allowedVisualizations:[V.KPI,V.EXCEPTION,V.PROGRESS], drilldown:'/approvals', cacheTtlMs:30_000, execute:repo.pendingApprovals }),
];

const byKey = new Map(metrics.map((m)=>[m.key,m]));

function getMetric(key) { return byKey.get(String(key||'')) || null; }
function listMetrics() { return metrics.slice(); }
function publicMetric(def) {
  return {
    key:def.key, domain:def.domain, label:def.label, description:def.description, type:def.type,
    permission:def.permission, defaultVisualization:def.defaultVisualization,
    allowedVisualizations:def.allowedVisualizations, allowedGroupBy:def.allowedGroupBy, drilldown:def.drilldown,
  };
}

module.exports={ V, getMetric, listMetrics, publicMetric };
