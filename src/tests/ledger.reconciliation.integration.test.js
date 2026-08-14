const { bootstrapTenant, destroyTenant, auth, request, app, createBalancedJournal, pool } = require('./helpers/accountingTestContext');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

test('canonical ledger totals reconcile with projection and survive reversal semantics', async () => {
  const before = await auth(request(app).get(`/core/accounting/balances/trial-balance?periodId=${ctx.periodId}`), ctx);
  expect(before.status).toBe(200);

  const created = await createBalancedJournal(ctx, { amount: '500.00', memo: 'Reconciliation lifecycle test' });
  const journalId = created.body.journalId;
  const posted = await auth(request(app).post(`/core/accounting/journals/${journalId}/post`), ctx).send({});
  expect(posted.status).toBe(200);

  const rec1 = await auth(request(app).get(`/core/accounting/reconciliation/period?periodId=${ctx.periodId}`), ctx);
  expect(rec1.status).toBe(200);
  expect(rec1.body.data.summary.exactMismatches).toBe(0);

  const voided = await auth(request(app).post(`/core/accounting/journals/${journalId}/void`), ctx).send({ reason: 'Step 3 reversal test' });
  expect(voided.status).toBe(200);

  const canonical = await pool.query(
    `SELECT account_id, debit_total, credit_total FROM accounting_posted_ledger_totals WHERE organization_id=$1 AND period_id=$2 AND account_id = ANY($3::uuid[]) ORDER BY account_id`,
    [ctx.orgId, ctx.periodId, [ctx.cashAccountId, ctx.revenueAccountId]]
  );
  const projection = await pool.query(
    `SELECT account_id, debit_total, credit_total FROM general_ledger_balances WHERE organization_id=$1 AND period_id=$2 AND account_id = ANY($3::uuid[]) ORDER BY account_id`,
    [ctx.orgId, ctx.periodId, [ctx.cashAccountId, ctx.revenueAccountId]]
  );
  expect(canonical.rows).toEqual(projection.rows);

  const rec2 = await auth(request(app).get(`/core/accounting/reconciliation/period?periodId=${ctx.periodId}`), ctx);
  expect(rec2.status).toBe(200);
  expect(rec2.body.data.summary.exactMismatches).toBe(0);
});

test('rebuild of GL projection reproduces canonical journal-derived totals', async () => {
  const created = await createBalancedJournal(ctx, { amount: '19.00', memo: 'Rebuild projection test' });
  await auth(request(app).post(`/core/accounting/journals/${created.body.journalId}/post`), ctx).send({});

  await pool.query(`UPDATE general_ledger_balances SET debit_total=debit_total+1 WHERE organization_id=$1 AND period_id=$2 AND account_id=$3`, [ctx.orgId, ctx.periodId, ctx.cashAccountId]);
  const bad = await auth(request(app).get(`/core/accounting/reconciliation/period?periodId=${ctx.periodId}`), ctx);
  expect(bad.body.data.summary.exactMismatches).toBeGreaterThan(0);

  const rebuilt = await auth(request(app).post('/core/accounting/reconciliation/rebuild-balances'), ctx).send({ periodId: ctx.periodId, dryRun: false });
  expect(rebuilt.status).toBe(200);

  const good = await auth(request(app).get(`/core/accounting/reconciliation/period?periodId=${ctx.periodId}`), ctx);
  expect(good.body.data.summary.exactMismatches).toBe(0);
});
