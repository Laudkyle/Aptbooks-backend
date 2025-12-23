/**
 * Partner Management API (Tier 2)
 * DB-backed interface. Tier 3 uses this; it must not import Tier 2 services.
 */
const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

async function getPartnerForOrg({ orgId, partnerId }) {
  const { rows } = await pool.query(
    `SELECT * FROM business_partners WHERE organization_id=$1 AND id=$2`,
    [orgId, partnerId]
  );
  if (!rows.length) throw new AppError(404, "Partner not found");
  return rows[0];
}

async function getActiveCustomerForOrg({ orgId, customerId }) {
  const p = await getPartnerForOrg({ orgId, partnerId: customerId });
  if (p.type !== "customer") throw new AppError(400, "Partner is not a customer");
  if (p.status !== "active") throw new AppError(400, "Customer is inactive");
  return p;
}

module.exports = {
  getPartnerForOrg,
  getActiveCustomerForOrg
};
