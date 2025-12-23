const router = require("express").Router();
const { authRequired } = require("../../../middleware/auth.middleware");
const { requirePermission } = require("../../../middleware/permission.middleware");
const { pool } = require("../../../db/pool");

router.use(authRequired);

router.get("/", requirePermission("rbac.permissions.read"), async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT code, description FROM permissions ORDER BY code`);
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
