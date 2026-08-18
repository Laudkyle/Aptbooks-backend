const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

async function assertPaymentMethodAccount({ orgId, accountId, client = null }) {
  if (!accountId) return null;
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT id, code, name, is_postable, status
       FROM chart_of_accounts
      WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, "Invalid default payment account");
  if (!rows[0].is_postable) throw new AppError(400, "Default payment account must be postable");
  if (rows[0].status !== "active") throw new AppError(400, "Default payment account must be active");
  return rows[0];
}

async function listPaymentTerms({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_terms WHERE organization_id=$1 ORDER BY is_default DESC, name ASC`,
    [orgId]
  );
  return rows;
}

async function createPaymentTerm({ orgId, payload }) {
  const name = payload.name;
  const netDays = payload.netDays;
  const discountDays = payload.discountDays ?? null;
  const discountRate = payload.discountRate ?? null;
  const isDefault = payload.isDefault === true;
  const status = payload.status || "active";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query(
        `UPDATE payment_terms SET is_default=FALSE WHERE organization_id=$1`,
        [orgId]
      );
    }
    const { rows } = await client.query(
      `
      INSERT INTO payment_terms(
        organization_id, name, net_days, discount_days, discount_rate, is_default, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [orgId, name, netDays, discountDays, discountRate, isDefault, status]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function updatePaymentTerm({ orgId, id, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (payload.isDefault === true) {
      await client.query(
        `UPDATE payment_terms SET is_default=FALSE WHERE organization_id=$1`,
        [orgId]
      );
    }

    const fields = [];
    const params = [orgId, id];
    let i = 3;

    if (payload.name !== undefined) { fields.push(`name=$${i++}`); params.push(payload.name); }
    if (payload.netDays !== undefined) { fields.push(`net_days=$${i++}`); params.push(payload.netDays); }
    if (payload.discountDays !== undefined) { fields.push(`discount_days=$${i++}`); params.push(payload.discountDays); }
    if (payload.discountRate !== undefined) { fields.push(`discount_rate=$${i++}`); params.push(payload.discountRate); }
    if (payload.isDefault !== undefined) { fields.push(`is_default=$${i++}`); params.push(payload.isDefault === true); }
    if (payload.status !== undefined) { fields.push(`status=$${i++}`); params.push(payload.status); }

    if (!fields.length) {
      const { rows } = await client.query(
        `SELECT * FROM payment_terms WHERE organization_id=$1 AND id=$2`,
        [orgId, id]
      );
      await client.query("COMMIT");
      return rows[0] || null;
    }

    const { rows } = await client.query(
      `
      UPDATE payment_terms
      SET ${fields.join(", ")}
      WHERE organization_id=$1 AND id=$2
      RETURNING *
      `,
      params
    );

    await client.query("COMMIT");
    return rows[0] || null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function deletePaymentTerm({ orgId, id }) {
  const { rowCount } = await pool.query(
    `DELETE FROM payment_terms WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  return rowCount > 0;
}

async function listPaymentMethods({ orgId }) {
  const { rows } = await pool.query(
    `SELECT pm.*,
            coa.code AS default_account_code,
            coa.name AS default_account_name
       FROM payment_methods pm
       LEFT JOIN chart_of_accounts coa
         ON coa.id = pm.default_account_id
        AND coa.organization_id = pm.organization_id
      WHERE pm.organization_id=$1
      ORDER BY pm.name ASC`,
    [orgId]
  );
  return rows;
}

async function getPaymentMethodForOrg({ orgId, paymentMethodId, client = null }) {
  if (!paymentMethodId) return null;
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT pm.*, coa.code AS default_account_code, coa.name AS default_account_name
       FROM payment_methods pm
       LEFT JOIN chart_of_accounts coa
         ON coa.id = pm.default_account_id
        AND coa.organization_id = pm.organization_id
      WHERE pm.organization_id=$1 AND pm.id=$2`,
    [orgId, paymentMethodId]
  );
  return rows[0] || null;
}

async function createPaymentMethod({ orgId, payload }) {
  const { name, code, description, status = "active" } = payload;
  const defaultAccountId = payload.defaultAccountId || null;
  await assertPaymentMethodAccount({ orgId, accountId: defaultAccountId });

  const { rows } = await pool.query(
    `
    INSERT INTO payment_methods(
      organization_id, name, code, description, default_account_id, status
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
    `,
    [orgId, name, code, description, defaultAccountId, status]
  );
  return rows[0];
}

async function updatePaymentMethod({ orgId, id, payload }) {
  const client = await pool.connect();
  try {
    const fields = [];
    const params = [orgId, id];
    let i = 3;

    if (payload.name !== undefined) { 
      fields.push(`name=$${i++}`); 
      params.push(payload.name); 
    }
    if (payload.code !== undefined) { 
      fields.push(`code=$${i++}`); 
      params.push(payload.code); 
    }
    if (payload.description !== undefined) { 
      fields.push(`description=$${i++}`); 
      params.push(payload.description); 
    }
    if (payload.defaultAccountId !== undefined) {
      const defaultAccountId = payload.defaultAccountId || null;
      await assertPaymentMethodAccount({ orgId, accountId: defaultAccountId, client });
      fields.push(`default_account_id=$${i++}`);
      params.push(defaultAccountId);
    }
    if (payload.status !== undefined) { 
      fields.push(`status=$${i++}`); 
      params.push(payload.status); 
    }

    if (!fields.length) {
      const { rows } = await client.query(
        `SELECT * FROM payment_methods WHERE organization_id=$1 AND id=$2`,
        [orgId, id]
      );
      return rows[0] || null;
    }

    const { rows } = await client.query(
      `
      UPDATE payment_methods
      SET ${fields.join(", ")}
      WHERE organization_id=$1 AND id=$2
      RETURNING *
      `,
      params
    );

    return rows[0] || null;
  } finally {
    client.release();
  }
}

async function deletePaymentMethod({ orgId, id }) {
  const { rowCount } = await pool.query(
    `DELETE FROM payment_methods WHERE organization_id=$1 AND id=$2`,
    [orgId, id]
  );
  return rowCount > 0;
}

async function getPaymentSettings({ orgId, client = null }) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT * FROM payment_settings WHERE organization_id=$1`,
    [orgId]
  );
  return rows[0] || null;
}

async function upsertPaymentSettings({ orgId, payload }) {
  const arUnappliedAccountId = payload.arUnappliedAccountId || null;
  const arDiscountAccountId = payload.arDiscountAccountId || null;
  const apPrepaymentsAccountId = payload.apPrepaymentsAccountId || null;
  const apDiscountIncomeAccountId = payload.apDiscountIncomeAccountId || null;
  const onlineCashAccountId = payload.onlineCashAccountId || null;
  const onlinePaymentMethodId = payload.onlinePaymentMethodId || null;

  const { rows } = await pool.query(
    `
    INSERT INTO payment_settings(
      organization_id,
      ar_unapplied_account_id,
      ar_discount_account_id,
      ap_prepayments_account_id,
      ap_discount_income_account_id,
      online_cash_account_id,
      online_payment_method_id,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (organization_id)
    DO UPDATE SET
      ar_unapplied_account_id = EXCLUDED.ar_unapplied_account_id,
      ar_discount_account_id = EXCLUDED.ar_discount_account_id,
      ap_prepayments_account_id = EXCLUDED.ap_prepayments_account_id,
      ap_discount_income_account_id = EXCLUDED.ap_discount_income_account_id,
      online_cash_account_id = EXCLUDED.online_cash_account_id,
      online_payment_method_id = EXCLUDED.online_payment_method_id,
      updated_at = NOW()
    RETURNING *
    `,
    [orgId, arUnappliedAccountId, arDiscountAccountId, apPrepaymentsAccountId, apDiscountIncomeAccountId, onlineCashAccountId, onlinePaymentMethodId]
  );
  return rows[0];
}

module.exports = {
  listPaymentTerms,
  createPaymentTerm,
  updatePaymentTerm,
  deletePaymentTerm,
  listPaymentMethods,
  getPaymentMethodForOrg,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  getPaymentSettings,
  upsertPaymentSettings
};