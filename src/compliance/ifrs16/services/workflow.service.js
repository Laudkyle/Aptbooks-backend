const { findOpenPeriodForDate } = require('../../../interfaces/periodManagement.interface');
const {
  pool, AppError, workflow,
  toDecimal, toCurrencyNumber, toISODate, buildIfrs16IdempotencyKey,
  recordLeaseEvent, recordLeasePostingLedger, getLeaseBase, getLeaseSnapshot,
} = require('./common');
const { buildMeasurement, generateScheduleLines, persistMeasurementSnapshot, journalLine } = require('./measurement');
const { loadLeaseMeasurementContext, generateScheduleWithClient } = require('./measurement.service');

async function createLeaseModification({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); if (!['draft','active'].includes(lease.status)) throw new AppError(409, `Lease modification is not allowed when lease status is '${lease.status}'`);
    const { rows } = await client.query(`INSERT INTO lease_modifications(lease_id,organization_id,effective_date,reason,status,new_term_months,new_payment_amount,new_payments_per_year,new_annual_discount_rate,new_payment_timing,created_by)
      VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10) RETURNING *`, [leaseId,orgId,toISODate(payload.effective_date),payload.reason || null,payload.new_term_months || null,payload.new_payment_amount || null,payload.new_payments_per_year || null,payload.new_annual_discount_rate ?? null,payload.new_payment_timing || null,actorUserId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_CREATED', payload: rows[0] }); await client.query('COMMIT'); return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function listLeaseModifications({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 ORDER BY effective_date DESC, created_at DESC`, [orgId, leaseId]); return { items: rows }; }
async function getLeaseModification({ orgId, leaseId, modificationId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 AND id=$3 LIMIT 1`, [orgId, leaseId, modificationId]); if (!rows.length) throw new AppError(404,'Lease modification not found'); return rows[0]; }

async function submitLeaseWorkflow({ orgId, actorUserId, leaseId }) {
  const client = await pool.connect(); try { await client.query('BEGIN'); const snapshot = await getLeaseSnapshot({ orgId, leaseId, client }); const lease = snapshot.lease; const result = await workflow.submitLeaseForApproval({ orgId, actorUserId, lease, snapshot, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_SUBMITTED', payload:{} }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function approveLease({ orgId, actorUserId, leaseId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); const result = await workflow.approveLeaseWorkflow({ orgId, actorUserId, lease, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_APPROVED', payload:{ final_approval: result.final_approval } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function rejectLease({ orgId, actorUserId, leaseId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); const result = await workflow.rejectLeaseWorkflow({ orgId, actorUserId, lease, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'LEASE_REJECTED', payload:{ comment: comment || null } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function submitLeaseModification({ orgId, actorUserId, leaseId, modificationId }) { const client = await pool.connect(); try { await client.query('BEGIN'); const lease = await getLeaseBase({ orgId, leaseId, client }); const modification = await getLeaseModification({ orgId, leaseId, modificationId }); const result = await workflow.submitLeaseModificationForApproval({ orgId, actorUserId, modification, snapshot:{ lease, modification }, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_SUBMITTED', payload:{ modification_id: modificationId } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function approveLeaseModification({ orgId, actorUserId, leaseId, modificationId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const modification = await getLeaseModification({ orgId, leaseId, modificationId }); const result = await workflow.approveLeaseModificationWorkflow({ orgId, actorUserId, modification, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_APPROVED', payload:{ modification_id: modificationId, final_approval: result.final_approval } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
async function rejectLeaseModification({ orgId, actorUserId, leaseId, modificationId, comment }) { const client = await pool.connect(); try { await client.query('BEGIN'); const modification = await getLeaseModification({ orgId, leaseId, modificationId }); const result = await workflow.rejectLeaseModificationWorkflow({ orgId, actorUserId, modification, comment, client }); await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_REJECTED', payload:{ modification_id: modificationId, comment: comment || null } }); await client.query('COMMIT'); return result; } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); } }


async function updateLeaseModification({ orgId, actorUserId, leaseId, modificationId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getLeaseBase({ orgId, leaseId, client });
    const { rows: existingRows } = await client.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 AND id=$3 FOR UPDATE`, [orgId, leaseId, modificationId]);
    if (!existingRows.length) throw new AppError(404, 'Lease modification not found');
    const existing = existingRows[0];
    if (!['draft','rejected'].includes(existing.status)) throw new AppError(409, `Lease modification can only be edited while draft or rejected. Current status is '${existing.status}'`);
    const fields = [
      ['effective_date', payload.effective_date ? toISODate(payload.effective_date) : undefined], ['reason', payload.reason], ['new_term_months', payload.new_term_months],
      ['new_payment_amount', payload.new_payment_amount], ['new_payments_per_year', payload.new_payments_per_year], ['new_annual_discount_rate', payload.new_annual_discount_rate],
      ['new_payment_timing', payload.new_payment_timing]
    ].filter(([, value]) => value !== undefined);
    if (!fields.length) throw new AppError(400, 'No modification fields supplied');
    const sets = fields.map(([field], idx) => `${field}=$${idx + 4}`);
    const values = fields.map(([, value]) => value);
    const { rows } = await client.query(`UPDATE lease_modifications SET ${sets.join(', ')}, status='draft', submitted_at=NULL, submitted_by=NULL, approved_at=NULL, approved_by=NULL, rejected_at=NULL, rejected_by=NULL, rejection_reason=NULL, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2 AND id=$3 RETURNING *`, [orgId, leaseId, modificationId, ...values]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_UPDATED', payload: rows[0] });
    await client.query('COMMIT');
    return rows[0];
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function deleteLeaseModification({ orgId, actorUserId, leaseId, modificationId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await getLeaseBase({ orgId, leaseId, client });
    const { rows: existingRows } = await client.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 AND id=$3 FOR UPDATE`, [orgId, leaseId, modificationId]);
    if (!existingRows.length) throw new AppError(404, 'Lease modification not found');
    const existing = existingRows[0];
    if (!['draft','rejected','voided'].includes(existing.status)) throw new AppError(409, `Lease modification cannot be deleted while '${existing.status}'`);
    await client.query(`DELETE FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 AND id=$3`, [orgId, leaseId, modificationId]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_DELETED', payload:{ modification_id: modificationId } });
    await client.query('COMMIT');
    return { deleted: true };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function applyLeaseModification({ orgId, actorUserId, leaseId, modificationId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { lease, contract, assets } = await loadLeaseMeasurementContext({ orgId, leaseId, client });
    if (!['active','draft'].includes(lease.status)) throw new AppError(409, `Lease modification apply is not allowed when lease status is '${lease.status}'`);
    const { rows } = await client.query(`SELECT * FROM lease_modifications WHERE organization_id=$1 AND lease_id=$2 AND id=$3 FOR UPDATE`, [orgId, leaseId, modificationId]);
    if (!rows.length) throw new AppError(404,'Lease modification not found');
    const modification = rows[0];
    if (modification.status !== 'approved') throw new AppError(409, 'Only approved modifications can be applied');
    await workflow.assertLeaseModificationApprovalStateAllowsAction({ orgId, modification, client, actionLabel: 'apply' });

    const effectiveDate = toISODate(modification.effective_date);
    const { rows: futurePosted } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 AND due_date >= $2 AND (posted_interest_payment_journal_id IS NOT NULL OR posted_depreciation_journal_id IS NOT NULL) LIMIT 1`, [leaseId, effectiveDate]);
    if (futurePosted.length) throw new AppError(409, 'Cannot apply modification because future schedule lines are already posted');

    const { rows: remainingRows } = await client.query(`SELECT * FROM lease_schedule_lines WHERE lease_id=$1 AND due_date >= $2 ORDER BY due_date ASC, line_no ASC`, [leaseId, effectiveDate]);
    const remainingLiability = remainingRows.length ? toDecimal(remainingRows[0].opening_balance) : new Decimal(0);
    const remainingTermMonths = remainingRows.length ? remainingRows.length * (12 / (lease.payments_per_year || 12)) : lease.term_months;
    const nextValues = {
      term_months: modification.new_term_months || remainingTermMonths,
      payment_amount: modification.new_payment_amount || lease.payment_amount,
      payments_per_year: modification.new_payments_per_year || lease.payments_per_year,
      annual_discount_rate: modification.new_annual_discount_rate ?? lease.annual_discount_rate,
      payment_timing: modification.new_payment_timing || lease.payment_timing,
    };
    const newMeasurement = buildMeasurement({ lease, contract, assets, effectiveDate, override: nextValues, existingLiability: null, fromModification: true });
    const delta = newMeasurement.leaseLiability.minus(remainingLiability).toDecimalPlaces(6);

    await client.query(`DELETE FROM lease_schedule_lines WHERE lease_id=$1 AND due_date >= $2`, [leaseId, effectiveDate]);
    await client.query(`UPDATE lease_payments SET schedule_line_id=NULL, updated_at=NOW() WHERE lease_id=$1 AND organization_id=$2 AND due_date >= $3 AND is_actual=FALSE`, [leaseId, orgId, effectiveDate]);
    await client.query(`UPDATE leases SET term_months=$3, payment_amount=$4, payments_per_year=$5, annual_discount_rate=$6, payment_timing=$7, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, leaseId, nextValues.term_months, nextValues.payment_amount, nextValues.payments_per_year, nextValues.annual_discount_rate, nextValues.payment_timing]);
    await client.query(`UPDATE lease_contracts SET payment_timing=$3, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2`, [orgId, leaseId, nextValues.payment_timing]);

    const scheduleLines = generateScheduleLines({ lease: { ...lease, ...nextValues }, measurement: newMeasurement, startDate: new Date(effectiveDate) });
    for (const line of scheduleLines) {
      const { rows: inserted } = await client.query(`INSERT INTO lease_schedule_lines(lease_id,line_no,due_date,opening_balance,payment_amount,interest_amount,principal_amount,closing_balance,depreciation_amount,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,due_date,payment_amount`, [leaseId, line.line_no, line.due_date, line.opening_balance, line.payment_amount, line.interest_amount, line.principal_amount, line.closing_balance, line.depreciation_amount, actorUserId]);
      await client.query(`INSERT INTO lease_payments(lease_id,organization_id,due_date,amount,payment_type,is_actual,schedule_line_id,created_by,reference)
        VALUES($1,$2,$3,$4,'fixed',FALSE,$5,$6,$7)
        ON CONFLICT (lease_id, due_date, payment_type, is_actual, reference) DO NOTHING`, [leaseId, orgId, inserted[0].due_date, inserted[0].payment_amount, inserted[0].id, actorUserId, `schedule:mod:${line.line_no}`]);
    }

    await client.query(`UPDATE leases SET initial_lease_liability=$3, monthly_depreciation_amount=$4, updated_at=NOW() WHERE organization_id=$1 AND id=$2`, [orgId, leaseId, newMeasurement.leaseLiability.toNumber(), newMeasurement.periodicDepreciation.toNumber()]);
    await client.query(`UPDATE lease_modifications SET status='applied', applied_at=NOW(), applied_by=$4, updated_at=NOW() WHERE organization_id=$1 AND lease_id=$2 AND id=$3`, [orgId, leaseId, modificationId, actorUserId]);

    let postedJournal = null;
    const period = await findOpenPeriodForDate({ orgId, date: effectiveDate });
    if (!delta.isZero()) {
      const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'MOD', modificationId]);
      postedJournal = await workflow.createAndPostWorkflowBackedJournal({
        orgId, actorUserId, client, sourceDocument: modification,
        payload: {
          periodId: period.id,
          entryDate: effectiveDate,
          memo: `IFRS16 Lease ${lease.code} - modification ${modificationId}`,
          idempotencyKey,
          lines: delta.greaterThan(0)
            ? [journalLine(lease.rou_asset_account_id, delta, 0, 'Lease modification - increase ROU asset'), journalLine(lease.lease_liability_account_id, 0, delta, 'Lease modification - increase lease liability')]
            : [journalLine(lease.lease_liability_account_id, delta.abs(), 0, 'Lease modification - decrease lease liability'), journalLine(lease.rou_asset_account_id, 0, delta.abs(), 'Lease modification - decrease ROU asset')],
        },
      });
      await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId: null, modificationId, action:'modification', idempotencyKey, journalEntryId: postedJournal.journalId });
    }
    await persistMeasurementSnapshot({ client, orgId, actorUserId, leaseId, modificationId, snapshotType: 'modification', measurement: newMeasurement, reason: modification.reason || null, payload: nextValues });
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'MODIFICATION_APPLIED', payload:{ modification_id: modificationId, journal_id: postedJournal?.journalId || null, previous_liability: remainingLiability.toNumber(), revised_liability: newMeasurement.leaseLiability.toNumber(), delta: delta.toNumber() } });
    await client.query('COMMIT');
    return { applied: true, modification_id: modificationId, journal_id: postedJournal?.journalId || null, liability_delta: delta.toNumber() };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function updateLeaseStatus({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const { rows } = await client.query(`SELECT * FROM leases WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [leaseId, orgId]); if (!rows.length) throw new AppError(404,'Lease not found'); const lease = rows[0];
    const current = lease.status, nextStatus = payload.status; if (current === nextStatus) { await client.query('COMMIT'); return { changed:false, before: lease, after: lease }; }
    if (current === 'draft' && nextStatus === 'active') throw new AppError(409, 'Use initial recognition posting to activate a lease'); if (current === 'draft' && nextStatus === 'closed') throw new AppError(409, 'Cannot close a draft lease'); if (['closed','terminated'].includes(current)) throw new AppError(409, `Cannot change status from '${current}'`);
    const effectiveDate = payload.effective_date ? toISODate(payload.effective_date) : null;
    if (current === 'active' && nextStatus === 'closed') {
      const { rows: unposted } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 AND (posted_interest_payment_journal_id IS NULL OR posted_depreciation_journal_id IS NULL) LIMIT 1`, [leaseId]);
      if (unposted.length) throw new AppError(409, 'Cannot close lease while there are unposted schedule lines');
    }
    let terminationJournal = null;
    if ((current === 'active' || current === 'draft') && nextStatus === 'terminated') {
      if (!effectiveDate) throw new AppError(400, 'effective_date is required to terminate a lease');
      const { rows: futurePosted } = await client.query(`SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 AND due_date > $2 AND (posted_interest_payment_journal_id IS NOT NULL OR posted_depreciation_journal_id IS NOT NULL) LIMIT 1`, [leaseId, effectiveDate]);
      if (futurePosted.length) throw new AppError(409, 'Cannot terminate lease because future lines are already posted');
      const { rows: lastLineRows } = await client.query(`SELECT opening_balance, depreciation_amount FROM lease_schedule_lines WHERE lease_id=$1 AND due_date >= $2 ORDER BY due_date ASC, line_no ASC LIMIT 1`, [leaseId, effectiveDate]);
      const remainingLiability = toDecimal(lastLineRows[0]?.opening_balance || 0);
      const { rows: depRows } = await client.query(`SELECT COALESCE(SUM(depreciation_amount),0)::numeric AS dep FROM lease_schedule_lines WHERE lease_id=$1 AND due_date < $2`, [leaseId, effectiveDate]);
      const rouGross = toDecimal(lease.initial_lease_liability || 0);
      const accumulatedDep = toDecimal(depRows[0]?.dep || 0);
      const rouNet = Decimal.max(rouGross.minus(accumulatedDep), 0);
      const delta = remainingLiability.minus(rouNet).toDecimalPlaces(6);
      if (remainingLiability.greaterThan(0) || rouNet.greaterThan(0)) {
        const period = await findOpenPeriodForDate({ orgId, date: effectiveDate });
        const idempotencyKey = buildIfrs16IdempotencyKey(['LEASE', leaseId, 'TERM', effectiveDate]);
        const lines = [journalLine(lease.lease_liability_account_id, remainingLiability, 0, 'Derecognise lease liability'), journalLine(lease.accumulated_depreciation_account_id, accumulatedDep, 0, 'Derecognise accumulated depreciation')];
        if (rouGross.greaterThan(0)) lines.push(journalLine(lease.rou_asset_account_id, 0, rouGross, 'Derecognise ROU asset'));
        if (!delta.isZero()) {
          if (delta.greaterThan(0)) lines.push(journalLine(lease.interest_expense_account_id, 0, delta, 'Termination gain'));
          else lines.push(journalLine(lease.interest_expense_account_id, delta.abs(), 0, 'Termination loss'));
        }
        terminationJournal = await workflow.createAndPostWorkflowBackedJournal({ orgId, actorUserId, client, sourceDocument: lease, payload: { periodId: period.id, entryDate: effectiveDate, memo: `IFRS16 Lease ${lease.code} - termination`, idempotencyKey, lines } });
        await recordLeasePostingLedger({ client, orgId, actorUserId, leaseId, scheduleLineId:null, modificationId:null, action:'termination', idempotencyKey, journalEntryId: terminationJournal.journalId });
      }
    }
    const { rows: updated } = await client.query(`UPDATE leases SET status=$3, status_reason=$4, terminated_at=CASE WHEN $3='terminated' THEN NOW() ELSE terminated_at END, closed_at=CASE WHEN $3='closed' THEN NOW() ELSE closed_at END, updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`, [orgId, leaseId, nextStatus, payload.reason || null]);
    await recordLeaseEvent({ client, orgId, actorUserId, leaseId, eventType:'STATUS_UPDATED', payload:{ from: current, to: nextStatus, effective_date: effectiveDate, reason: payload.reason || null, journal_id: terminationJournal?.journalId || null } });
    await client.query('COMMIT'); return { changed:true, before: lease, after: updated[0], journal_id: terminationJournal?.journalId || null };
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function listLeaseEvents({ orgId, leaseId, query }) { await getLeaseBase({ orgId, leaseId, client: pool }); const limit = Math.min(Number(query?.limit || 100), 500); const { rows } = await pool.query(`SELECT * FROM lease_events WHERE organization_id=$1 AND lease_id=$2 ORDER BY created_at DESC LIMIT $3`, [orgId, leaseId, limit]); return { items: rows }; }
async function listLeasePostingLedger({ orgId, leaseId }) { await getLeaseBase({ orgId, leaseId, client: pool }); const { rows } = await pool.query(`SELECT * FROM lease_posting_ledger WHERE organization_id=$1 AND lease_id=$2 ORDER BY created_at DESC`, [orgId, leaseId]); return { items: rows }; }

async function getLeaseDashboard({ orgId, query }) {
  const asOfDate = query?.as_of_date ? toISODate(query.as_of_date) : toISODate(new Date());
  const [summary, liability, depreciation, activity] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS lease_count,
                       COUNT(*) FILTER (WHERE status='active')::int AS active_count,
                       COUNT(*) FILTER (WHERE status='draft')::int AS draft_count,
                       COUNT(*) FILTER (WHERE status='terminated')::int AS terminated_count,
                       COUNT(*) FILTER (WHERE status='closed')::int AS closed_count
                FROM leases WHERE organization_id=$1`, [orgId]),
    pool.query(`SELECT COALESCE(SUM(s.lease_liability_amount),0)::numeric AS liability_balance,
                       COALESCE(SUM(CASE WHEN l.commencement_date <= $2 AND (l.terminated_at IS NULL OR l.terminated_at::date > $2) THEN LEAST(s.lease_liability_amount, COALESCE(n.next_12m, s.lease_liability_amount)) ELSE 0 END),0)::numeric AS current_liability
                FROM leases l
                LEFT JOIN LATERAL (
                  SELECT lease_liability_amount FROM lease_measurement_snapshots ms
                  WHERE ms.organization_id=l.organization_id AND ms.lease_id=l.id AND ms.effective_date <= $2
                  ORDER BY ms.effective_date DESC, ms.created_at DESC LIMIT 1
                ) s ON TRUE
                LEFT JOIN LATERAL (
                  SELECT COALESCE(SUM(payment_amount),0)::numeric AS next_12m
                  FROM lease_schedule_lines sl WHERE sl.lease_id=l.id AND sl.due_date > $2 AND sl.due_date <= ($2::date + INTERVAL '12 months')
                ) n ON TRUE
                WHERE l.organization_id=$1`, [orgId, asOfDate]),
    pool.query(`SELECT COALESCE(SUM(depreciation_amount),0)::numeric AS scheduled_depreciation FROM lease_schedule_lines lsl JOIN leases l ON l.id=lsl.lease_id WHERE l.organization_id=$1 AND lsl.due_date <= $2`, [orgId, asOfDate]),
    pool.query(`SELECT event_type, COUNT(*)::int AS count FROM lease_events WHERE organization_id=$1 AND created_at >= NOW() - INTERVAL '90 days' GROUP BY event_type ORDER BY count DESC`, [orgId]),
  ]);
  return { as_of_date: asOfDate, summary: summary.rows[0], liability: liability.rows[0], depreciation: depreciation.rows[0], recent_activity: activity.rows };
}

async function getDisclosureReport({ orgId, query }) {
  const asOfDate = query?.as_of_date ? toISODate(query.as_of_date) : toISODate(new Date());
  const [liabilityRollforward, rouRollforward, maturity, expenses] = await Promise.all([
    pool.query(`SELECT
      COALESCE(SUM(CASE WHEN snapshot_type='initial' AND effective_date <= $2 THEN lease_liability_amount ELSE 0 END),0)::numeric AS opening_liability,
      COALESCE(SUM(CASE WHEN snapshot_type='modification' AND effective_date <= $2 THEN lease_liability_amount ELSE 0 END),0)::numeric AS remeasurements,
      COALESCE((SELECT SUM(principal_amount) FROM lease_schedule_lines sl JOIN leases l ON l.id=sl.lease_id WHERE l.organization_id=$1 AND sl.due_date <= $2),0)::numeric AS principal_reduction,
      COALESCE((SELECT SUM(lease_liability_amount) FROM lease_measurement_snapshots ms JOIN leases l ON l.id=ms.lease_id WHERE l.organization_id=$1 AND ms.effective_date <= $2),0)::numeric AS closing_liability
      FROM lease_measurement_snapshots WHERE organization_id=$1`, [orgId, asOfDate]),
    pool.query(`SELECT
      COALESCE(SUM(CASE WHEN snapshot_type='initial' AND effective_date <= $2 THEN rou_asset_amount ELSE 0 END),0)::numeric AS rou_opening_cost,
      COALESCE(SUM(CASE WHEN snapshot_type='initial' AND effective_date <= $2 THEN rou_asset_amount ELSE 0 END),0)::numeric AS additions,
      COALESCE((SELECT SUM(depreciation_amount) FROM lease_schedule_lines sl JOIN leases l ON l.id=sl.lease_id WHERE l.organization_id=$1 AND sl.due_date <= $2),0)::numeric AS depreciation,
      0::numeric AS impairments,
      COALESCE((SELECT SUM(rou_asset_amount) FROM lease_measurement_snapshots ms JOIN leases l ON l.id=ms.lease_id WHERE l.organization_id=$1 AND ms.snapshot_type='modification' AND ms.effective_date <= $2),0)::numeric AS remeasurement_adjustments
      FROM lease_measurement_snapshots WHERE organization_id=$1`, [orgId, asOfDate]),
    pool.query(`SELECT CASE
                        WHEN due_date <= $2::date + INTERVAL '1 year' THEN 'within_1_year'
                        WHEN due_date <= $2::date + INTERVAL '5 years' THEN '1_to_5_years'
                        ELSE 'after_5_years'
                      END AS bucket,
                      COALESCE(SUM(lsl.payment_amount),0)::numeric AS undiscounted_cash_flows
                 FROM lease_schedule_lines lsl JOIN leases l ON l.id=lsl.lease_id
                WHERE l.organization_id=$1 AND lsl.due_date > $2
                GROUP BY 1 ORDER BY 1`, [orgId, asOfDate]),
    pool.query(`SELECT COALESCE(SUM(lsl.interest_amount) FILTER (WHERE lsl.due_date <= $2),0)::numeric AS interest_expense,
                       COALESCE(SUM(lsl.depreciation_amount) FILTER (WHERE lsl.due_date <= $2),0)::numeric AS depreciation_expense,
                       COALESCE(SUM(lp.amount) FILTER (WHERE lp.is_actual=TRUE AND lp.paid_date <= $2),0)::numeric AS actual_cash_outflow,
                       COALESCE(SUM(lp.amount) FILTER (WHERE l.recognition_model='short_term_exempt' AND lp.is_actual=TRUE AND lp.paid_date <= $2),0)::numeric AS short_term_lease_expense,
                       COALESCE(SUM(lp.amount) FILTER (WHERE l.recognition_model='low_value_exempt' AND lp.is_actual=TRUE AND lp.paid_date <= $2),0)::numeric AS low_value_lease_expense,
                       COALESCE(SUM(lp.amount) FILTER (WHERE lp.payment_type='variable' AND lp.is_actual=TRUE AND lp.paid_date <= $2),0)::numeric AS variable_lease_expense
                  FROM leases l LEFT JOIN lease_schedule_lines lsl ON lsl.lease_id=l.id LEFT JOIN lease_payments lp ON lp.lease_id=l.id AND lp.organization_id=l.organization_id
                 WHERE l.organization_id=$1`, [orgId, asOfDate]),
  ]);
  return { as_of_date: asOfDate, liability_rollforward: liabilityRollforward.rows[0] || {}, rou_rollforward: rouRollforward.rows[0] || {}, maturity_analysis: maturity.rows, expense_summary: expenses.rows[0] || {} };
}

module.exports = {
  createLeaseModification, listLeaseModifications, getLeaseModification, updateLeaseModification, deleteLeaseModification, applyLeaseModification,
  submitLeaseWorkflow, approveLease, rejectLease, submitLeaseModification, approveLeaseModification, rejectLeaseModification,
  updateLeaseStatus, listLeaseEvents, listLeasePostingLedger, getLeaseDashboard, getDisclosureReport,
};
