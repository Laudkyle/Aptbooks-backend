const { pool } = require("../../../db/pool"); 
const { AppError } = require("../../../shared/errors/AppError"); 

async function upsertVendorTaxProfile({ orgId, vendorId, payload }) {
  const { rows } = await pool.query(
    `
    INSERT INTO vendor_tax_profiles(
      organization_id, vendor_id, tin, legal_name, address_line1, address_line2, city, state_province, postal_code, country_code, classification, is_reportable, metadata
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (organization_id, vendor_id)
    DO UPDATE SET
      tin=EXCLUDED.tin,
      legal_name=EXCLUDED.legal_name,
      address_line1=EXCLUDED.address_line1,
      address_line2=EXCLUDED.address_line2,
      city=EXCLUDED.city,
      state_province=EXCLUDED.state_province,
      postal_code=EXCLUDED.postal_code,
      country_code=EXCLUDED.country_code,
      classification=EXCLUDED.classification,
      is_reportable=EXCLUDED.is_reportable,
      metadata=EXCLUDED.metadata,
      updated_at=now()
    RETURNING *
    `,
    [
      orgId,
      vendorId,
      payload.tin || null,
      payload.legalName || null,
      payload.addressLine1 || null,
      payload.addressLine2 || null,
      payload.city || null,
      payload.stateProvince || null,
      payload.postalCode || null,
      payload.countryCode || null,
      payload.classification || null,
      !!payload.isReportable,
      payload.metadata || {}
    ]
  ); 
  return rows[0]; 
}

async function getVendorTaxProfile({ orgId, vendorId }) {
  const { rows } = await pool.query(
    `SELECT * FROM vendor_tax_profiles WHERE organization_id=$1 AND vendor_id=$2`,
    [orgId, vendorId]
  ); 
  return rows[0] || null; 
}

async function createRun({ orgId, actorUserId, taxYear, formType }) {
  const { rows } = await pool.query(
    `
    INSERT INTO tax_form_runs(organization_id, tax_year, form_type, created_by)
    VALUES($1,$2,$3,$4)
    ON CONFLICT (organization_id, tax_year, form_type)
    DO UPDATE SET organization_id=EXCLUDED.organization_id
    RETURNING *
    `,
    [orgId, taxYear, formType || "1099", actorUserId || null]
  ); 
  return rows[0]; 
}

async function generateRun({ orgId, runId }) {
  const { rows: runRows } = await pool.query(
    `SELECT * FROM tax_form_runs WHERE organization_id=$1 AND id=$2`,
    [orgId, runId]
  ); 
  const run = runRows[0]; 
  if (!run) throw new AppError(404, "Tax form run not found"); 
  if (run.status === "finalized") throw new AppError(409, "Run is finalized"); 

  // Determine date range for tax year
  const from = `${run.tax_year}-01-01`; 
  const to = `${run.tax_year}-12-31`; 

  // Pull reportable vendors
  const { rows: vendors } = await pool.query(
    `
    SELECT p.vendor_id, p.tin, p.legal_name, p.is_reportable
    FROM vendor_tax_profiles p
    WHERE p.organization_id=$1 AND p.is_reportable=true
    `,
    [orgId]
  ); 

  await pool.query(`DELETE FROM tax_forms WHERE organization_id=$1 AND run_id=$2`, [orgId, runId]); 

  for (const v of vendors) {
    const { rows: totals } = await pool.query(
      `
      SELECT COALESCE(SUM(vp.amount_total),0)::numeric(18,2) AS paid_total
      FROM vendor_payments vp
      WHERE vp.organization_id=$1
        AND vp.vendor_id=$2
        AND vp.status='posted'
        AND vp.payment_date BETWEEN $3 AND $4
      `,
      [orgId, v.vendor_id, from, to]
    ); 
    const paidTotal = totals[0]?.paid_total || "0.00"; 
    await pool.query(
      `
      INSERT INTO tax_forms(run_id, organization_id, vendor_id, totals, status)
      VALUES($1,$2,$3,$4,'generated')
      `,
      [runId, orgId, v.vendor_id, { paid_total: paidTotal }]
    ); 
  }

  const { rows: updated } = await pool.query(
    `UPDATE tax_form_runs SET status='generated', generated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, runId]
  ); 
  return updated[0]; 
}

async function listRunForms({ orgId, runId }) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_forms WHERE organization_id=$1 AND run_id=$2 ORDER BY vendor_id ASC`,
    [orgId, runId]
  ); 
  return rows; 
}

async function exportRunCsv({ orgId, runId }) {
  const forms = await listRunForms({ orgId, runId }); 
  const { rows: profiles } = await pool.query(
    `SELECT vendor_id, tin, legal_name FROM vendor_tax_profiles WHERE organization_id=$1`,
    [orgId]
  ); 
  const profMap = new Map(profiles.map((p) => [String(p.vendor_id), p])); 

  const header = ["vendor_id","legal_name","tin","paid_total"].join(","); 
  const lines = forms.map((f) => {
    const p = profMap.get(String(f.vendor_id)) || {}; 
    const paid = f.totals?.paid_total ?? "0.00"; 
    return [f.vendor_id, JSON.stringify(p.legal_name || ""), JSON.stringify(p.tin || ""), paid].join(","); 
  }); 
  return [header, ...lines].join("\n"); 
}

module.exports = {
  upsertVendorTaxProfile,
  getVendorTaxProfile,
  createRun,
  generateRun,
  listRunForms,
  exportRunCsv
}; 
