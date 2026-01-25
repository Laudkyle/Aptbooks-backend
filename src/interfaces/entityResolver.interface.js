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
 * IMPORTANT: Tier 10 should treat entity_type as data;  do not enforce hard-coded enums there.
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

  bill: async ({ orgId, entityId }) => {
    const { rows } = await pool.query(
      `SELECT id, bill_no AS entity_ref FROM bills WHERE organization_id=$1 AND id=$2`,
      [orgId, entityId]
    ); 
    if (!rows.length) return { exists: false, entity_ref: null, entity_label: null }; 
    return { exists: true, entity_ref: rows[0].entity_ref, entity_label: "Bill" }; 
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
