const bcrypt = require("bcrypt");
const { pool } = require("../pool");
const { env } = require("../../config/env");

async function run() {
  const client = await pool.connect();

  // Helpers
  const upsertPermission = async (code, description) => {
    await client.query(
      `INSERT INTO permissions(code, description) VALUES($1,$2) ON CONFLICT (code) DO NOTHING`,
      [code, description]
    );
  };

  const getOrCreateOrg = async (name, baseCurrencyCode = "GHS") => {
    const { rows: existing } = await client.query(
      `SELECT id FROM organizations WHERE name=$1 LIMIT 1`,
      [name]
    );
    if (existing.length) return existing[0].id;

    const { rows } = await client.query(
      `INSERT INTO organizations(name, base_currency_code) VALUES ($1,$2) RETURNING id`,
      [name, baseCurrencyCode]
    );
    return rows[0].id;
  };

  const getOrCreateRole = async (orgId, name) => {
    const { rows: existing } = await client.query(
      `SELECT id FROM roles WHERE organization_id=$1 AND name=$2 LIMIT 1`,
      [orgId, name]
    );
    if (existing.length) return existing[0].id;

    const { rows } = await client.query(
      `INSERT INTO roles(organization_id, name) VALUES ($1,$2) RETURNING id`,
      [orgId, name]
    );
    return rows[0].id;
  };

  const getOrCreateUserByEmail = async (orgId, email, passwordPlain) => {
    const { rows: existing } = await client.query(
      `SELECT id FROM users WHERE email=$1 LIMIT 1`,
      [email]
    );
    if (existing.length) return { id: existing[0].id, created: false };

    const passwordHash = await bcrypt.hash(passwordPlain, env.BCRYPT_ROUNDS);

    const { rows } = await client.query(
      `INSERT INTO users(organization_id, email, password_hash, status)
       VALUES ($1,$2,$3,'active')
       RETURNING id`,
      [orgId, email, passwordHash]
    );
    return { id: rows[0].id, created: true };
  };

  const getAccountTypeMap = async () => {
    const { rows } = await client.query(`SELECT code, id FROM account_types`);
    return Object.fromEntries(rows.map((r) => [r.code, r.id]));
  };

  const getCoaIdByCode = async (orgId, code) => {
    const { rows } = await client.query(
      `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND code=$2 LIMIT 1`,
      [orgId, code]
    );
    return rows.length ? rows[0].id : null;
  };

  async function ensureOpenPeriod(orgId) {
    // 1) If there's already an OPEN period covering today, use it
    const { rows: covering } = await client.query(
      `
    SELECT id FROM accounting_periods
    WHERE organization_id=$1
      AND start_date <= CURRENT_DATE
      AND end_date >= CURRENT_DATE
      AND status='open'
    LIMIT 1
    `,
      [orgId]
    );
    if (covering.length) return covering[0].id;

    // 2) Otherwise, create a long open period for testing (idempotent by code)
    const code = "TEST-OPEN";
    const start = "2025-01-01";
    const end = "2027-12-31";

    // Insert (or no-op if already exists)
    await client.query(
      `
    INSERT INTO accounting_periods(organization_id, code, start_date, end_date, status)
    VALUES ($1,$2,$3,$4,'open')
    ON CONFLICT (organization_id, code) DO NOTHING
    `,
      [orgId, code, start, end]
    );

    // Ensure it is open and covers the range (in case it existed but was closed/short)
    const { rows } = await client.query(
      `
    UPDATE accounting_periods
    SET start_date = LEAST(start_date, $3),
        end_date   = GREATEST(end_date, $4),
        status     = 'open',
        updated_at = NOW()
    WHERE organization_id=$1 AND code=$2
    RETURNING id
    `,
      [orgId, code, start, end]
    );

    return rows[0].id;
  }

  const ensurePaymentConfig = async (orgId) => {
    // Payment terms
    const terms = [
      { name: "Due on Receipt", netDays: 0, isDefault: true },
      { name: "Net 15", netDays: 15, isDefault: false },
      { name: "Net 30", netDays: 30, isDefault: false },
    ];

    for (const t of terms) {
      await client.query(
        `
    INSERT INTO payment_terms(organization_id, name, net_days, is_default, status)
    VALUES ($1,$2,$3,$4,'active')
    ON CONFLICT (organization_id, name) DO NOTHING
    `,
        [orgId, t.name, t.netDays, t.isDefault]
      );
    }

    // Ensure exactly one default term
    await client.query(
      `
  UPDATE payment_terms
  SET is_default = CASE WHEN name='Due on Receipt' THEN TRUE ELSE FALSE END
  WHERE organization_id=$1
  `,
      [orgId]
    );

  // Payment methods
const methods = [
  { code: "CASH", name: "Cash" },
  { code: "BANK", name: "Bank Transfer" },
  { code: "MOMO", name: "Mobile Money" },
  { code: "CHEQUE", name: "Cheque" }
];

for (const m of methods) {
  await client.query(
    `
    INSERT INTO payment_methods(
      organization_id,
      code,
      name,
      status
    )
    VALUES ($1,$2,$3,'active')
    ON CONFLICT (organization_id, code) DO NOTHING
    `,
    [orgId, m.code, m.name]
  );
}

  };

  const ensureDemoCustomer = async ({ orgId, arAccountId }) => {
    const name = "Demo Customer Ltd";
    const code = "CUST-DEMO";

    const { rows: existing } = await client.query(
      `
      SELECT id FROM business_partners
      WHERE organization_id=$1 AND code=$2
      LIMIT 1
      `,
      [orgId, code]
    );

    let partnerId;
    if (existing.length) {
      partnerId = existing[0].id;
      // Ensure AR is set for invoices
      await client.query(
        `
        UPDATE business_partners
        SET default_receivable_account_id = COALESCE(default_receivable_account_id, $3),
            status='active',
            updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        `,
        [orgId, partnerId, arAccountId]
      );
    } else {
      const { rows } = await client.query(
        `
        INSERT INTO business_partners(
          organization_id, type, name, code, email, phone, status,
          default_receivable_account_id
        )
        VALUES ($1,'customer',$2,$3,$4,$5,'active',$6)
        RETURNING id
        `,
        [
          orgId,
          name,
          code,
          "demo.customer@aptbooks.local",
          "+233200000001",
          arAccountId,
        ]
      );
      partnerId = rows[0].id;
    }

    // Optional: primary contact
    await client.query(
      `
      INSERT INTO business_partner_contacts(
        organization_id, partner_id, name, email, phone, role, is_primary
      )
      VALUES ($1,$2,'Accounts Contact','accounts@demo.local','+233200000002','Accounts',TRUE)
      ON CONFLICT DO NOTHING
      `,
      [orgId, partnerId]
    );

    // Optional: primary address
    await client.query(
      `
      INSERT INTO business_partner_addresses(
        organization_id, partner_id, label, line1, city, region, country, is_primary
      )
      VALUES ($1,$2,'Head Office','123 Oxford Street','Accra','Greater Accra','Ghana',TRUE)
      ON CONFLICT DO NOTHING
      `,
      [orgId, partnerId]
    );

    return partnerId;
  };

  try {
    await client.query("BEGIN");

    // 1) Global reference tables
    await client.query(`
      INSERT INTO account_types(code, name, normal_balance) VALUES
      ('ASSET','Assets','debit'),
      ('LIABILITY','Liabilities','credit'),
      ('EQUITY','Equity','credit'),
      ('REVENUE','Revenue','credit'),
      ('EXPENSE','Expenses','debit')
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO journal_entry_types(code, name) VALUES
      ('GENERAL','General Journal'),
      ('ADJUSTMENT','Adjustment Journal'),
      ('CLOSING','Closing Journal')
      ON CONFLICT (code) DO NOTHING;
    `);

    // 2) Permissions (Phase 1 + Phase 2)
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

      // Tier 2
      ["partners.read", "Read business partners"],
      ["partners.manage", "Manage business partners"],

      // Tier 3 (Invoices)
      ["transactions.invoice.read", "Read invoices"],
      ["transactions.invoice.manage", "Create draft invoices"],
      ["transactions.invoice.issue", "Issue invoices (post journals)"],
      ["transactions.invoice.void", "Void invoices (reversal)"],
    ];

    for (const [code, description] of perms) {
      await upsertPermission(code, description);
    }

    // 3) Org + Admin role/user
    const orgId = await getOrCreateOrg("AptBooks Demo Org", "GHS");
    const roleId = await getOrCreateRole(orgId, "Admin");

    // Attach ALL permissions to Admin (idempotent)
    await client.query(
      `
      INSERT INTO role_permissions(role_id, permission_id)
      SELECT $1, p.id FROM permissions p
      ON CONFLICT DO NOTHING
      `,
      [roleId]
    );

    const adminEmail = "admin@aptbooks.local";
    const adminPassword = "ChangeMe123!";
    const user = await getOrCreateUserByEmail(orgId, adminEmail, adminPassword);

    await client.query(
      `INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [user.id, roleId]
    );

    // 4) Minimal COA skeleton
    const typeMap = await getAccountTypeMap();

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

    // 5) Ensure open period for invoice issue tests
    const periodId = await ensureOpenPeriod(orgId);

    // 6) Payment config (Phase 2)
    await ensurePaymentConfig(orgId);

    // 7) Demo customer with A/R set
    const arAccountId = await getCoaIdByCode(orgId, "1100");
    if (!arAccountId) throw new Error("Missing A/R account 1100 in COA");

    const demoPartnerId = await ensureDemoCustomer({ orgId, arAccountId });

    await client.query("COMMIT");

    console.log("Seed complete:", {
      orgId,
      adminEmail,
      adminPassword: user.created ? adminPassword : "(unchanged)",
      openPeriodId: periodId,
      demoCustomerId: demoPartnerId,
      accounts: {
        arAccountId,
        revenueAccountId: await getCoaIdByCode(orgId, "4000"),
      },
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
