const { pool } = require('../../../db/pool');
const { AppError } = require('../../../shared/errors/AppError');
const paymentIF = require('../../../interfaces/paymentConfig.interface');

async function assertPostableActiveAccount({ orgId, accountId, client = null, label = 'payment account' }) {
  if (!accountId) throw new AppError(400, `Missing ${label}`);
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT id, code, name, is_postable, status
       FROM chart_of_accounts
      WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `Invalid ${label}`);
  if (!rows[0].is_postable) throw new AppError(400, `${label} must be postable`);
  if (rows[0].status !== 'active') throw new AppError(400, `${label} must be active`);
  return rows[0];
}

async function resolvePaymentAccount({ orgId, paymentMethodId, cashAccountId, client = null }) {
  let method = null;
  if (paymentMethodId) {
    method = await paymentIF.getPaymentMethodForOrg({ orgId, paymentMethodId, client });
    if (!method) throw new AppError(400, 'Invalid paymentMethodId');
    if (method.status !== 'active') throw new AppError(400, 'Inactive payment method cannot be used');
  }

  const resolvedAccountId = cashAccountId || method?.default_account_id || null;
  if (!resolvedAccountId) {
    if (method) {
      throw new AppError(400, `Payment method "${method.name}" has no default account. Configure one or select an account for this transaction.`);
    }
    throw new AppError(400, 'Select a payment account');
  }

  const account = await assertPostableActiveAccount({
    orgId,
    accountId: resolvedAccountId,
    client,
    label: 'payment account',
  });

  return { accountId: account.id, account, paymentMethod: method };
}

module.exports = { assertPostableActiveAccount, resolvePaymentAccount };
