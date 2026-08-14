const { bootstrapTenant, destroyTenant, auth, request, app, createBalancedJournal, pool } = require('./helpers/accountingTestContext');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

test('draft may be temporarily unbalanced, but submit is blocked until balance is restored', async () => {
  const created = await createBalancedJournal(ctx, { amount: '100.00', memo: 'Temporary imbalance test' });
  expect(created.status).toBe(201);
  const journalId = created.body.journalId;

  const unbalance = await auth(request(app).patch(`/core/accounting/journals/${journalId}/lines/1`), ctx)
    .send({ debit: '120.00' });
  expect(unbalance.status).toBe(200);

  const rejectedSubmit = await auth(request(app).post(`/core/accounting/journals/${journalId}/submit`), ctx).send({});
  expect(rejectedSubmit.status).toBe(400);
  expect(String(rejectedSubmit.body?.message || '')).toMatch(/balanc/i);

  const rebalance = await auth(request(app).patch(`/core/accounting/journals/${journalId}/lines/2`), ctx)
    .send({ credit: '120.00' });
  expect(rebalance.status).toBe(200);

  const submitted = await auth(request(app).post(`/core/accounting/journals/${journalId}/submit`), ctx).send({});
  expect(submitted.status).toBe(200);
  expect(submitted.body.status).toBe('submitted');
});

test('a one-line draft is editable but cannot be submitted', async () => {
  const created = await createBalancedJournal(ctx, { amount: '25.00', memo: 'Minimum lines test' });
  const journalId = created.body.journalId;

  const deleted = await auth(request(app).delete(`/core/accounting/journals/${journalId}/lines/2`), ctx);
  expect(deleted.status).toBe(200);

  const submit = await auth(request(app).post(`/core/accounting/journals/${journalId}/submit`), ctx).send({});
  expect(submit.status).toBe(400);
  expect(String(submit.body?.message || '')).toMatch(/at least two lines/i);
});

test('PATCH line does not require description when changing an amount', async () => {
  const created = await createBalancedJournal(ctx, { amount: '40.00', memo: 'Partial patch test' });
  const journalId = created.body.journalId;
  const patch = await auth(request(app).patch(`/core/accounting/journals/${journalId}/lines/1`), ctx).send({ debit: '41.00' });
  expect(patch.status).toBe(200);
});
