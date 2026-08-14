const { bootstrapTenant, destroyTenant, auth, request, app, pool } = require('./helpers/accountingTestContext');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

async function createFx(amount, rate) {
  return auth(request(app).post('/core/accounting/journals'), ctx).send({
    periodId: ctx.periodId,
    entryDate: ctx.entryDate,
    memo: `FX ${amount} @ ${rate}`,
    typeCode: 'GENERAL',
    lines: [
      { accountId: ctx.cashAccountId, description: 'FX cash', debit: amount, currencyCode: 'USD', fxRate: rate },
      { accountId: ctx.revenueAccountId, description: 'FX revenue', credit: amount, currencyCode: 'USD', fxRate: rate },
    ],
  });
}

test('FX midpoint uses half-up rounding instead of truncation', async () => {
  const created = await createFx('1.00', '1.005000');
  expect(created.status).toBe(201);
  const detail = await auth(request(app).get(`/core/accounting/journals/${created.body.journalId}`), ctx);
  expect(detail.body.lines.map((l) => l.amount_base)).toEqual(['1.01', '1.01']);
  expect(detail.body.lines.map((l) => l.fx_rate)).toEqual(['1.005000', '1.005000']);
});

test('six-decimal FX rate survives persistence exactly', async () => {
  const created = await createFx('10.01', '1.234567');
  const detail = await auth(request(app).get(`/core/accounting/journals/${created.body.journalId}`), ctx);
  expect(detail.body.lines.every((l) => l.fx_rate === '1.234567')).toBe(true);
  expect(detail.body.lines.every((l) => l.amount_base === '12.36')).toBe(true);
});
