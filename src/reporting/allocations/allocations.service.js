const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");
const { trialBalance } = require("../../core/accounting/ledger/balances.service");

function assertCode(code) {
  if (!code || typeof code !== "string") throw new AppError(400, "code is required");
}

function assertName(name) {
  if (!name || typeof name !== "string") throw new AppError(400, "name is required");
}

async function listBases({ orgId }) {
  const { rows } = await pool.query(
    `SELECT id, code, name, basis_type, payload_json, status FROM allocation_bases WHERE organization_id=$1 ORDER BY code`,
    [orgId]
  );
  return rows;
}

async function createBase({ orgId, code, name, basisType, payloadJson, status, actorUserId, req }) {
  assertCode(code);
  assertName(name);
  if (!basisType) throw new AppError(400, "basisType is required");
  const { rows } = await pool.query(
    `
    INSERT INTO allocation_bases(organization_id, code, name, basis_type, payload_json, status)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, code, name, basis_type, payload_json, status
    `,
    [orgId, code, name, basisType, payloadJson || {}, status || 'active']
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.allocation.base.create",
    entityType: "allocation_base",
    entityId: rows[0].id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: rows[0],
  });

  return rows[0];
}

async function listRules({ orgId }) {
  const { rows } = await pool.query(
    `
    SELECT id, code, name, source_account_id, target_dimension, allocation_base_id, payload_json, status
    FROM allocation_rules
    WHERE organization_id=$1
    ORDER BY code
    `,
    [orgId]
  );
  return rows;
}

async function createRule({ orgId, code, name, sourceAccountId, targetDimension, allocationBaseId, payloadJson, status, actorUserId, req }) {
  assertCode(code);
  assertName(name);
  if (!targetDimension) throw new AppError(400, "targetDimension is required");
  const { rows } = await pool.query(
    `
    INSERT INTO allocation_rules(
      organization_id, code, name, source_account_id, target_dimension, allocation_base_id, payload_json, status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id, code, name, source_account_id, target_dimension, allocation_base_id, payload_json, status
    `,
    [orgId, code, name, sourceAccountId || null, targetDimension, allocationBaseId || null, payloadJson || {}, status || 'active']
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.allocation.rule.create",
    entityType: "allocation_rule",
    entityId: rows[0].id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: rows[0],
  });

  return rows[0];
}

async function computeAndPersist({ orgId, ruleId, periodId, actorUserId, req }) {
  if (!ruleId) throw new AppError(400, "ruleId is required");
  if (!periodId) throw new AppError(400, "periodId is required");

  const { rows: ruleRows } = await pool.query(
    `SELECT * FROM allocation_rules WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [orgId, ruleId]
  );
  if (!ruleRows.length) throw new AppError(404, "Allocation rule not found");
  const rule = ruleRows[0];

  // MVP computation: snapshot the source account balance (or all balances) and attach the base payload.
  // Full allocation engine can be implemented without schema changes.
  const tb = await trialBalance({ orgId, periodId });
  const scoped = rule.source_account_id
    ? tb.filter((r) => r.account_id === rule.source_account_id)
    : tb;

  const payload = {
    periodId,
    rule: {
      id: rule.id,
      code: rule.code,
      name: rule.name,
      source_account_id: rule.source_account_id,
      target_dimension: rule.target_dimension,
      allocation_base_id: rule.allocation_base_id,
    },
    trial_balance_snapshot: scoped,
    note: "MVP allocation snapshot. Extend with basis weights + target splits.",
  };

  const { rows } = await pool.query(
    `
    INSERT INTO cost_allocations(organization_id, rule_id, period_id, status, payload_json)
    VALUES ($1,$2,$3,'computed',$4)
    RETURNING id, rule_id, period_id, status, computed_at, created_at
    `,
    [orgId, ruleId, periodId, payload]
  );

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.allocation.compute",
    entityType: "cost_allocation",
    entityId: rows[0].id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { ruleId, periodId },
  });

  return rows[0];
}

module.exports = {
  listBases,
  createBase,
  listRules,
  createRule,
  computeAndPersist,
};
