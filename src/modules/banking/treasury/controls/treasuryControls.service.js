const { pool } = require('../../../../db/pool');
const { AppError } = require('../../../../shared/errors/AppError');
const { writeAudit } = require('../../../../core/foundation/audit-logs/audit.service');
const { normalizeMoney } = require('../../../../shared/utils/financialMath');

const DEFAULTS = Object.freeze({
  enforce_maker_checker: true,
  require_execution_by_different_user: true,
  require_payment_run_approval: true,
  require_transfer_approval: true,
  default_reconciliation_tolerance: '0.01',
});

async function get(orgId, client = pool) {
  const { rows } = await client.query(
    `SELECT organization_id, enforce_maker_checker, require_execution_by_different_user,
            require_payment_run_approval, require_transfer_approval,
            default_reconciliation_tolerance, updated_by, updated_at
       FROM treasury_controls WHERE organization_id=$1`, [orgId]
  );
  return rows[0] || { organization_id: orgId, ...DEFAULTS, updated_by: null, updated_at: null };
}

async function upsert(orgId, actorUserId, payload, client = pool) {
  const tolerance = normalizeMoney(payload.defaultReconciliationTolerance ?? payload.default_reconciliation_tolerance ?? DEFAULTS.default_reconciliation_tolerance);
  if (Number(tolerance) < 0) throw new AppError(422, 'defaultReconciliationTolerance cannot be negative');
  const before = await get(orgId, client);
  const { rows } = await client.query(
    `INSERT INTO treasury_controls(
       organization_id, enforce_maker_checker, require_execution_by_different_user,
       require_payment_run_approval, require_transfer_approval, default_reconciliation_tolerance,
       updated_by, updated_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (organization_id) DO UPDATE SET
       enforce_maker_checker=EXCLUDED.enforce_maker_checker,
       require_execution_by_different_user=EXCLUDED.require_execution_by_different_user,
       require_payment_run_approval=EXCLUDED.require_payment_run_approval,
       require_transfer_approval=EXCLUDED.require_transfer_approval,
       default_reconciliation_tolerance=EXCLUDED.default_reconciliation_tolerance,
       updated_by=EXCLUDED.updated_by,
       updated_at=NOW()
     RETURNING *`,
    [orgId,
      payload.enforceMakerChecker ?? payload.enforce_maker_checker ?? DEFAULTS.enforce_maker_checker,
      payload.requireExecutionByDifferentUser ?? payload.require_execution_by_different_user ?? DEFAULTS.require_execution_by_different_user,
      payload.requirePaymentRunApproval ?? payload.require_payment_run_approval ?? DEFAULTS.require_payment_run_approval,
      payload.requireTransferApproval ?? payload.require_transfer_approval ?? DEFAULTS.require_transfer_approval,
      tolerance, actorUserId || null]
  );
  await writeAudit({ organizationId: orgId, actorUserId, action: 'TREASURY_CONTROLS_UPDATED', entityType: 'treasury_controls', entityId: orgId, before, after: rows[0], client });
  return rows[0];
}

function assertMakerChecker(controls, { actorUserId, createdByUserId, action = 'approve' }) {
  if (controls?.enforce_maker_checker && actorUserId && createdByUserId && String(actorUserId) === String(createdByUserId)) {
    throw new AppError(409, `Maker-checker control: the creator cannot ${action} this treasury instruction`);
  }
}

function assertExecutionSeparation(controls, { actorUserId, approvedByUserId, action = 'execute' }) {
  if (controls?.require_execution_by_different_user && actorUserId && approvedByUserId && String(actorUserId) === String(approvedByUserId)) {
    throw new AppError(409, `Execution control: the approver cannot ${action} the same treasury instruction`);
  }
}

module.exports = { DEFAULTS, get, upsert, assertMakerChecker, assertExecutionSeparation };
