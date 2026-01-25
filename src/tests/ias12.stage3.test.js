const request = require("supertest"); 
const app = require("../app"); 
const { pool } = require("../db/pool"); 

let token; 
let orgId; 
let periodId; 
let rateSetId; 
let authorityId; 

beforeAll(async () => {
  const login = await request(app).post("/auth/login").send({
    email: "admin@aptbooks.local",
    password: "ChangeMe123!",
  }); 
  token = login.body.accessToken; 

  const seed = await pool.query(`SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1`); 
  orgId = seed.rows[0].id; 

  const period = await pool.query(
    `SELECT id FROM accounting_periods WHERE organization_id=$1 AND status='open' ORDER BY start_date ASC LIMIT 1`,
    [orgId]
  ); 
  periodId = period.rows[0].id; 

  // Create authority + rate set + line
  const auth = await request(app)
    .post("/compliance/ias12/authorities")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "GRA", name: "Ghana Revenue Authority", country_code: "GH", status: "active" }); 
  authorityId = auth.body.id; 

  const rs = await request(app)
    .post("/compliance/ias12/rate-sets")
    .set("Authorization", `Bearer ${token}`)
    .send({ authority_id: authorityId, code: "CORP", name: "Corporate Tax", status: "active" }); 
  rateSetId = rs.body.id; 

  // Rate line covering wide range
  await request(app)
    .post(`/compliance/ias12/rate-sets/${rateSetId}/lines`)
    .set("Authorization", `Bearer ${token}`)
    .send({ effective_from: "2020-01-01", effective_to: null, rate: 0.25 }); 

  // Upsert IAS12 settings default rate set (accounts can be null for compute)
  await request(app)
    .put("/compliance/ias12/settings")
    .set("Authorization", `Bearer ${token}`)
    .send({ default_authority_id: authorityId, default_rate_set_id: rateSetId, rounding_decimals: 2 }); 
}); 

afterAll(async () => {
  await pool.end(); 
}); 

test("imports temp differences and produces roll-forward + category breakdown reports", async () => {
  // Create category
  const cat = await request(app)
    .post("/compliance/ias12/temp-difference-categories")
    .set("Authorization", `Bearer ${token}`)
    .send({ code: "PPE", name: "PPE timing difference", status: "active" }); 

  // Import two temp differences
  const imp = await request(app)
    .post("/compliance/ias12/temp-differences/import")
    .set("Authorization", `Bearer ${token}`)
    .send({
      period_id: periodId,
      source: "test",
      rows: [
        { category_id: cat.body.id, diff_type: "TAXABLE", carrying_amount: 1000, tax_base: 700, recognisable: true },
        { category_id: cat.body.id, diff_type: "DEDUCTIBLE", carrying_amount: 200, tax_base: 400, recognisable: true },
      ],
    }); 
  expect(imp.status).toBe(201); 

  // Compute
  const compute = await request(app)
    .post("/compliance/ias12/deferred-tax/compute")
    .set("Authorization", `Bearer ${token}`)
    .send({ period_id: periodId, rate_set_id: rateSetId, memo: "test compute" }); 
  expect(compute.status).toBe(201); 

  // Roll-forward report
  const roll = await request(app)
    .get(`/compliance/ias12/reports/roll-forward?period_id=${periodId}`)
    .set("Authorization", `Bearer ${token}`); 
  expect(roll.status).toBe(200); 
  expect(roll.body).toHaveProperty("closing_dta"); 
  expect(roll.body).toHaveProperty("closing_dtl"); 

  // Category breakdown
  const byCat = await request(app)
    .get(`/compliance/ias12/reports/by-category?period_id=${periodId}`)
    .set("Authorization", `Bearer ${token}`); 
  expect(byCat.status).toBe(200); 
  expect(Array.isArray(byCat.body.categories)).toBe(true); 
}); 
