const router = require("express").Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw new AppError(400, "email and password required");

    const { rows } = await pool.query(
      `SELECT id, organization_id, password_hash, status FROM users WHERE email=$1`,
      [email]
    );
    if (!rows.length || rows[0].status !== "active") {
      throw new AppError(401, "Invalid credentials");
    }

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) throw new AppError(401, "Invalid credentials");

    const token = jwt.sign(
      { id: rows[0].id, organization_id: rows[0].organization_id, email },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    res.json({ accessToken: token });
  } catch (e) { next(e); }
});

module.exports = router;
