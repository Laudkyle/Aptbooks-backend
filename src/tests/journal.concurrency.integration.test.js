const { bootstrapTenant, destroyTenant, auth, request, app, createBalancedJournal, pool, suffix } = require('./helpers/accountingTestContext');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

test('concurrent post requests produce exactly one posted journal effect', async () => {
  const created = await createBalancedJournal(ctx, { amount: '88.00', memo: 'Concurrent posting test' });
  const journalId = created.body.journalId;

  const [p1, p2] = await Promise.all([
    auth(request(app).post(`/core/accounting/journals/${journalId}/post`), ctx).send({}),
    auth(request(app).post(`/core/accounting/journals/${journalId}/post`), ctx).send({}),
  ]);
  expect([p1.status, p2.status].filter((s) => s === 200)).toHaveLength(1);
  expect([p1.status, p2.status].some((s) => s === 409)).toBe(true);

  const lines = await pool.query(`SELECT account_id, amount_base, debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`, [journalId]);
  for (const line of lines.rows) {
    const gl = await pool.query(
      `SELECT debit_total, credit_total FROM general_ledger_balances WHERE organization_id=$1 AND period_id=$2 AND account_id=$3`,
      [ctx.orgId, ctx.periodId, line.account_id]
    );
    const expectedDebit = Number(line.debit) > 0 ? Number(line.amount_base) : 0;
    const expectedCredit = Number(line.credit) > 0 ? Number(line.amount_base) : 0;
    expect(Number(gl.rows[0].debit_total)).toBeCloseTo(expectedDebit, 2);
    expect(Number(gl.rows[0].credit_total)).toBeCloseTo(expectedCredit, 2);
  }
});

test('concurrent identical idempotent creates resolve to one journal ID', async () => {
  const key = `idem-${suffix()}`;
  const body = {
    periodId: ctx.periodId,
    entryDate: ctx.entryDate,
    memo: 'Concurrent idempotency test',
    typeCode: 'GENERAL',
    idempotencyKey: key,
    lines: [
      { accountId: ctx.cashAccountId, description: 'Cash', debit: '33.00' },
      { accountId: ctx.revenueAccountId, description: 'Revenue', credit: '33.00' },
    ],
  };
  const [a, b] = await Promise.all([
    auth(request(app).post('/core/accounting/journals'), ctx).send(body),
    auth(request(app).post('/core/accounting/journals'), ctx).send(body),
  ]);
  expect([200, 201]).toContain(a.status);
  expect([200, 201]).toContain(b.status);
  expect(a.body.journalId).toBe(b.body.journalId);
  const count = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE organization_id=$1 AND idempotency_key=$2`, [ctx.orgId, key]);
  expect(count.rows[0].n).toBe(1);
});
