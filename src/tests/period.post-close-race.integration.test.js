const { bootstrapTenant, destroyTenant, auth, request, app, createBalancedJournal, pool } = require('./helpers/accountingTestContext');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

test('period close cannot strand a journal unposted inside a newly closed period', async () => {
  const created = await createBalancedJournal(ctx, { amount: '61.00', memo: 'Period close/post race' });
  const journalId = created.body.journalId;

  const [post, close] = await Promise.all([
    auth(request(app).post(`/core/accounting/journals/${journalId}/post`), ctx).send({}),
    auth(request(app).post(`/core/accounting/periods/${ctx.periodId}/close`), ctx).send({ autoRunAccruals: false }),
  ]);

  expect([200, 409]).toContain(post.status);
  expect([200, 409]).toContain(close.status);

  const state = await pool.query(
    `SELECT je.status AS journal_status, ap.status AS period_status
       FROM journal_entries je JOIN accounting_periods ap ON ap.id=je.period_id
      WHERE je.organization_id=$1 AND je.id=$2`,
    [ctx.orgId, journalId]
  );
  const row = state.rows[0];
  if (row.period_status === 'closed') expect(row.journal_status).toBe('posted');
  if (row.journal_status === 'draft') expect(row.period_status).toBe('open');
});
