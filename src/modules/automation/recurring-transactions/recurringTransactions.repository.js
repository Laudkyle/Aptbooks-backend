const { pool } = require('../../../db/pool');
function db(client) { return client || pool; }

async function list(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM automation_recurring_transactions WHERE organization_id=$1 ORDER BY created_at DESC, code ASC`,
    [orgId]
  );
  return rows;
}

async function getById(orgId, id, client = null) {
  const { rows } = await db(client).query(
    `SELECT * FROM automation_recurring_transactions WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, id]
  );
  return rows[0] || null;
}

async function create(orgId, actorUserId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_recurring_transactions(
      organization_id, code, name, description, source_type, source_journal_id,
      journal_payload, schedule_type, interval_days, weekday, day_of_month,
      start_date, end_date, next_run_date, auto_post, is_enabled,
      created_by_user_id, updated_by_user_id, metadata
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18::jsonb
    ) RETURNING *`,
    [
      orgId,
      payload.code,
      payload.name,
      payload.description || null,
      payload.sourceType || 'journal_payload',
      payload.sourceJournalId || null,
      JSON.stringify(payload.journalPayload || null),
      payload.scheduleType,
      payload.intervalDays || null,
      payload.weekday ?? null,
      payload.dayOfMonth ?? null,
      payload.startDate,
      payload.endDate || null,
      payload.nextRunDate,
      payload.autoPost !== false,
      payload.isEnabled !== false,
      actorUserId || null,
      JSON.stringify(payload.metadata || null)
    ]
  );
  return rows[0];
}

async function update(orgId, id, actorUserId, payload, client = null) {
  const { rows } = await db(client).query(
    `UPDATE automation_recurring_transactions
     SET name=COALESCE($3,name),
         description=COALESCE($4,description),
         source_journal_id=COALESCE($5,source_journal_id),
         journal_payload=COALESCE($6::jsonb,journal_payload),
         schedule_type=COALESCE($7,schedule_type),
         interval_days=COALESCE($8,interval_days),
         weekday=COALESCE($9,weekday),
         day_of_month=COALESCE($10,day_of_month),
         start_date=COALESCE($11,start_date),
         end_date=COALESCE($12,end_date),
         next_run_date=COALESCE($13,next_run_date),
         auto_post=COALESCE($14,auto_post),
         is_enabled=COALESCE($15,is_enabled),
         metadata=COALESCE($16::jsonb,metadata),
         updated_by_user_id=$17,
         updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [
      orgId, id,
      payload.name ?? null,
      payload.description ?? null,
      payload.sourceJournalId ?? null,
      payload.journalPayload === undefined ? null : JSON.stringify(payload.journalPayload),
      payload.scheduleType ?? null,
      payload.intervalDays ?? null,
      payload.weekday ?? null,
      payload.dayOfMonth ?? null,
      payload.startDate ?? null,
      payload.endDate ?? null,
      payload.nextRunDate ?? null,
      typeof payload.autoPost === 'boolean' ? payload.autoPost : null,
      typeof payload.isEnabled === 'boolean' ? payload.isEnabled : null,
      payload.metadata === undefined ? null : JSON.stringify(payload.metadata),
      actorUserId || null
    ]
  );
  return rows[0] || null;
}

async function recordRun(orgId, recurringId, payload, client = null) {
  const { rows } = await db(client).query(
    `INSERT INTO automation_recurring_transaction_runs(
      organization_id, recurring_transaction_id, run_date, status,
      journal_entry_id, message, payload_snapshot, result_snapshot
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
    RETURNING *`,
    [
      orgId,
      recurringId,
      payload.runDate,
      payload.status,
      payload.journalEntryId || null,
      payload.message || null,
      JSON.stringify(payload.payloadSnapshot || null),
      JSON.stringify(payload.resultSnapshot || null)
    ]
  );
  return rows[0];
}

async function listRuns(orgId, recurringId) {
  const { rows } = await pool.query(
    `SELECT * FROM automation_recurring_transaction_runs WHERE organization_id=$1 AND recurring_transaction_id=$2 ORDER BY created_at DESC`,
    [orgId, recurringId]
  );
  return rows;
}

async function markExecuted(orgId, recurringId, nextRunDate, client = null) {
  const { rows } = await db(client).query(
    `UPDATE automation_recurring_transactions
     SET last_run_at=NOW(), next_run_date=$3, updated_at=NOW()
     WHERE organization_id=$1 AND id=$2
     RETURNING *`,
    [orgId, recurringId, nextRunDate]
  );
  return rows[0];
}

async function listDue(orgId = null, asOfDate, client = null) {
  const params = [asOfDate];
  let where = `is_enabled=TRUE AND next_run_date IS NOT NULL AND next_run_date <= $1::date`;
  if (orgId) {
    params.unshift(orgId);
    where = `organization_id=$1 AND ${where.replace('$1', '$2')}`;
  }
  const { rows } = await db(client).query(
    `SELECT * FROM automation_recurring_transactions WHERE ${where} ORDER BY next_run_date ASC, created_at ASC`,
    params
  );
  return rows;
}

module.exports = { list, getById, create, update, recordRun, listRuns, markExecuted, listDue };
