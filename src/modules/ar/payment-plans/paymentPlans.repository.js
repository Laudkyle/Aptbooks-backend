const { AppError } = require('../../../shared/errors/AppError');

async function listPlans({ orgId, status, client }) {
  const { rows } = await client.query(
    `SELECT * FROM payment_plans WHERE organization_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY id DESC`,
    [orgId, status || null]
  );
  return rows;
}

async function getPlan({ orgId, id, client }) {
  const { rows } = await client.query(`SELECT * FROM payment_plans WHERE organization_id=$1 AND id=$2`, [orgId, id]);
  if (!rows.length) throw new AppError(404, 'Payment plan not found');
  const installments = await client.query(
    `SELECT * FROM payment_plan_installments WHERE organization_id=$1 AND payment_plan_id=$2 ORDER BY due_date ASC, id ASC`,
    [orgId, id]
  );
  return { ...rows[0], installments: installments.rows };
}

async function createPlan({ orgId, actorUserId, payload, installments, client }) {
  const { rows } = await client.query(
    `INSERT INTO payment_plans (organization_id, entity_type, entity_id, partner_id, total_amount, start_date, frequency, installment_count, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)
     RETURNING *`,
    [orgId, payload.entity_type, payload.entity_id, payload.partner_id, payload.total_amount, payload.start_date, payload.frequency, payload.installment_count, actorUserId]
  );
  const plan = rows[0];
  for (const ins of installments) {
    await client.query(
      `INSERT INTO payment_plan_installments (organization_id, payment_plan_id, due_date, amount, status)
       VALUES ($1,$2,$3,$4,'due')`,
      [orgId, plan.id, ins.due_date, ins.amount]
    );
  }
  return getPlan({ orgId, id: plan.id, client });
}

async function cancelPlan({ orgId, id, actorUserId, client }) {
  const { rows } = await client.query(
    `UPDATE payment_plans SET status='cancelled', updated_at=NOW() WHERE organization_id=$1 AND id=$2 AND status='active' RETURNING *`,
    [orgId, id]
  );
  if (!rows.length) throw new AppError(400, 'Plan not active or not found');
  return getPlan({ orgId, id, client });
}

async function markInstallmentPaid({ orgId, installmentId, settlement_ref, client }) {
  const { rows } = await client.query(
    `UPDATE payment_plan_installments
        SET status='paid', paid_at=NOW(), settlement_ref=$3, updated_at=NOW()
      WHERE organization_id=$1 AND id=$2 AND status='due'
      RETURNING *`,
    [orgId, installmentId, settlement_ref || null]
  );
  if (!rows.length) throw new AppError(400, 'Installment not due or not found');
  return rows[0];
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  cancelPlan,
  markInstallmentPaid
};
