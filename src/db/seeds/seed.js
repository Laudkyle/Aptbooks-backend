const bcrypt = require("bcrypt");
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

    // Permissions (global) - Phase 1 complete set
    const perms = [
      // Accounting kernel
      ["accounting.period.read", "Read periods"],
      ["accounting.period.manage", "Create/reopen periods"],
      ["accounting.period.close", "Close periods"],
      ["accounting.coa.read", "Read chart of accounts"],
      ["accounting.coa.manage", "Manage chart of accounts"],
      ["accounting.journal.create", "Create draft journals"],
      ["accounting.journal.post", "Post journals"],
      ["accounting.journal.void", "Void posted journals"],
      ["accounting.journal.read", "Read journals"],
      ["accounting.balances.read", "Read balances and reports"],

      // RBAC + administration (Tier 0)
      ["rbac.permissions.read", "Read permissions"],
      ["rbac.roles.read", "Read roles"],
      ["rbac.roles.manage", "Manage roles and role permissions"],
      ["users.read", "Read users"],
      ["users.manage", "Create/disable users"],
      ["settings.read", "Read system settings"],
      ["settings.manage", "Manage system settings"],

      ["partners.read", "Read business partners"],
      ["partners.manage", "Manage business partners"],

      ["transactions.invoice.read", "Read invoices"],
      ["transactions.invoice.manage", "Create draft invoices"],
      ["transactions.invoice.issue", "Issue invoices (post journals)"],
      ["transactions.invoice.void", "Void invoices (reversal)"],
    ];

    for (const [code, description] of perms) {
      await client.query(
        `INSERT INTO permissions(code, description) VALUES($1,$2) ON CONFLICT (code) DO NOTHING`,
        [code, description]
      );
    }

    // Organization (GHS base) - idempotent by name
    const orgName = "AptBooks Demo Org";
    const { rows: existingOrg } = await client.query(
      `SELECT id FROM organizations WHERE name=$1 LIMIT 1`,
      [orgName]
    );

    let orgId;
    if (existingOrg.length) {
      orgId = existingOrg[0].id;
    } else {
      const { rows: orgRows } = await client.query(
        `INSERT INTO organizations(name, base_currency_code) VALUES ($1,'GHS') RETURNING id`,
        [orgName]
      );
      orgId = orgRows[0].id;
    }

    // Admin role - idempotent by (org, name)
    const { rows: existingRole } = await client.query(
      `SELECT id FROM roles WHERE organization_id=$1 AND name='Admin' LIMIT 1`,
      [orgId]
    );

    let roleId;
    if (existingRole.length) {
      roleId = existingRole[0].id;
    } else {
      const { rows: roleRows } = await client.query(
        `INSERT INTO roles(organization_id, name) VALUES ($1,'Admin') RETURNING id`,
        [orgId]
      );
      roleId = roleRows[0].id;
    }

    // Attach ALL permissions to Admin (idempotent)
    await client.query(
      `
      INSERT INTO role_permissions(role_id, permission_id)
      SELECT $1, p.id FROM permissions p
      ON CONFLICT DO NOTHING
      `,
      [roleId]
    );

    // Admin user - global email unique, so make idempotent by email
    const adminEmail = "admin@aptbooks.local";

    const { rows: existingUser } = await client.query(
      `SELECT id FROM users WHERE email=$1 LIMIT 1`,
      [adminEmail]
    );

    let userId;
    if (existingUser.length) {
      userId = existingUser[0].id;
    } else {
      const passwordHash = await bcrypt.hash("ChangeMe123!", env.BCRYPT_ROUNDS);

      const { rows: userRows } = await client.query(
        `INSERT INTO users(organization_id, email, password_hash) VALUES ($1,$2,$3) RETURNING id`,
        [orgId, adminEmail, passwordHash]
      );
      userId = userRows[0].id;
    }

    // Link user to Admin role
    await client.query(
      `INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, roleId]
    );

    // Minimal COA skeleton (so tests + demo flows work)
    const { rows: types } = await client.query(
      `SELECT code, id FROM account_types`
    );
    const typeMap = Object.fromEntries(types.map((r) => [r.code, r.id]));

    const coa = [
      ["1000", "Cash", typeMap.ASSET],
      ["1100", "Accounts Receivable", typeMap.ASSET],
      ["2000", "Accounts Payable", typeMap.LIABILITY],
      ["3000", "Owner's Equity", typeMap.EQUITY],
      ["4000", "Sales Revenue", typeMap.REVENUE],
      ["5000", "Operating Expenses", typeMap.EXPENSE],
    ];

    for (const [code, name, accountTypeId] of coa) {
      await client.query(
        `
        INSERT INTO chart_of_accounts(organization_id, code, name, account_type_id, is_postable, status)
        VALUES ($1,$2,$3,$4,true,'active')
        ON CONFLICT (organization_id, code) DO NOTHING
        `,
        [orgId, code, name, accountTypeId]
      );
    }

    await client.query("COMMIT");
    console.log("Seed complete:", {
      orgId,
      adminEmail,
      adminPassword: existingUser.length ? "(unchanged)" : "ChangeMe123!",
    });
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
