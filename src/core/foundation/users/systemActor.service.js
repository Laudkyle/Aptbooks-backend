const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

const SYSTEM_EMAIL = "system@aptbooks.local";

async function ensureSystemUserForOrg({ orgId }) {
  // 1) Try by (orgId + is_system) first if you added the column; fallback to email.
  const { rows: existing } = await pool.query(
    `
    SELECT id, organization_id, email, status
    FROM users
    WHERE organization_id=$1
      AND (is_system=TRUE OR email=$2)
    ORDER BY is_system DESC, created_at ASC
    LIMIT 1
    `,
    [orgId, SYSTEM_EMAIL]
  );

  if (existing.length) {
    // Ensure active + ensure is_system is TRUE if the column exists
    await pool.query(
      `
      UPDATE users
      SET status='active',
          is_system=TRUE,
          updated_at=NOW()
      WHERE id=$1 AND organization_id=$2
      `,
      [existing[0].id, orgId]
    ).catch(() => {}); // if is_system doesn't exist, ignore
    return existing[0].id;
  }

  // 2) Create a system user for this org.
  // Password: not needed; ensure auth middleware doesn't allow login for is_system users (recommended).
  const { rows } = await pool.query(
    `
    INSERT INTO users (organization_id, email, password_hash, status, is_system)
    VALUES ($1, $2, $3, 'active', TRUE)
    RETURNING id
    `,
    [orgId, SYSTEM_EMAIL, ""] // password_hash empty because no login
  ).catch(async (e) => {
    // If is_system column doesn't exist, retry without it
    if (String(e.message || "").includes("is_system")) {
      const { rows: rows2 } = await pool.query(
        `
        INSERT INTO users (organization_id, email, password_hash, status)
        VALUES ($1, $2, $3, 'active')
        RETURNING id
        `,
        [orgId, SYSTEM_EMAIL, ""]
      );
      return rows2;
    }
    throw e;
  });

  return rows[0].id;
}

async function getSystemActorUserId({ orgId }) {
  const id = await ensureSystemUserForOrg({ orgId });
  if (!id) throw new AppError(500, "Failed to resolve system actor");
  return id;
}

module.exports = { getSystemActorUserId, ensureSystemUserForOrg };
