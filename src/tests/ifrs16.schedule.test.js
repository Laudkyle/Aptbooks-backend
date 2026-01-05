const request = require("supertest");
const app = require("../app");
const { pool } = require("../db/pool");

let token;
let orgId;
let periodId;
let postableAccountIds;

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

  const p = await request(app)
    .post("/core/accounting/periods")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "TEST-IFRS16-P1", startDate: "2026-01-01", endDate: "2026-01-31" });
  periodId = p.body.id;

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
  postableAccountIds = rows.map(r => r.id);
});

afterAll(async () => {
  await pool.end();
});

test("IFRS16: create forces draft and quarterly schedule uses payments_per_year", async () => {
  const ids = postableAccountIds;
  expect(ids.length).toBeGreaterThanOrEqual(2);
  const pick = (i) => ids[i % ids.length];

  const create = await request(app)
    .post("/compliance/ifrs16/leases")
    .set("Authorization", `Bearer ${token}`)
    .send({
      code: "L-IFRS16-Q1",
      name: "Quarterly lease test",
      commencement_date: "2026-01-01",
      term_months: 12,
      payment_amount: 1000,
      payments_per_year: 4,
      annual_discount_rate: 0.12,
      payment_timing: "arrears",

      // Even if provided, the backend enforces draft on create.
      status: "active",

      rou_asset_account_id: pick(0),
      lease_liability_account_id: pick(1),
      interest_expense_account_id: pick(2),
      depreciation_expense_account_id: pick(3),
      accumulated_depreciation_account_id: pick(4),
      cash_account_id: pick(5),
    });

  expect(create.status).toBe(201);
  expect(create.body.status).toBe("draft");
  const leaseId = create.body.id;

  const gen = await request(app)
    .post(`/compliance/ifrs16/leases/${leaseId}/schedule/generate`)
    .set("Authorization", `Bearer ${token}`)
    .send({ replace: true });

  expect(gen.status).toBe(200);
  expect(gen.body.lines_created).toBe(4);

  const sched = await request(app)
    .get(`/compliance/ifrs16/leases/${leaseId}/schedule`)
    .set("Authorization", `Bearer ${token}`);

  expect(sched.status).toBe(200);
  expect(sched.body.lines.length).toBe(4);

  const dueDates = sched.body.lines.map(l => l.due_date);
  expect(dueDates).toEqual(["2026-04-01", "2026-07-01", "2026-10-01", "2027-01-01"]);

  const last = sched.body.lines[sched.body.lines.length - 1];
  expect(Math.abs(Number(last.closing_balance))).toBeLessThan(0.000001);

  // Depreciation residual is allocated to final period so sum matches initial liability (within tolerance)
  const totalDep = sched.body.lines.reduce((s, l) => s + Number(l.depreciation_amount), 0);
  const init = Number(gen.body.precise_liability);
  expect(Math.abs(totalDep - init)).toBeLessThan(0.0001);
});
