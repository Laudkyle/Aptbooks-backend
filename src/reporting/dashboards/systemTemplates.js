const templates = [
  {
    id: 'system:executive-360',
    scope: 'system',
    name: 'Executive 360',
    description: 'A cross-application leadership dashboard covering performance, liquidity, working capital, operations and control exceptions.',
    definition: {
      defaultFilters: { preset: 'this_month' },
      widgets: [
        { title: 'Revenue', metricKey: 'accounting.revenue', visualization: 'trend', position: { x: 0, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Net profit', metricKey: 'accounting.net_profit', visualization: 'trend', position: { x: 3, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Available cash', metricKey: 'treasury.available_cash', visualization: 'bar', position: { x: 6, y: 0, w: 3, h: 2 }, config: { groupBy: 'currency' } },
        { title: 'Overdue receivables', metricKey: 'receivables.overdue', visualization: 'bar', position: { x: 9, y: 0, w: 3, h: 2 }, config: { groupBy: 'currency' } },
        { title: 'Revenue trend', metricKey: 'accounting.revenue', visualization: 'line', position: { x: 0, y: 2, w: 6, h: 4 }, config: { groupBy: 'month' } },
        { title: 'Inventory value', metricKey: 'inventory.inventory_value', visualization: 'kpi', position: { x: 6, y: 2, w: 3, h: 2 }, config: {} },
        { title: 'Asset carrying value', metricKey: 'assets.carrying_value', visualization: 'kpi', position: { x: 9, y: 2, w: 3, h: 2 }, config: {} },
        { title: 'Pending approvals', metricKey: 'workflow.pending_approvals', visualization: 'exception', position: { x: 6, y: 4, w: 3, h: 2 }, config: {} },
        { title: 'E-VAT failures', metricKey: 'tax.evat_failures', visualization: 'exception', position: { x: 9, y: 4, w: 3, h: 2 }, config: {} },
        { title: 'Active headcount', metricKey: 'hr.headcount', visualization: 'kpi', position: { x: 0, y: 6, w: 3, h: 2 }, config: {} },
        { title: 'Active projects', metricKey: 'planning.active_projects', visualization: 'kpi', position: { x: 3, y: 6, w: 3, h: 2 }, config: {} },
        { title: 'Low stock items', metricKey: 'inventory.low_stock_items', visualization: 'exception', position: { x: 6, y: 6, w: 3, h: 2 }, config: {} },
        { title: 'Unmatched bank lines', metricKey: 'banking.unmatched_lines', visualization: 'exception', position: { x: 9, y: 6, w: 3, h: 2 }, config: {} },
      ],
    },
  },
  {
    id: 'system:finance-liquidity-control',
    scope: 'system',
    name: 'Finance & Liquidity Control',
    description: 'A CFO-ready view of profitability, cash, working capital, journals and treasury commitments.',
    definition: {
      defaultFilters: { preset: 'this_financial_year' },
      widgets: [
        { title: 'Revenue', metricKey: 'accounting.revenue', visualization: 'trend', position: { x: 0, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Expenses', metricKey: 'accounting.expenses', visualization: 'trend', position: { x: 3, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Net profit', metricKey: 'accounting.net_profit', visualization: 'trend', position: { x: 6, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Posted journals', metricKey: 'accounting.posted_journals', visualization: 'kpi', position: { x: 9, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Cash by currency', metricKey: 'treasury.available_cash', visualization: 'bar', position: { x: 0, y: 2, w: 6, h: 4 }, config: { groupBy: 'currency' } },
        { title: 'Outstanding receivables', metricKey: 'receivables.outstanding', visualization: 'bar', position: { x: 6, y: 2, w: 3, h: 4 }, config: { groupBy: 'currency' } },
        { title: 'Outstanding payables', metricKey: 'payables.outstanding', visualization: 'bar', position: { x: 9, y: 2, w: 3, h: 4 }, config: { groupBy: 'currency' } },
        { title: 'Approved treasury outflows', metricKey: 'treasury.approved_outflows', visualization: 'bar', position: { x: 0, y: 6, w: 6, h: 3 }, config: { groupBy: 'currency' } },
        { title: 'Overdue receivables', metricKey: 'receivables.overdue', visualization: 'exception', position: { x: 6, y: 6, w: 3, h: 3 }, config: { groupBy: 'currency' } },
        { title: 'Overdue payables', metricKey: 'payables.overdue', visualization: 'exception', position: { x: 9, y: 6, w: 3, h: 3 }, config: { groupBy: 'currency' } },
      ],
    },
  },
  {
    id: 'system:operations-compliance-control',
    scope: 'system',
    name: 'Operations & Compliance Control',
    description: 'A control dashboard for inventory, banking, tax, assets, commerce and operational exceptions.',
    definition: {
      defaultFilters: { preset: 'this_month' },
      widgets: [
        { title: 'Sales by currency', metricKey: 'commerce.sales', visualization: 'bar', position: { x: 0, y: 0, w: 6, h: 4 }, config: { groupBy: 'currency' } },
        { title: 'Inventory value', metricKey: 'inventory.inventory_value', visualization: 'kpi', position: { x: 6, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Asset carrying value', metricKey: 'assets.carrying_value', visualization: 'kpi', position: { x: 9, y: 0, w: 3, h: 2 }, config: {} },
        { title: 'Low stock items', metricKey: 'inventory.low_stock_items', visualization: 'exception', position: { x: 6, y: 2, w: 3, h: 2 }, config: {} },
        { title: 'Inventory exceptions', metricKey: 'inventory.integrity_exceptions', visualization: 'exception', position: { x: 9, y: 2, w: 3, h: 2 }, config: {} },
        { title: 'Unmatched bank lines', metricKey: 'banking.unmatched_lines', visualization: 'exception', position: { x: 0, y: 4, w: 3, h: 2 }, config: {} },
        { title: 'Open withholding exposure', metricKey: 'tax.withholding_open', visualization: 'kpi', position: { x: 3, y: 4, w: 3, h: 2 }, config: {} },
        { title: 'E-VAT queue pending', metricKey: 'tax.evat_pending', visualization: 'exception', position: { x: 6, y: 4, w: 3, h: 2 }, config: {} },
        { title: 'E-VAT failures', metricKey: 'tax.evat_failures', visualization: 'exception', position: { x: 9, y: 4, w: 3, h: 2 }, config: {} },
        { title: 'Accumulated depreciation', metricKey: 'assets.accumulated_depreciation', visualization: 'kpi', position: { x: 0, y: 6, w: 4, h: 2 }, config: {} },
        { title: 'Active bank accounts', metricKey: 'banking.active_accounts', visualization: 'kpi', position: { x: 4, y: 6, w: 4, h: 2 }, config: {} },
        { title: 'Pending approvals', metricKey: 'workflow.pending_approvals', visualization: 'exception', position: { x: 8, y: 6, w: 4, h: 2 }, config: {} },
      ],
    },
  },
];

function listSystemTemplates() { return templates.map((template) => ({ ...template })); }
function getSystemTemplate(id) { return templates.find((template) => template.id === id) || null; }

module.exports = { listSystemTemplates, getSystemTemplate };
