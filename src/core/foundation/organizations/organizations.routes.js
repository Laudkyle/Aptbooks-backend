const router = require("express").Router();
const { pool } = require("../../../db/pool");
const { authRequired } = require("../../../middleware/auth.middleware");
const { AppError } = require("../../../shared/errors/AppError");

router.post("/", async (req, res, next) => {
  try {
    // If you want org creation locked down, add an admin bootstrap rule later.
    const { name } = req.body || {};
    if (!name) throw new AppError(400, "name required");

    const { rows } = await pool.query(
      `INSERT INTO organizations(name, base_currency_code) VALUES ($1,'GHS') RETURNING *`,
      [name]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// Org-scoped reads should be authenticated
router.get("/me", authRequired, async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const { rows } = await pool.query(`SELECT * FROM organizations WHERE id=$1`, [orgId]);
    if (!rows.length) throw new AppError(404, "Org not found");
    res.json(rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
