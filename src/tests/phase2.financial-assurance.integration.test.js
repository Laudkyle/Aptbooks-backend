const { bootstrapTenant, destroyTenant, auth, request, app, pool, suffix } = require('./helpers/accountingTestContext');
const postingEngine = require('../core/accounting/posting/postingEngine.service');
const { runWithTenant } = require('../shared/security/tenantContext');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

test('same financial idempotency key cannot be reused with different accounting content', async () => {
  const key = `phase2-idem-${suffix()}`;
  const basePayload = {
    periodId: ctx.periodId,
    entryDate: ctx.entryDate,
    memo: 'Phase 2 idempotency binding',
    typeCode: 'GENERAL',
    idempotencyKey: key,
    lines: [
      { accountId: ctx.cashAccountId, debit: '10.00' },
      { accountId: ctx.revenueAccountId, credit: '10.00' },
    ],
  };

  await runWithTenant(ctx.orgId, () => postingEngine.createDraftJournal({
    orgId: ctx.orgId, actorUserId: ctx.userId, payload: basePayload,
    source: { type: 'test', id: key, action: 'create', module: 'phase2' },
  }));

  await expect(runWithTenant(ctx.orgId, () => postingEngine.createDraftJournal({
    orgId: ctx.orgId, actorUserId: ctx.userId,
    payload: { ...basePayload, lines: [
      { accountId: ctx.cashAccountId, debit: '11.00' },
      { accountId: ctx.revenueAccountId, credit: '11.00' },
    ] },
    source: { type: 'test', id: key, action: 'create', module: 'phase2' },
  }))).rejects.toMatchObject({ code: 'financial_idempotency_conflict' });
});

test('domain idempotency replays a committed post instead of double-posting', async () => {
  const createKey = `phase2-post-create-${suffix()}`;
  const draft = await runWithTenant(ctx.orgId, () => postingEngine.createDraftJournal({
    orgId: ctx.orgId,
    actorUserId: ctx.userId,
    payload: {
      periodId: ctx.periodId,
      entryDate: ctx.entryDate,
      memo: 'Phase 2 post replay',
      typeCode: 'GENERAL',
      idempotencyKey: createKey,
      lines: [
        { accountId: ctx.cashAccountId, debit: '12.00' },
        { accountId: ctx.revenueAccountId, credit: '12.00' },
      ],
    },
  }));
  const postKey = `phase2-post-command-${suffix()}`;
  const first = await runWithTenant(ctx.orgId, () => postingEngine.postDraftJournal({
    orgId: ctx.orgId, journalId: draft.journalId, actorUserId: ctx.userId, idempotencyKey: postKey,
  }));
  const second = await runWithTenant(ctx.orgId, () => postingEngine.postDraftJournal({
    orgId: ctx.orgId, journalId: draft.journalId, actorUserId: ctx.userId, idempotencyKey: postKey,
  }));
  expect(first.status).toBe('posted');
  expect(second.status).toBe('posted');
  expect(second.idempotent).toBe(true);

  const rows = await runWithTenant(ctx.orgId, () => pool.query(
    `SELECT COUNT(*)::int AS count FROM accounting_posting_requests WHERE organization_id=$1 AND idempotency_key=$2`,
    [ctx.orgId, postKey]
  ));
  expect(rows.rows[0].count).toBe(1);
});

test('new posted journals carry immutable accounting policy provenance', async () => {
  const key = `phase2-prov-${suffix()}`;
  const created = await auth(request(app).post('/core/accounting/journals'), ctx)
    .set('Idempotency-Key', key)
    .send({
      periodId: ctx.periodId,
      entryDate: ctx.entryDate,
      memo: 'Phase 2 provenance',
      typeCode: 'GENERAL',
      idempotencyKey: key,
      lines: [
        { accountId: ctx.cashAccountId, debit: '25.00' },
        { accountId: ctx.revenueAccountId, credit: '25.00' },
      ],
    });
  expect(created.status).toBe(201);
  const postKey = `phase2-post-${suffix()}`;
  const posted = await auth(request(app).post(`/core/accounting/journals/${created.body.journalId}/post`), ctx)
    .set('Idempotency-Key', postKey).send({});
  expect(posted.status).toBe(200);

  const provenance = await pool.query(
    `SELECT p.posting_fingerprint, p.accounting_policy_version_id
       FROM journal_posting_provenance p
      WHERE p.organization_id=$1 AND p.journal_entry_id=$2`,
    [ctx.orgId, created.body.journalId]
  );
  expect(provenance.rows).toHaveLength(1);
  expect(provenance.rows[0].posting_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(provenance.rows[0].accounting_policy_version_id).toBeTruthy();

  await expect(runWithTenant(ctx.orgId, () => pool.query(
    `UPDATE journal_posting_provenance SET source_action='tampered' WHERE organization_id=$1 AND journal_entry_id=$2`,
    [ctx.orgId, created.body.journalId]
  ))).rejects.toThrow();
});

test('financial integrity runner finds no journal-balance or projection drift in clean fixture', async () => {
  const key = `phase2-integrity-${suffix()}`;
  const response = await auth(request(app).post('/core/accounting/integrity/run'), ctx)
    .set('Idempotency-Key', key)
    .send({ periodId: ctx.periodId });
  expect(response.status).toBe(200);
  const findings = response.body?.data?.findings || [];
  expect(findings.filter((f) => ['posted_journal_balance','ledger_projection_matches_journals'].includes(f.checkCode))).toHaveLength(0);
});
