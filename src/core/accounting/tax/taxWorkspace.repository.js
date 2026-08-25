const pool = require('../../../db/pool');

async function getVatSnapshot({ orgId }) {
  const { rows } = await pool.query(
    `SELECT registration_no AS registration_number,
            effective_from,
            effective_to,
            is_primary
       FROM tax_registrations
      WHERE organization_id=$1
        AND registration_type='VAT'
        AND effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY is_primary DESC, effective_from DESC
      LIMIT 1`,
    [orgId],
  );
  const registration = rows[0] || null;
  return {
    registered: Boolean(registration),
    registrationNumber: registration?.registration_number || null,
    effectiveFrom: registration?.effective_from || null,
  };
}

async function getCorporateTaxSnapshot({ orgId }) {
  const { rows } = await pool.query(
    `SELECT s.enabled,
            s.taxpayer_id,
            c.id AS latest_computation_id,
            c.tax_year AS latest_tax_year,
            c.status AS latest_status,
            c.annual_return_due_date AS latest_due_date
       FROM ghana_cit_settings s
       LEFT JOIN LATERAL (
         SELECT id,tax_year,status,annual_return_due_date
           FROM ghana_cit_computations
          WHERE organization_id=s.organization_id
          ORDER BY tax_year DESC,version_no DESC
          LIMIT 1
       ) c ON TRUE
      WHERE s.organization_id=$1`,
    [orgId],
  );
  const row = rows[0] || null;
  return {
    enabled: row?.enabled === true,
    taxpayerIdConfigured: Boolean(row?.taxpayer_id),
    latestComputationId: row?.latest_computation_id || null,
    latestTaxYear: row?.latest_tax_year || null,
    latestStatus: row?.latest_status || null,
    latestDueDate: row?.latest_due_date || null,
  };
}

async function getFiscalizationSnapshot({ orgId }) {
  const { rows } = await pool.query(
    `SELECT s.enabled,
            s.adapter_mode,
            s.onboarding_status,
            COALESCE(q.pending,0)::int AS pending,
            COALESCE(q.dead_letter,0)::int AS dead_letter
       FROM fiscalization_settings s
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE status IN ('queued','retry','claimed')) AS pending,
                COUNT(*) FILTER (WHERE status='dead_letter') AS dead_letter
           FROM fiscal_transmission_queue
          WHERE organization_id=s.organization_id
       ) q ON TRUE
      WHERE s.organization_id=$1`,
    [orgId],
  );
  const row = rows[0] || null;
  return {
    enabled: row?.enabled === true,
    adapterMode: row?.adapter_mode || null,
    onboardingStatus: row?.onboarding_status || null,
    pending: Number(row?.pending || 0),
    deadLetters: Number(row?.dead_letter || 0),
  };
}

module.exports = {
  getVatSnapshot,
  getCorporateTaxSnapshot,
  getFiscalizationSnapshot,
};
