const request = require("supertest");
const app = require("../src/app");
const { pool } = require("../src/db/pool");

let token;
let orgId;
let periodId;
let cashAccountId;
let revenueAccountId;

beforeAll(async () => {
  // login (seeded admin)
  const login = await request(app).post("/auth/login").send({
    email: "admin@aptbooks.local",
    password: "ChangeMe123!"
  });
  token = login.body.accessToken;

  // org
  const orgRes = await request(app)
    .get("/core/organizations/me")
    .set("Authorization", `Bearer ${token}`);
  orgId = orgRes.body.id;

  // create period
  const p = await request(app)
    .post("/core/accounting/periods")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "TEST-P1", startDate: "2026-01-01", endDate: "2026-01-31" });

  periodId = p.body.id;

  // load accounts from seed
  const { rows: cash } = await pool.query(
    `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND code='1000'`,
    [orgId]
  );
  const { rows: rev } = await pool.query(
    `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND code='4000'`,
    [orgId]
  );
  cashAccountId = cash[0].id;
  revenueAccountId = rev[0].id;
});

afterAll(async () => {
  await pool.end();
});

test("rejects unbalanced journal", async () => {
  const res = await request(app)
    .post("/core/accounting/journals")
    .set("Authorization", `Bearer ${token}`)
    .send({
      periodId,
      entryDate: "2026-01-10",
      typeCode: "GENERAL",
      lines: [
        { accountId: cashAccountId, debit: 100 },
        { accountId: revenueAccountId, credit: 90 }
      ]
    });
  expect(res.status).toBe(400);
});

test("posts balanced journal and updates trial balance", async () => {
  const create = await request(app)
    .post("/core/accounting/journals")
    .set("Authorization", `Bearer ${token}`)
    .send({
      periodId,
      entryDate: "2026-01-11",
      typeCode: "GENERAL",
      idempotencyKey: "abc-123",
      lines: [
        { accountId: cashAccountId, debit: 100 },
        { accountId: revenueAccountId, credit: 100 }
      ]
    });

  expect(create.status).toBe(201);
  const journalId = create.body.journalId;

  const post = await request(app)
    .post(`/core/accounting/journals/${journalId}/post`)
    .set("Authorization", `Bearer ${token}`)
    .send({});
  expect(post.status).toBe(200);

  const tb = await request(app)
    .get(`/core/accounting/balances/trial-balance?periodId=${periodId}`)
    .set("Authorization", `Bearer ${token}`);
  expect(tb.status).toBe(200);

  const cash = tb.body.find(r => r.code === "1000");
  const rev = tb.body.find(r => r.code === "4000");

  expect(Number(cash.debit_total)).toBeGreaterThanOrEqual(100);
  expect(Number(rev.credit_total)).toBeGreaterThanOrEqual(100);
});

test("idempotency returns existing journal", async () => {
  const create1 = await request(app)
    .post("/core/accounting/journals")
    .set("Authorization", `Bearer ${token}`)
    .send({
      periodId,
      entryDate: "2026-01-12",
      idempotencyKey: "same-key",
      lines: [
        { accountId: cashAccountId, debit: 10 },
        { accountId: revenueAccountId, credit: 10 }
      ]
    });
  const create2 = await request(app)
    .post("/core/accounting/journals")
    .set("Authorization", `Bearer ${token}`)
    .send({
      periodId,
      entryDate: "2026-01-12",
      idempotencyKey: "same-key",
      lines: [
        { accountId: cashAccountId, debit: 10 },
        { accountId: revenueAccountId, credit: 10 }
      ]
    });

  expect(create1.body.journalId).toBe(create2.body.journalId);
  expect(create2.body.idempotent).toBe(true);
});

test("closing period blocks posting", async () => {
  // close
  const close = await request(app)
    .post(`/core/accounting/periods/${periodId}/close`)
    .set("Authorization", `Bearer ${token}`)
    .send({});
  expect(close.status).toBe(200);

  // create draft in closed period should fail
  const res = await request(app)
    .post("/core/accounting/journals")
    .set("Authorization", `Bearer ${token}`)
    .send({
      periodId,
      entryDate: "2026-01-13",
      lines: [
        { accountId: cashAccountId, debit: 5 },
        { accountId: revenueAccountId, credit: 5 }
      ]
    });

  expect([409, 400]).toContain(res.status);
});
