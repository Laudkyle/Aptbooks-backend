const { pool } = require('../../../db/pool');
function db(client) { return client || pool; }

async function listProfiles(orgId) {
  const { rows } = await pool.query(`SELECT * FROM automation_document_match_profiles WHERE organization_id=$1 ORDER BY created_at DESC`, [orgId]);
  return rows;
}
async function getProfile(orgId, id, client = null) {
  const { rows } = await db(client).query(`SELECT * FROM automation_document_match_profiles WHERE organization_id=$1 AND id=$2 LIMIT 1`, [orgId, id]);
  return rows[0] || null;
}
async function createProfile(orgId, userId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_document_match_profiles(
      organization_id, name, source_type, target_type, date_window_days, amount_tolerance,
      min_confidence_score, is_enabled, created_by_user_id, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
    [orgId, payload.name, payload.sourceType, payload.targetType, payload.dateWindowDays ?? 7, payload.amountTolerance ?? 0, payload.minConfidenceScore ?? 0.7, payload.isEnabled !== false, userId || null, JSON.stringify(payload.metadata || null)]
  );
  return rows[0];
}
async function updateProfile(orgId, id, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE automation_document_match_profiles
     SET name=COALESCE($3,name), source_type=COALESCE($4,source_type), target_type=COALESCE($5,target_type),
         date_window_days=COALESCE($6,date_window_days), amount_tolerance=COALESCE($7,amount_tolerance),
         min_confidence_score=COALESCE($8,min_confidence_score), is_enabled=COALESCE($9,is_enabled),
         metadata=COALESCE($10::jsonb, metadata), updated_at=NOW()
     WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, id, payload.name ?? null, payload.sourceType ?? null, payload.targetType ?? null, payload.dateWindowDays ?? null, payload.amountTolerance ?? null, payload.minConfidenceScore ?? null, typeof payload.isEnabled === 'boolean' ? payload.isEnabled : null, payload.metadata === undefined ? null : JSON.stringify(payload.metadata)]
  );
  return rows[0] || null;
}
async function createRun(orgId, profileId, runDate, client = null) {
  const { rows } = await db(client).query(`INSERT INTO automation_document_match_runs(organization_id, profile_id, run_date, status) VALUES ($1,$2,$3,'running') RETURNING *`, [orgId, profileId, runDate]);
  return rows[0];
}
async function finishRun(orgId, runId, status, summaryJson, client = null) {
  const { rows } = await db(client).query(`UPDATE automation_document_match_runs SET status=$3, summary_json=$4::jsonb, completed_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, runId, status, JSON.stringify(summaryJson || null)]);
  return rows[0];
}
async function addResult(orgId, runId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_document_match_results(
      organization_id, run_id, source_entity_type, source_entity_id, target_entity_type, target_entity_id, confidence_score, reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [orgId, runId, payload.sourceEntityType, payload.sourceEntityId, payload.targetEntityType, payload.targetEntityId, payload.confidenceScore, payload.reason || null]
  );
  return rows[0];
}
async function listRuns(orgId, profileId) {
  const { rows } = await pool.query(`SELECT * FROM automation_document_match_runs WHERE organization_id=$1 AND profile_id=$2 ORDER BY created_at DESC`, [orgId, profileId]);
  return rows;
}
async function listResults(orgId, runId) {
  const { rows } = await pool.query(`SELECT * FROM automation_document_match_results WHERE organization_id=$1 AND run_id=$2 ORDER BY confidence_score DESC, created_at ASC`, [orgId, runId]);
  return rows;
}

async function getCandidates(orgId, profile, client = null) {
  const conn = db(client);
  if (profile.source_type === 'invoice' && profile.target_type === 'customer_receipt') {
    const { rows } = await conn.query(
      `SELECT i.id AS source_id, i.invoice_no AS source_code, i.customer_id, i.invoice_date AS source_date, i.total_amount AS source_amount,
              r.id AS target_id, r.receipt_no AS target_code, r.customer_id AS target_customer_id, r.receipt_date AS target_date, r.amount_total AS target_amount
       FROM invoices i
       JOIN customer_receipts r ON r.organization_id = i.organization_id AND r.customer_id = i.customer_id
       WHERE i.organization_id=$1
         AND ABS(COALESCE(r.amount_total,0) - COALESCE(i.total_amount,0)) <= $2::numeric
         AND r.receipt_date BETWEEN (i.invoice_date - ($3::int)) AND (i.invoice_date + ($3::int))`,
      [orgId, profile.amount_tolerance || 0, profile.date_window_days || 7]
    );
    return rows.map((r) => ({ ...r, source_type: 'invoice', target_type: 'customer_receipt' }));
  }
  if (profile.source_type === 'bill' && profile.target_type === 'vendor_payment') {
    const { rows } = await conn.query(
      `SELECT b.id AS source_id, b.bill_no AS source_code, b.vendor_id, b.bill_date AS source_date, b.total_amount AS source_amount,
              vp.id AS target_id, vp.payment_no AS target_code, vp.vendor_id AS target_vendor_id, vp.payment_date AS target_date, vp.amount_total AS target_amount
       FROM bills b
       JOIN vendor_payments vp ON vp.organization_id = b.organization_id AND vp.vendor_id = b.vendor_id
       WHERE b.organization_id=$1
         AND ABS(COALESCE(vp.amount_total,0) - COALESCE(b.total_amount,0)) <= $2::numeric
         AND vp.payment_date BETWEEN (b.bill_date - ($3::int)) AND (b.bill_date + ($3::int))`,
      [orgId, profile.amount_tolerance || 0, profile.date_window_days || 7]
    );
    return rows.map((r) => ({ ...r, source_type: 'bill', target_type: 'vendor_payment' }));
  }
  return [];
}
module.exports = { listProfiles, getProfile, createProfile, updateProfile, createRun, finishRun, addResult, listRuns, listResults, getCandidates };
