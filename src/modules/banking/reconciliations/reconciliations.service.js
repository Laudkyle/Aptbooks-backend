const repo = require("./reconciliations.repository");
const { AppError } = require("../../../shared/errors/AppError");
const { pool } = require("../../../db/pool");
const { withTransaction } = require("../../../db/tx");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");

async function reconcile(orgId, userId, payload) {
  const req=["bankAccountId","periodId"];
  for (const k of req) if (!payload?.[k]) throw new AppError(400, `${k} is required`);

  return withTransaction(async (client) => {
    // Prevent concurrent reconciliations for the same org/account/period
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`recon:${orgId}:${payload.bankAccountId}:${payload.periodId}`]
    );

    // Validate bank account belongs to org
    const { rows: ba } = await client.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.bankAccountId]
    );
    if (!ba.length) throw new AppError(404, "Bank account not found");

    // Ensure period open (reconcile only within open periods)
    const { rows: p } = await client.query(
      `SELECT status FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.periodId]
    );
    if (!p.length) throw new AppError(404, "Period not found");
    if (p[0].status !== "open") throw new AppError(409, "Period not open");

    // Natural idempotency: if an active reconciliation already exists, return it.
    const existing = await repo.findActive(orgId, payload.bankAccountId, payload.periodId, client);
    if (existing) return existing;

    const created = await repo.create(orgId, userId, payload, client);
    await writeAudit({
      organizationId: orgId,
      actorUserId: userId,
      action: "BANK_RECONCILIATION_CREATED",
      entityType: "bank_reconciliation",
      entityId: created.id,
      after: {
        bank_account_id: payload.bankAccountId,
        period_id: payload.periodId
      }
    });
    return created;
  });
}

module.exports = { reconcile };
