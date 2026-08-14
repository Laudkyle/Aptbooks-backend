const { bootstrapTenant, destroyTenant, auth, request, app, createBalancedJournal, pool } = require('./helpers/accountingTestContext');
let a; let b;

beforeAll(async () => { a = await bootstrapTenant(); b = await bootstrapTenant(); }, 180000);
afterAll(async () => { await destroyTenant(a); await destroyTenant(b); await pool.end(); });

test('organization A cannot read organization B journal by guessed ID', async () => {
  const created = await createBalancedJournal(b, { amount: '77.00', memo: 'Tenant B private journal' });
  expect(created.status).toBe(201);
  const res = await auth(request(app).get(`/core/accounting/journals/${created.body.journalId}`), a);
  expect([403, 404]).toContain(res.status);
});

test('database rejects a journal line that points to another tenant account', async () => {
  const created = await createBalancedJournal(a, { amount: '11.00', memo: 'Tenant trigger fixture' });
  const journalId = created.body.journalId;
  const nextLine = await pool.query(`SELECT COALESCE(MAX(line_no),0)+1 AS n FROM journal_entry_lines WHERE journal_entry_id=$1`, [journalId]);
  await expect(pool.query(
    `INSERT INTO journal_entry_lines(journal_entry_id,line_no,account_id,description,debit,credit,currency_code,fx_rate,amount_base)
     VALUES($1,$2,$3,'cross tenant','1.00','0.00','GHS','1.000000','1.00')`,
    [journalId, nextLine.rows[0].n, b.cashAccountId]
  )).rejects.toMatchObject({ code: '23514' });
});

test('database rejects journal period from another tenant', async () => {
  const type = await pool.query(`SELECT id FROM journal_entry_types WHERE code='GENERAL' LIMIT 1`);
  await expect(pool.query(
    `INSERT INTO journal_entries(organization_id,journal_entry_type_id,period_id,entry_date,memo,status)
     VALUES($1,$2,$3,$4,'cross tenant period','draft')`,
    [a.orgId, type.rows[0].id, b.periodId, a.entryDate]
  )).rejects.toMatchObject({ code: '23503' });
});
