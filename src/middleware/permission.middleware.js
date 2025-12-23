const { pool } = require("../db/pool");
const { AppError } = require("../shared/errors/AppError");

function requirePermission(permissionCode) {
  return async (req, _res, next) => {
    if (!req.user) return next(new AppError(401, "Unauthenticated"));
    const { id: userId, organization_id: orgId } = req.user;

    const { rows } = await pool.query(
      `
      SELECT 1
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id=$1 AND r.organization_id=$2 AND p.code=$3
      LIMIT 1
      `,
      [userId, orgId, permissionCode]
    );

    if (!rows.length) return next(new AppError(403, "Forbidden"));
    next();
  };
}

module.exports = { requirePermission };
