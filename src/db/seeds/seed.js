const bcrypt = require("bcryptjs");
const { pool } = require("../pool");
const { env } = require("../../config/env");

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Account types (global)
    await client.query(`
      INSERT INTO account_types(code, name, normal_balance) VALUES
      ('ASSET','Assets','debit'),
      ('LIABILITY','Liabilities','credit'),
      ('EQUITY','Equity','credit'),
      ('REVENUE','Revenue','credit'),
      ('EXPENSE','Expenses','debit')
      ON CONFLICT (code) DO NOTHING;
    `);

    // Journal types (global)
    await client.query(`
      INSERT INTO journal_entry_types(code, name) VALUES
      ('GENERAL','General Journal'),
      ('ADJUSTMENT','Adjustment Journal'),
      ('CLOSING','Closing Journal')
      ON CONFLICT (code) DO NOTHING;
    `);

    // Permissions (global)
    const perms = [
      ["accounting.period.manage", "Create/reopen periods"],
      ["accounting.period.close", "Close periods"],
      ["accounting.coa.manage", "Manage chart of accounts"],
      ["accounting.journal.create", "Create draft journals"],
      ["accounting.journal.post", "Post journals"],
      ["accounting.journal.void", "Void posted journals"],
      ["accounting.journal.read", "Read journals"],
      ["accounting.balances.read", "Read balances and reports"]
    ];

    for (const [code, description] of perms) {
      await client.query(
        `INSERT INTO permissions(code, description) VALUES($1,$2) ON CONFLICT (code) DO NOTHING`,
        [code, description]
      );
    }

    // Organization (GHS base)
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations(name, base_currency_code) VALUES ($1,'GHS') RETURNING id`,
      ["AptBooks Demo Org"]
    );
    const orgId = orgRows[0].id;

    // Admin role
    const { rows: roleRows } = await client.query(
      `INSERT INTO roles(organization_id, name) VALUES ($1,'Admin') RETURNING id`,
      [orgId]
    );
    const roleId = roleRows[0].id;

    // Attach all permissions to Admin
    await client.query(
      `
      INSERT INTO role_permissions(role_id, permission_id)
      SELECT $1, p.id FROM permissions p
      ON CONFLICT DO NOTHING
      `,
      [roleId]
    );

    // Admin user (change password after first login)
    const passwordHash = await bcrypt.hash("ChangeMe123!", env.BCRYPT_ROUNDS);

    const { rows: userRows } = await client.query(
      `INSERT INTO users(organization_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id`,
      [orgId, "admin@aptbooks.local", passwordHash]
    );
    const userId = userRows[0].id;

    await client.query(
      `INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, roleId]
    );

    await client.query("COMMIT");
    console.log("Seed complete:", { orgId, adminEmail: "admin@aptbooks.local", adminPassword: "ChangeMe123!" });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
