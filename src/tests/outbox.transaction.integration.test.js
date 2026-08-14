const { bootstrapTenant, destroyTenant, pool, suffix } = require('./helpers/accountingTestContext');
const { enqueueEvent, dispatchPending } = require('../modules/webhooks/webhooks.service');
let ctx;

beforeAll(async () => { ctx = await bootstrapTenant(); }, 120000);
afterAll(async () => { await destroyTenant(ctx); await pool.end(); });

test('outbox event rolls back with the surrounding accounting transaction', async () => {
  const eventType = `step3.rollback.${suffix()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await enqueueEvent({ client, orgId: ctx.orgId, eventType, payload: { journalId: 'test' } });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const found = await pool.query(`SELECT COUNT(*)::int AS n FROM webhook_outbox WHERE organization_id=$1 AND event_type=$2`, [ctx.orgId, eventType]);
  expect(found.rows[0].n).toBe(0);
});

test('concurrent dispatchers claim a pending outbox event only once', async () => {
  const eventType = `step3.claim.${suffix()}`;
  await enqueueEvent({ orgId: ctx.orgId, eventType, payload: { ok: true } });

  const [a, b] = await Promise.all([dispatchPending({ limit: 10 }), dispatchPending({ limit: 10 })]);
  expect(a.processed + b.processed).toBe(1);

  const row = await pool.query(`SELECT status, attempts FROM webhook_outbox WHERE organization_id=$1 AND event_type=$2`, [ctx.orgId, eventType]);
  expect(row.rows[0].status).toBe('sent');
  expect(Number(row.rows[0].attempts)).toBe(1);
});
