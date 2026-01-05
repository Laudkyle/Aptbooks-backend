const request = require("supertest");
const app = require("../app");
const { pool } = require("../db/pool");

let token;
let orgId;
let p1;
let p2;
let accounts;
let customerBpId;

beforeAll(async () => {
  const login = await request(app).post("/auth/login").send({
    email: "admin@aptbooks.local",
    password: "ChangeMe123!"
  });
  token = login.body.accessToken;

  const orgRes = await request(app)
    .get("/core/organizations/me")
    .set("Authorization", `Bearer ${token}`);
  orgId = orgRes.body.id;

  // Create two half-year periods to validate schedule splitting.
  const r1 = await request(app)
    .post("/core/accounting/periods")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "TEST-IFRS15-H1", startDate: "2026-01-01", endDate: "2026-06-30" });
  p1 = r1.body.id;

  const r2 = await request(app)
    .post("/core/accounting/periods")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "TEST-IFRS15-H2", startDate: "2026-07-01", endDate: "2026-12-31" });
  p2 = r2.body.id;

  const { rows } = await pool.query(
    `
    SELECT id
    FROM chart_of_accounts
    WHERE organization_id=$1 AND status='active' AND is_postable=true
    ORDER BY code ASC
    LIMIT 10
    `,
    [orgId]
  );
  accounts = rows.map(r => r.id);

  const bp = await pool.query(`SELECT id FROM business_partners WHERE organization_id=$1 AND type='customer' AND status='active' ORDER BY created_at ASC LIMIT 1`, [orgId]);
  customerBpId = bp.rows[0]?.id;
  if (!customerBpId) throw new Error("No customer business_partner found for tests");
});

afterAll(async () => {
  await pool.end();
});

test("IFRS15 Stage 1: contract -> obligations -> activate (upfront bill) -> schedule -> post revenue per period", async () => {
  expect(accounts.length).toBeGreaterThanOrEqual(4);
  const revenue = accounts[0];
  const contractAsset = accounts[1];
  const contractLiability = accounts[2];
  const billingAcct = accounts[3];

  // Settings
  const set = await request(app)
    .put("/compliance/ifrs15/settings")
    .set("Authorization", `Bearer ${token}`)
    .send({
      revenue_account_id: revenue,
      contract_asset_account_id: contractAsset,
      contract_liability_account_id: contractLiability,
      default_billing_account_id: billingAcct,
      rounding_decimals: 2,
    });
  expect(set.status).toBe(200);

  // Create contract
  const c = await request(app)
    .post("/compliance/ifrs15/contracts")
    .set("Authorization", `Bearer ${token}`)
    .send({
      code: "C-IFRS15-001",
      business_partner_id: customerBpId,
      contract_date: "2026-01-01",
      transaction_price: 12000,
      billing_policy: "UPFRONT",
      billing_account_id: billingAcct,
      start_date: "2026-01-01",
      end_date: "2026-12-31"
    });
  expect(c.status).toBe(201);
  const contractId = c.body.id;

  // Add 2 obligations with equal SSP so allocation should split 50/50.
  const o1 = await request(app)
    .post(`/compliance/ifrs15/contracts/${contractId}/obligations`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      description: "Subscription service",
      obligation_type: "OVER_TIME",
      satisfaction_method: "TIME",
      standalone_selling_price: 10000,
      start_date: "2026-01-01",
      end_date: "2026-12-31"
    });
  expect(o1.status).toBe(201);

  const o2 = await request(app)
    .post(`/compliance/ifrs15/contracts/${contractId}/obligations`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      description: "Setup service",
      obligation_type: "POINT_IN_TIME",
      standalone_selling_price: 10000,
      satisfaction_date: "2026-01-15"
    });
  expect(o2.status).toBe(201);

  // Activate (allocations + upfront billing posting)
  const act = await request(app)
    .post(`/compliance/ifrs15/contracts/${contractId}/activate`)
    .set("Authorization", `Bearer ${token}`)
    .send({ entry_date: "2026-01-01" });
  expect(act.status).toBe(200);
  expect(act.body.status).toBe("active");

  // Generate schedule
  const gen = await request(app)
    .post(`/compliance/ifrs15/contracts/${contractId}/schedule/generate`)
    .set("Authorization", `Bearer ${token}`)
    .send({ replace: true });
  expect(gen.status).toBe(200);
  expect(gen.body.lines_created).toBeGreaterThanOrEqual(2);

  const sched = await request(app)
    .get(`/compliance/ifrs15/contracts/${contractId}/schedule`)
    .set("Authorization", `Bearer ${token}`);
  expect(sched.status).toBe(200);

  // Expect at least one line in H1 and at least one line overall
  const h1 = sched.body.lines.filter(l => l.period_id === p1);
  expect(h1.length).toBeGreaterThanOrEqual(1);

  // Post H1
  const post1 = await request(app)
    .post(`/compliance/ifrs15/contracts/${contractId}/post`)
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: p1, entry_date: "2026-06-30" });
  expect(post1.status).toBe(200);
  expect(Number(post1.body.recognized_amount)).toBeGreaterThan(0);

  // Post H2
  const post2 = await request(app)
    .post(`/compliance/ifrs15/contracts/${contractId}/post`)
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: p2, entry_date: "2026-12-31" });
  expect(post2.status).toBe(200);
  expect(Number(post2.body.recognized_amount)).toBeGreaterThan(0);

  // Posting twice should be idempotent/409 (nothing to post) depending on idempotency hit.
  const postAgain = await request(app)
    .post(`/compliance/ifrs15/contracts/${contractId}/post`)
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: p2, entry_date: "2026-12-31" });
  expect([200, 409]).toContain(postAgain.status);
});