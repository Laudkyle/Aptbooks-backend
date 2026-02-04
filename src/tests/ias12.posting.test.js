const request = require("supertest");
const app = require("../app");
const { pool } = require("../db/pool");

let token;
let orgId;
let periodId;
let authorityId;
let rateSetId;
let dtaAccountId;
let dtlAccountId;
let dteAccountId;

async function pickAccount(orgId, prefixes) {
  for (const p of prefixes) {
    const { rows } = await pool.query(
      `
      SELECT id
      FROM chart_of_accounts
      WHERE organization_id=$1
        AND status='active'
        AND is_postable=TRUE
        AND code LIKE $2
      ORDER BY code ASC
      LIMIT 1
      `,
      [orgId, `${p}%`]
    );
    if (rows.length) return rows[0].id;
  }
  // fallback: any postable account
  const { rows } = await pool.query(
    `
    SELECT id
    FROM chart_of_accounts
    WHERE organization_id=$1 AND status='active' AND is_postable=TRUE
    ORDER BY code ASC
    LIMIT 1
    `,
    [orgId]
  );
  return rows[0]?.id;
}

beforeAll(async () => {
  const login = await request(app).post("/auth/login").send({
    email: "admin@aptbooks.local",
    password: "ChangeMe123!",
  });
  token = login.body.accessToken;

  const orgRes = await request(app)
    .get("/core/organizations/me")
    .set("Authorization", `Bearer ${token}`);
  orgId = orgRes.body.id;

  // Create a dedicated open period for this test to avoid collisions
  const p = await request(app)
    .post("/core/accounting/periods")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "IAS12-T1", startDate: "2026-02-01", endDate: "2026-02-28" });
  periodId = p.body.id;

  // Pick postable accounts from seeded COA
  dtaAccountId = await pickAccount(orgId, ["1", "15"]); // asset
  dtlAccountId = await pickAccount(orgId, ["2", "21"]); // liability
  dteAccountId = await pickAccount(orgId, ["5", "6", "4"]); // expense (fallback revenue)
  if (!dtaAccountId || !dtlAccountId || !dteAccountId) {
    throw new Error("Unable to resolve seeded postable accounts for IAS12 tests");
  }

  // Authority + rate set + line
  const auth = await request(app)
    .post("/compliance/ias12/authorities")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "GRA2", name: "Ghana Revenue Authority", country_code: "GH", status: "active" });
  authorityId = auth.body.id;

  const rs = await request(app)
    .post("/compliance/ias12/rate-sets")
    .set("Authorization", `Bearer ${token}`)
    .send({ authority_id: authorityId, code: "CORP2", name: "Corporate Tax", status: "active" });
  rateSetId = rs.body.id;

  await request(app)
    .post(`/compliance/ias12/rate-sets/${rateSetId}/lines`)
    .set("Authorization", `Bearer ${token}`)
    .send({ effective_from: "2020-01-01", effective_to: null, rate: 0.25 });

  // Configure IAS12 settings with posting accounts
  await request(app)
    .put("/compliance/ias12/settings")
    .set("Authorization", `Bearer ${token}`)
    .send({
      default_authority_id: authorityId,
      default_rate_set_id: rateSetId,
      rounding_decimals: 2,
      deferred_tax_asset_account_id: dtaAccountId,
      deferred_tax_liability_account_id: dtlAccountId,
      deferred_tax_expense_account_id: dteAccountId,
    });
});

afterAll(async () => {
  await pool.end();
});

test("compute -> finalize -> post -> idempotent post -> reverse -> recompute/post", async () => {
  // Create category
  const cat = await request(app)
    .post("/compliance/ias12/temp-difference-categories")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "PPE2", name: "PPE timing difference", status: "active" });
  expect(cat.status).toBe(201);

  // Create two temp differences
  const td1 = await request(app)
    .post("/compliance/ias12/temp-differences")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, category_id: cat.body.id, diff_type: "TAXABLE", carrying_amount: 1000, tax_base: 700, recognisable: true });
  expect(td1.status).toBe(201);

  const td2 = await request(app)
    .post("/compliance/ias12/temp-differences")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, category_id: cat.body.id, diff_type: "DEDUCTIBLE", carrying_amount: 200, tax_base: 400, recognisable: true });
  expect(td2.status).toBe(201);

  // Compute
  const compute = await request(app)
    .post("/compliance/ias12/deferred-tax/compute")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, rate_set_id: rateSetId, memo: "posting test" });
  expect(compute.status).toBe(201);
  const runId = compute.body.run_id;

  // Finalize
  const fin = await request(app)
    .post(`/compliance/ias12/deferred-tax/runs/${runId}/finalize`)
    .set("Authorization", `Bearer ${token}`)
    .send({});
  expect(fin.status).toBe(200);
  expect(fin.body.run_status).toBe("final");

  // Post
  const post1 = await request(app)
    .post("/compliance/ias12/deferred-tax/post")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, run_id: runId });
  expect(post1.status).toBe(200);
  expect(post1.body).toHaveProperty("journal_id");
  const postedJournalId = post1.body.journal_id;

  // Idempotent post should return same journal
  const post2 = await request(app)
    .post("/compliance/ias12/deferred-tax/post")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, run_id: runId });
  expect(post2.status).toBe(200);
  expect(post2.body.journal_id).toBe(postedJournalId);

  // Reverse
  const rev = await request(app)
    .post("/compliance/ias12/deferred-tax/reverse")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, reason: "test reversal" });
  expect(rev.status).toBe(200);
  expect(rev.body).toHaveProperty("reversal_journal_id");

  // Update a locked temp difference should supersede (create new active row)
  const upd = await request(app)
    .patch(`/compliance/ias12/temp-differences/${td1.body.id}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ carrying_amount: 1200 });
  expect(upd.status).toBe(200);
  expect(upd.body).toHaveProperty("id");

  // Recompute -> finalize -> post again
  const compute2 = await request(app)
    .post("/compliance/ias12/deferred-tax/compute")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, rate_set_id: rateSetId, memo: "posting test 2" });
  expect(compute2.status).toBe(201);
  const runId2 = compute2.body.run_id;

  const fin2 = await request(app)
    .post(`/compliance/ias12/deferred-tax/runs/${runId2}/finalize`)
    .set("Authorization", `Bearer ${token}`)
    .send({});
  expect(fin2.status).toBe(200);

  const post3 = await request(app)
    .post("/compliance/ias12/deferred-tax/post")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, run_id: runId2 });
  expect(post3.status).toBe(200);
  expect(post3.body).toHaveProperty("journal_id");
});
