/**
 * Entity Resolver API (Cross-tier)
 *
 * Goal:
 * - Tier 10 (Documents/Workflow) must not directly query Tier >= 2 module tables.
 * - Instead, Tier 10 calls this interface to validate and describe entity links.
 *
 * This pattern matches the rest of src/interfaces/*: a stable facade that hides
 * data access details from higher tiers.
 */

const { pool } = require("../db/pool");
const { env } = require("../config/env");

/**
 * @typedef {Object} EntityResolution
 * @property {boolean} exists
 * @property {string|null} entity_ref
 * @property {string|null} entity_label
 */

/**
 * Canonical entity types supported out-of-the-box.
 *
 * Add new types here as modules are introduced.
 * IMPORTANT: Tier 10 should treat entity_type as data; do not enforce hard-coded enums there.
 */
const RESOLVERS = {
  invoice: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, invoice_no AS entity_ref FROM invoices WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Invoice" };
  },


  tax_invoice: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, invoice_no AS entity_ref FROM invoices WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Tax Invoice" };
  },

  bill: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, bill_no AS entity_ref FROM bills WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Bill" };
  },

  journal_entry: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(entry_no::text, id::text) AS entity_ref FROM journal_entries WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Journal Entry" };
  },

  credit_note: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, credit_note_no AS entity_ref FROM credit_notes WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Credit Note" };
  },


  tax_credit: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, credit_note_no AS entity_ref FROM credit_notes WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Tax Credit" };
  },

  debit_note: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, debit_note_no AS entity_ref FROM debit_notes WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Debit Note" };
  },

  payment_out: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, payment_no AS entity_ref FROM vendor_payments WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Payment Out" };
  },

  payment_in: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, receipt_no AS entity_ref FROM customer_receipts WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Payment In" };
  },

  receipt: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, receipt_no AS entity_ref FROM customer_receipts WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Receipt" };
  },

  stock_count: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(reference, id::text) AS entity_ref FROM inventory_stock_counts WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Stock Count" };
  },

  stock_adjustment: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(reference, id::text) AS entity_ref FROM inventory_transactions WHERE organization_id=$1 AND id=$2 AND txn_type='adjustment'`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Stock Adjustment" };
  },

  stock_transfer: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(reference, id::text) AS entity_ref FROM inventory_transactions WHERE organization_id=$1 AND id=$2 AND txn_type='transfer'`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Stock Transfer" };
  },

  stock_issue: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(reference, id::text) AS entity_ref FROM inventory_transactions WHERE organization_id=$1 AND id=$2 AND txn_type='issue'`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Stock Issue" };
  },

  stock_receive: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(reference, id::text) AS entity_ref FROM inventory_transactions WHERE organization_id=$1 AND id=$2 AND txn_type='receipt'`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Stock Receive" };
  },

  fixed_asset: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, code AS entity_ref FROM fixed_assets WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Fixed Asset" };
  },

  lease: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, code AS entity_ref FROM leases WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Lease" };
  },
  leave_request: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT lr.id, COALESCE(e.employee_no, lr.id::text) AS entity_ref
         FROM hr_leave_requests lr
         LEFT JOIN hr_employees e ON e.id = lr.employee_id
        WHERE lr.organization_id=$1 AND lr.id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Leave Request" };
  },

  payslip: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, id::text AS entity_ref FROM hr_payroll_runs WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Payslip" };
  },

  budget: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT bv.id, CONCAT(COALESCE(b.name,'Budget'), ' v', bv.version_no) AS entity_ref
         FROM budget_versions bv
         JOIN budgets b ON b.id = bv.budget_id
        WHERE bv.organization_id=$1 AND bv.id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Budget" };
  },

  forecast: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT fv.id, CONCAT(COALESCE(f.name,'Forecast'), ' v', fv.version_no) AS entity_ref
         FROM forecast_versions fv
         JOIN forecasts f ON f.id = fv.forecast_id
        WHERE fv.organization_id=$1 AND fv.id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Forecast" };
  },

  project: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(code, name, id::text) AS entity_ref FROM projects WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Project" };
  },

  contract: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(code, id::text) AS entity_ref FROM ifrs15_contracts WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Contract" };
  },


  tax_return: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT tr.id,
              CONCAT(tr.tax_type, ' ', to_char(tr.from_date, 'YYYY-MM-DD'), ' to ', to_char(tr.to_date, 'YYYY-MM-DD')) AS entity_ref
         FROM tax_returns tr
        WHERE tr.organization_id=$1 AND tr.id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Tax Return" };
  },

  employee: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, employee_no AS entity_ref FROM hr_employees WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    );
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Employee" };
  }
};

/**
 * Register an entity resolver. This allows modules to extend supported entity types
 * without changing Tier 10.
 *
 * @param {string} entityType
 * @param {(args: {orgId: string, entityId: string}) => Promise<EntityResolution>} fn
 */
function registerResolver(entityType, fn) {
  RESOLVERS[entityType] = fn;
}

/**
 * Resolve (validate + describe) an entity reference.
 *
 * Behavior:
 * - If entity_type is known: validate existence via its resolver.
 * - If entity_type is unknown:
 *   - strict=false: return {exists:true, entity_ref:null} (allowed)
 *   - strict=true: return {exists:false, ...}
 *
 * @param {Object} args
 * @param {string} args.orgId
 * @param {string} args.entityType
 * @param {string} args.entityId
 * @param {boolean=} args.strict
 * @returns {Promise<EntityResolution>}
 */
async function resolveEntity({ orgId, entityType, entityId, strict }) {
  const isStrict = typeof strict === "boolean" ? strict : env.ENTITY_RESOLVER_STRICT;

  if (!entityType || !entityId) {
    return { exists: false, entity_ref: null, entity_label: null };
  }

  const resolver = RESOLVERS[String(entityType).toLowerCase()];
  if (!resolver) {
    if (isStrict) return { exists: false, entity_ref: null, entity_label: null };
    return { exists: true, entity_ref: null, entity_label: null };
  }

  return resolver({ orgId, entityId });
}

function listSupportedEntityTypes() {
  return Object.keys(RESOLVERS).sort();
}

module.exports = {
  registerResolver,
  resolveEntity,
  listSupportedEntityTypes
};
