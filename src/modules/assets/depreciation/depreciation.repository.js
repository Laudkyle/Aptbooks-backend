const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

function db(client) { return client || pool; }
function componentKey(value) { return String(value || '').trim().toUpperCase() || '__MAIN__'; }

async function findOverlap({ orgId, assetId, componentCode, effectiveStartDate, effectiveEndDate, excludeScheduleId = null, client = null }) {
  const { rows } = await db(client).query(
    `SELECT id
       FROM asset_depreciation_schedules
      WHERE organization_id=$1 AND asset_id=$2 AND status='active'
        AND UPPER(COALESCE(NULLIF(TRIM(component_code),''),'__MAIN__'))=$3
        AND effective_start_date <= COALESCE($5::date,'9999-12-31'::date)
        AND COALESCE(effective_end_date,'9999-12-31'::date) >= $4::date
        AND ($6::uuid IS NULL OR id<>$6::uuid)
      LIMIT 1`,
    [orgId, assetId, componentKey(componentCode), effectiveStartDate, effectiveEndDate, excludeScheduleId]);
  return rows[0] || null;
}

async function createSchedule({ orgId, actorUserId, payload, client = null }) {
  const effectiveStartDate = payload.effectiveStartDate || payload.depreciationStartDate;
  if (!effectiveStartDate) throw new AppError(400, "Effective start date is required");
  const overlap = await findOverlap({ orgId, assetId: payload.assetId, componentCode: payload.componentCode,
    effectiveStartDate, effectiveEndDate: payload.effectiveEndDate || null, client });
  if (overlap) throw new AppError(409, "An active depreciation schedule already overlaps this component and date range");

  const { rows } = await db(client).query(
    `INSERT INTO asset_depreciation_schedules(
       organization_id, asset_id, method, useful_life_months, depreciation_start_date,
       effective_start_date, effective_end_date, component_code, basis_amount, residual_value,
       depreciation_convention, declining_rate_percent, created_by, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
     RETURNING *`,
    [orgId, payload.assetId, payload.method, payload.usefulLifeMonths,
      payload.depreciationStartDate || effectiveStartDate, effectiveStartDate, payload.effectiveEndDate || null,
      payload.componentCode || null, payload.basisAmount, payload.residualValue,
      payload.depreciationConvention, payload.decliningRatePercent ?? null, actorUserId || null]);
  return rows[0];
}

async function listSchedules({ orgId, query, client = null }) {
  const params = [orgId];
  const where = ["s.organization_id=$1"];
  let i = 2;
  if (query?.status) { where.push(`s.status=$${i++}`); params.push(query.status); }
  if (query?.activeOnly === "true") where.push("s.status='active'");
  if (query?.assetId) { where.push(`s.asset_id=$${i++}`); params.push(query.assetId); }
  if (query?.componentCode) { where.push(`UPPER(COALESCE(s.component_code,''))=UPPER($${i++})`); params.push(query.componentCode); }
  if (query?.effectiveOnDate) {
    where.push(`s.effective_start_date <= $${i++}::date`); params.push(query.effectiveOnDate);
    where.push(`(s.effective_end_date IS NULL OR s.effective_end_date >= $${i++}::date)`); params.push(query.effectiveOnDate);
  }
  const { rows } = await db(client).query(
    `SELECT s.*, a.code AS asset_code, a.name AS asset_name, a.status AS asset_status,
            a.cost, a.salvage_value, a.in_service_date, a.disposed_date, a.disposed_at,
            c.code AS category_code, c.name AS category_name
       FROM asset_depreciation_schedules s
       JOIN fixed_assets a ON a.id=s.asset_id AND a.organization_id=s.organization_id
       JOIN asset_categories c ON c.id=a.category_id AND c.organization_id=a.organization_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.code ASC, COALESCE(s.component_code,'') ASC, s.effective_start_date DESC, s.created_at DESC`, params);
  return rows;
}

async function getSchedule({ orgId, scheduleId, client = null, forUpdate = false }) {
  const { rows } = await db(client).query(
    `SELECT * FROM asset_depreciation_schedules WHERE organization_id=$1 AND id=$2${forUpdate ? ' FOR UPDATE' : ''}`,
    [orgId, scheduleId]);
  return rows[0] || null;
}

async function updateSchedule({ orgId, scheduleId, payload, client = null }) {
  const current = await getSchedule({ orgId, scheduleId, client, forUpdate: true });
  if (!current) return null;
  const next = {
    method: payload.method ?? current.method,
    usefulLifeMonths: payload.usefulLifeMonths ?? current.useful_life_months,
    effectiveStartDate: payload.effectiveStartDate ?? current.effective_start_date,
    effectiveEndDate: Object.prototype.hasOwnProperty.call(payload, 'effectiveEndDate') ? payload.effectiveEndDate : current.effective_end_date,
    componentCode: Object.prototype.hasOwnProperty.call(payload, 'componentCode') ? payload.componentCode : current.component_code,
    basisAmount: payload.basisAmount ?? current.basis_amount,
    residualValue: payload.residualValue ?? current.residual_value,
    depreciationConvention: payload.depreciationConvention ?? current.depreciation_convention,
    decliningRatePercent: Object.prototype.hasOwnProperty.call(payload, 'decliningRatePercent') ? payload.decliningRatePercent : current.declining_rate_percent,
    status: payload.status ?? current.status,
  };
  if (next.status === 'active') {
    const overlap = await findOverlap({ orgId, assetId: current.asset_id, componentCode: next.componentCode,
      effectiveStartDate: next.effectiveStartDate, effectiveEndDate: next.effectiveEndDate,
      excludeScheduleId: scheduleId, client });
    if (overlap) throw new AppError(409, "An active depreciation schedule already overlaps this component and date range");
  }
  const { rows } = await db(client).query(
    `UPDATE asset_depreciation_schedules
        SET method=$3, useful_life_months=$4, effective_start_date=$5, effective_end_date=$6,
            component_code=$7, basis_amount=$8, residual_value=$9, depreciation_convention=$10,
            declining_rate_percent=$11, status=$12, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, scheduleId, next.method, next.usefulLifeMonths, next.effectiveStartDate, next.effectiveEndDate,
      next.componentCode || null, next.basisAmount, next.residualValue, next.depreciationConvention,
      next.decliningRatePercent ?? null, next.status]);
  return rows[0] || null;
}

async function hasPostings({ orgId, scheduleId, client = null }) {
  const { rows } = await db(client).query(
    `SELECT 1 FROM asset_depreciation_transactions WHERE organization_id=$1 AND schedule_id=$2 LIMIT 1`,
    [orgId, scheduleId]);
  return rows.length > 0;
}

async function deleteSchedule({ orgId, scheduleId, client = null }) {
  const { rows } = await db(client).query(
    `DELETE FROM asset_depreciation_schedules WHERE organization_id=$1 AND id=$2 RETURNING id`, [orgId, scheduleId]);
  return rows[0] || null;
}

async function getRunByPeriod({ orgId, periodId, client = null, forUpdate = false }) {
  const { rows } = await db(client).query(
    `SELECT r.*, p.journal_entry_id
       FROM asset_depreciation_runs r
       LEFT JOIN asset_depreciation_run_postings p ON p.depreciation_run_id=r.id
      WHERE r.organization_id=$1 AND r.period_id=$2${forUpdate ? ' FOR UPDATE OF r' : ''}`,
    [orgId, periodId]);
  return rows[0] || null;
}

async function createOrRestartRun({ orgId, periodId, actorUserId, client = null }) {
  const { rows } = await db(client).query(
    `INSERT INTO asset_depreciation_runs(organization_id, period_id, status, actor_user_id, started_at, completed_at, error, control_total)
     VALUES ($1,$2,'running',$3,NOW(),NULL,NULL,0)
     ON CONFLICT (organization_id, period_id) DO UPDATE
       SET status='running', actor_user_id=EXCLUDED.actor_user_id, started_at=NOW(), completed_at=NULL,
           error=NULL, reversal_journal_entry_id=NULL, reversed_at=NULL, reversed_by=NULL
       WHERE asset_depreciation_runs.status IN ('failed','skipped','reversed')
     RETURNING *`, [orgId, periodId, actorUserId || null]);
  if (rows.length) return rows[0];
  return getRunByPeriod({ orgId, periodId, client, forUpdate: true });
}

async function markRun({ orgId, runId, status, error = null, controlTotal = null, client = null }) {
  const { rows } = await db(client).query(
    `UPDATE asset_depreciation_runs
        SET status=$3, error=$4,
            control_total=COALESCE($5,control_total),
            completed_at=CASE WHEN $3='running' THEN NULL ELSE NOW() END
      WHERE organization_id=$1 AND id=$2 RETURNING *`,
    [orgId, runId, status, error, controlTotal]);
  return rows[0] || null;
}

async function markRunReversed({ orgId, runId, reversalJournalId, actorUserId, client = null }) {
  const { rows } = await db(client).query(
    `UPDATE asset_depreciation_runs
        SET status='reversed', reversal_journal_entry_id=$3, reversed_at=NOW(), reversed_by=$4, completed_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status='posted' RETURNING *`,
    [orgId, runId, reversalJournalId, actorUserId || null]);
  return rows[0] || null;
}

async function linkRunPosting({ runId, journalId, client = null }) {
  const { rows } = await db(client).query(
    `INSERT INTO asset_depreciation_run_postings(depreciation_run_id, journal_entry_id)
     VALUES ($1,$2)
     ON CONFLICT (depreciation_run_id) DO UPDATE SET journal_entry_id=EXCLUDED.journal_entry_id, posted_at=NOW()
     RETURNING *`, [runId, journalId]);
  return rows[0];
}

async function insertDepreciationTransactions({ orgId, periodId, postings, entryType = 'depreciation', journalId = null, client = null }) {
  const inserted = [];
  for (const posting of postings || []) {
    const signedAmount = entryType === 'reversal' && !String(posting.amount).startsWith('-') ? `-${posting.amount}` : posting.amount;
    const { rows } = await db(client).query(
      `INSERT INTO asset_depreciation_transactions(
         organization_id, asset_id, schedule_id, period_id, amount, entry_type,
         journal_entry_id, method, basis_amount, residual_value, calculation_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id, schedule_id, period_id, entry_type) DO NOTHING
       RETURNING *`,
      [orgId, posting.assetId, posting.scheduleId, periodId, signedAmount, entryType, journalId,
        posting.method || null, posting.basisAmount || null, posting.residualValue || null,
        posting.calculation ? JSON.stringify(posting.calculation) : null]);
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}

async function listRuns({ orgId, limit = 24, client = null }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 24, 1), 120);
  const { rows } = await db(client).query(
    `SELECT r.id,r.period_id,r.status,r.started_at,r.completed_at,r.error,r.control_total,
            r.reversal_journal_entry_id,r.reversed_at,r.actor_user_id,
            p.code AS period_code,p.start_date,p.end_date,rp.journal_entry_id,
            COALESCE(x.posting_count,0)::int AS posting_count
       FROM asset_depreciation_runs r
       JOIN accounting_periods p ON p.id=r.period_id AND p.organization_id=r.organization_id
       LEFT JOIN asset_depreciation_run_postings rp ON rp.depreciation_run_id=r.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS posting_count FROM asset_depreciation_transactions t
          WHERE t.organization_id=r.organization_id AND t.period_id=r.period_id AND t.entry_type='depreciation'
       ) x ON TRUE
      WHERE r.organization_id=$1
      ORDER BY p.end_date DESC,r.started_at DESC LIMIT $2`, [orgId,safeLimit]);
  return rows;
}

module.exports = {
  findOverlap, createSchedule, listSchedules, getSchedule, updateSchedule, hasPostings, deleteSchedule,
  getRunByPeriod, listRuns, createOrRestartRun, markRun, markRunReversed, linkRunPosting, insertDepreciationTransactions,
};
