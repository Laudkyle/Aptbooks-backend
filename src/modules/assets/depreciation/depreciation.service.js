const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const journalIF = require("../../../interfaces/journalPosting.interface");
const { parseDecimalToBigInt } = require("../../../shared/utils/money");

function sum2(lines) {
  return lines.reduce(
    (acc, l) => {
      acc.debit += parseDecimalToBigInt(l.debit || 0, 2);
      acc.credit += parseDecimalToBigInt(l.credit || 0, 2);
      return acc;
    },
    { debit: 0n, credit: 0n }
  );
}
async function createSchedule({ orgId, actorUserId, payload }) {
  const { rows: aRows } = await pool.query(
    `SELECT id, status, acquisition_date FROM fixed_assets WHERE organization_id=$1 AND id=$2`,
    [orgId, payload.assetId]
  );
  if (!aRows.length) throw new AppError(400, "Invalid assetId");
  if (aRows[0].status !== "active") throw new AppError(409, "Asset is not active");

  // Option A: you MUST provide effectiveStartDate; effectiveEndDate optional
  const effStart = payload.effectiveStartDate || payload.depreciationStartDate;
  const effEnd = payload.effectiveEndDate || null;
  if (!effStart) throw new AppError(400, "effectiveStartDate required");

  // No overlap with existing active schedules for same asset
  // Overlap rule: existing.start <= newEnd AND (existing.end IS NULL OR existing.end >= newStart)
  const { rows: overlap } = await pool.query(
    `
    SELECT id
    FROM asset_depreciation_schedules
    WHERE organization_id=$1
      AND asset_id=$2
      AND status='active'
      AND effective_start_date <= COALESCE($4::date, '9999-12-31'::date)
      AND COALESCE(effective_end_date, '9999-12-31'::date) >= $3::date
    LIMIT 1
    `,
    [orgId, payload.assetId, effStart, effEnd]
  );
  if (overlap.length) throw new AppError(409, "Overlapping active depreciation schedule exists for asset");

  return require("./depreciation.repository").createSchedule({
    orgId,
    payload: {
      ...payload,
      effectiveStartDate: effStart,
      effectiveEndDate: effEnd
    }
  });
}


async function listSchedules({ orgId, query }) {
  return require("./depreciation.repository").listSchedules({ orgId, query });
}
async function runPeriodEndDepreciation({ orgId, actorUserId, periodId }) {
  // 1) Read period
  const { rows: pRows } = await pool.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!pRows.length) throw new AppError(400, "Invalid periodId");
  const period = pRows[0];
  if (period.status !== "open") throw new AppError(409, "Period is not open");

  // 2) Create run row once + lock (idempotent)
  const runClient = await pool.connect();
  let runId;

  try {
    await runClient.query("BEGIN");

    await runClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `depr:${orgId}:${periodId}`
    ]);

    const { rows: inserted } = await runClient.query(
      `
      INSERT INTO asset_depreciation_runs(organization_id, period_id, status, actor_user_id, started_at)
      VALUES ($1,$2,'running',$3,NOW())
      ON CONFLICT (organization_id, period_id) DO NOTHING
      RETURNING id, status
      `,
      [orgId, periodId, actorUserId]
    );

    if (inserted.length === 0) {
      const { rows } = await runClient.query(
        `SELECT id, status FROM asset_depreciation_runs WHERE organization_id=$1 AND period_id=$2`,
        [orgId, periodId]
      );
      await runClient.query("COMMIT");
      return { status: "skipped", reason: "already_ran_for_period", run: rows[0] };
    }

    runId = inserted[0].id;
    await runClient.query("COMMIT");
  } catch (e) {
    try { await runClient.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    runClient.release();
  }

  // 3) Load eligible schedules (Option A: effective window)
  // Requirements:
  // - schedule active
  // - asset active and not disposed/retired
  // - schedule window intersects the target period window
  const { rows: schedRows } = await pool.query(
    `
    SELECT
      a.id AS asset_id,
      a.name AS asset_name,
      a.code AS asset_code,
      a.status AS asset_status,
      a.cost,
      a.salvage_value,
      a.disposed_date,
      a.disposed_at,
      a.retired_at,
      s.id AS schedule_id,
      s.useful_life_months,
      s.depreciation_start_date,
      s.effective_start_date,
      s.effective_end_date,
      s.component_code,
      c.depr_expense_account_id,
      c.accum_depr_account_id
    FROM asset_depreciation_schedules s
    JOIN fixed_assets a ON a.id = s.asset_id
    JOIN asset_categories c ON c.id = a.category_id
    WHERE s.organization_id=$1
      AND s.status='active'
      AND a.status='active'
      AND (a.disposed_date IS NULL AND a.disposed_at IS NULL) -- disposal gating
      AND (s.effective_start_date <= $3::date)
      AND (s.effective_end_date IS NULL OR s.effective_end_date >= $2::date)
    ORDER BY a.code ASC, COALESCE(s.component_code,'') ASC, s.effective_start_date ASC
    `,
    [orgId, period.start_date, period.end_date]
  );

  const postings = [];

  for (const r of schedRows) {
    const cost = Number(r.cost);
    const salvage = Number(r.salvage_value || 0);
    const base = Number((cost - salvage).toFixed(2));
    if (base <= 0) continue;

    const lifeMonths = Number(r.useful_life_months || 0);
    if (!(lifeMonths > 0)) continue;

    // Accumulated depreciation MUST be schedule-scoped under multi-schedule
    const { rows: depSum } = await pool.query(
      `
      SELECT COALESCE(SUM(amount),0)::numeric AS amt
      FROM asset_depreciation_transactions
      WHERE organization_id=$1 AND schedule_id=$2
      `,
      [orgId, r.schedule_id]
    );

    const accumulated = Number(depSum[0].amt || 0);
    const remaining = Number((base - accumulated).toFixed(2));

    // Stop rule: never post beyond base
    if (remaining <= 0) continue;

    const scheduled = Number((base / lifeMonths).toFixed(2));
    const amount = Number(Math.min(scheduled, remaining).toFixed(2));
    if (amount <= 0) continue;

    // COA guards (strongly recommended)
    if (!r.depr_expense_account_id) throw new AppError(409, `Category missing depr_expense_account_id for asset ${r.asset_code}`);
    if (!r.accum_depr_account_id) throw new AppError(409, `Category missing accum_depr_account_id for asset ${r.asset_code}`);

    const component = r.component_code ? ` (${r.component_code})` : "";
    postings.push({
      assetId: r.asset_id,
      scheduleId: r.schedule_id,
      amount,
      expenseAccountId: r.depr_expense_account_id,
      accumAccountId: r.accum_depr_account_id,
      memo: `Depreciation: ${r.asset_name}${component}`
    });
  }

  if (!postings.length) {
    await pool.query(
      `UPDATE asset_depreciation_runs
       SET status='skipped', completed_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, runId]
    );
    return { status: "skipped", runId, reason: "no_eligible_assets" };
  }

  // 4) Consolidated journal lines
  const journalLines = [];
  for (const p of postings) {
    journalLines.push({ accountId: p.expenseAccountId, debit: p.amount, credit: 0, description: p.memo });
    journalLines.push({ accountId: p.accumAccountId, debit: 0, credit: p.amount, description: p.memo });
  }

  const totals = sum2(journalLines);
  if (totals.debit !== totals.credit) {
    await pool.query(
      `UPDATE asset_depreciation_runs
       SET status='failed', error=$3, completed_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, runId, "Depreciation journal not balanced"]
    );
    throw new AppError(500, "Depreciation journal not balanced");
  }

  const idempotencyKey = `depr:${orgId}:${periodId}`;

  // 5) Post journal (kernel)
  let posted;
  try {
    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      payload: {
        periodId,
        entryDate: period.end_date,
        typeCode: "ADJUSTMENT",
        memo: `Period depreciation (${periodId})`,
        idempotencyKey,
        lines: journalLines
      }
    });

    posted = await journalIF.postDraftJournal({
      orgId,
      journalId: draft.journalId,
      actorUserId
    });
  } catch (e) {
    await pool.query(
      `UPDATE asset_depreciation_runs
       SET status='failed', error=$3, completed_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, runId, String(e.message || e)]
    );
    throw e;
  }

  // 6) Persist depreciation transactions + posting link
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO asset_depreciation_run_postings(depreciation_run_id, journal_entry_id)
      VALUES ($1,$2)
      ON CONFLICT (depreciation_run_id) DO NOTHING
      `,
      [runId, posted.journalId]
    );

    for (const p of postings) {
      await client.query(
        `
        INSERT INTO asset_depreciation_transactions(
          organization_id, asset_id, schedule_id, period_id, amount
        )
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id, schedule_id, period_id) DO NOTHING
        `,
        [orgId, p.assetId, p.scheduleId, periodId, p.amount]
      );
    }

    await client.query(
      `UPDATE asset_depreciation_runs
       SET status='posted', completed_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, runId]
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    await pool.query(
      `UPDATE asset_depreciation_runs
       SET status='failed', error=$3, completed_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, runId, `posted_but_persist_failed: ${String(e.message || e)}`]
    );
    throw e;
  } finally {
    client.release();
  }

  return { status: "posted", runId, journalId: posted.journalId, count: postings.length };
}


module.exports = {
  createSchedule,
  listSchedules,
  runPeriodEndDepreciation
};
