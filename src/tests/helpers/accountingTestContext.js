const crypto = require('crypto');
const request = require('supertest');
const app = require('../../app');
const { pool } = require('../../db/pool');
const { initializeOrganizationDefaults } = require('../../core/foundation/organizations/organizations.service');

function suffix() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function bootstrapTenant({ baseCurrencyCode = 'GHS' } = {}) {
  const id = suffix();
  const email = `qa-${id}@aptbooks.local`;
  const password = 'Step3-Test-Only-123!';
  const client = await pool.connect();
  let orgId;
  try {
    await client.query('BEGIN');
    const org = await client.query(
      `INSERT INTO organizations(name, base_currency_code) VALUES($1,$2) RETURNING id`,
      [`QA ${id}`, baseCurrencyCode]
    );
    orgId = org.rows[0].id;
    await initializeOrganizationDefaults({ client, orgId, adminEmail: email, adminPassword: password, baseCurrencyCode });
    await client.query(
      `INSERT INTO document_workflow_statics(
         organization_id, creator_can_approve, creator_can_post, allow_self_approval,
         require_comment_on_rejection, notify_creator_on_approval, notify_creator_on_rejection
       ) VALUES($1,TRUE,TRUE,TRUE,TRUE,FALSE,FALSE)`,
      [orgId]
    );
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  const login = await request(app).post('/auth/login').send({ email, password });
  if (login.status !== 200 || !login.body.accessToken) {
    throw new Error(`Test tenant login failed (${login.status}): ${JSON.stringify(login.body)}`);
  }
  const setCookie = login.headers['set-cookie'] || [];
  const cookieToken = setCookie.length
    ? decodeURIComponent(String(setCookie[0]).split(';')[0].split('=').slice(1).join('='))
    : null;
  const refreshToken = login.body.refreshToken || cookieToken || null;

  const user = await pool.query(`SELECT id FROM users WHERE organization_id=$1 AND email=$2`, [orgId, email]);
  const period = await pool.query(
    `SELECT id, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND status='open' ORDER BY start_date LIMIT 1`,
    [orgId]
  );
  const accounts = await pool.query(
    `SELECT id, code FROM chart_of_accounts WHERE organization_id=$1 AND code = ANY($2::text[])`,
    [orgId, ['1000', '4000', '5000']]
  );
  const byCode = Object.fromEntries(accounts.rows.map((r) => [r.code, r.id]));

  return {
    id,
    orgId,
    userId: user.rows[0].id,
    email,
    password,
    token: login.body.accessToken,
    refreshToken,
    refreshSetCookie: setCookie,
    periodId: period.rows[0].id,
    entryDate: String(period.rows[0].start_date).slice(0, 10),
    cashAccountId: byCode['1000'],
    revenueAccountId: byCode['4000'],
    expenseAccountId: byCode['5000'],
  };
}

async function destroyTenant(ctx) {
  if (!ctx?.orgId) return;
  await pool.query(`DELETE FROM organizations WHERE id=$1`, [ctx.orgId]);
}

function auth(req, ctx) {
  return req.set('Authorization', `Bearer ${ctx.token}`);
}

async function createBalancedJournal(ctx, { amount = '100.00', currencyCode, fxRate, memo = 'Step 3 fixture' } = {}) {
  const lineCurrency = currencyCode ? { currencyCode, fxRate } : {};
  return auth(request(app).post('/core/accounting/journals'), ctx).send({
    periodId: ctx.periodId,
    entryDate: ctx.entryDate,
    memo,
    typeCode: 'GENERAL',
    idempotencyKey: `step3-${suffix()}`,
    lines: [
      { accountId: ctx.cashAccountId, description: 'Cash', debit: amount, ...lineCurrency },
      { accountId: ctx.revenueAccountId, description: 'Revenue', credit: amount, ...lineCurrency },
    ],
  });
}

module.exports = { app, pool, request, bootstrapTenant, destroyTenant, auth, createBalancedJournal, suffix };
