const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../../../db/pool");
const { env } = require("../../../config/env");
const { AppError } = require("../../../shared/errors/AppError");

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw new AppError(400, "Email and password required");

    const { rows } = await pool.query(
      `SELECT id, organization_id, email, password_hash, status FROM users WHERE email=$1`,
      [email]
    );
    if (!rows.length) throw new AppError(401, "Invalid credentials");
    const u = rows[0];
    if (u.status !== "active") throw new AppError(403, "User disabled");

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) throw new AppError(401, "Invalid credentials");

    const token = jwt.sign(
      { id: u.id, organization_id: u.organization_id, email: u.email },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    res.json({ accessToken: token });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
