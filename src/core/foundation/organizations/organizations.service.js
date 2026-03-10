const { pool } = require("../../../db/pool");
const bcrypt = require("bcrypt");
const { env } = require("../../../config/env");

/**
 * Initialize all defaults for a newly created organization
 * This should be called within a transaction after org creation
 * 
 * @param {Object} params
 * @param {Object} params.client - PostgreSQL client (for transaction)
 * @param {string} params.orgId - The newly created organization ID
 * @param {string} params.adminEmail - Email for the admin user
 * @param {string} params.adminPassword - Password for the admin user
 * @param {string} params.baseCurrencyCode - Base currency (default: GHS)
 */
async function initializeOrganizationDefaults({ 
  client, 
  orgId, 
  adminEmail, 
  adminPassword,
  baseCurrencyCode = "GHS" 
}) {
  console.log(`Initializing defaults for organization ${orgId}`);

  // Helper functions (same as in your seed script but using the passed client)
  const upsertPermission = async (code, description) => {
    await client.query(
      `INSERT INTO permissions(code, description) VALUES($1,$2) ON CONFLICT (code) DO NOTHING`,
      [code, description]
    );
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

  const createAdminUser = async (orgId, email, passwordPlain) => {
    const passwordHash = await bcrypt.hash(passwordPlain, env.BCRYPT_ROUNDS);
    const { rows } = await client.query(
      `INSERT INTO users(organization_id, email, password_hash, status)
       VALUES ($1,$2,$3,'active')
       RETURNING id`,
      [orgId, email, passwordHash]
    );
    return rows[0].id;
  };

  const getAccountTypeMap = async () => {
    const { rows } = await client.query(`SELECT code, id FROM account_types`);
    return Object.fromEntries(rows.map((r) => [r.code, r.id]));
  };

  const createCoaAccount = async (orgId, code, name, accountTypeId) => {
    await client.query(
      `
      INSERT INTO chart_of_accounts(organization_id, code, name, account_type_id, is_postable, status)
      VALUES ($1,$2,$3,$4,true,'active')
      ON CONFLICT (organization_id, code) DO NOTHING
      `,
      [orgId, code, name, accountTypeId]
    );
  };

  const getCoaIdByCode = async (orgId, code) => {
    const { rows } = await client.query(
      `SELECT id FROM chart_of_accounts WHERE organization_id=$1 AND code=$2 LIMIT 1`,
      [orgId, code]
    );
    return rows.length ? rows[0].id : null;
  };

 const ensureOpenPeriod = async (orgId) => {
  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 1;
  
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

  // 2) Check if there's already a period for this year
  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;
  
  const { rows: existingYearPeriod } = await client.query(
    `
    SELECT id FROM accounting_periods
    WHERE organization_id=$1 
      AND EXTRACT(YEAR FROM start_date) = $2
      AND EXTRACT(YEAR FROM end_date) = $2
    LIMIT 1
    `,
    [orgId, currentYear]
  );
  
  if (existingYearPeriod.length) {
    // Ensure it's open and covers the full year
    const { rows } = await client.query(
      `
      UPDATE accounting_periods
      SET start_date = LEAST(start_date, $2),
          end_date   = GREATEST(end_date, $3),
          status     = 'open',
          updated_at = NOW()
      WHERE organization_id=$1 AND id=$4
      RETURNING id
      `,
      [orgId, yearStart, yearEnd, existingYearPeriod[0].id]
    );
    return rows[0].id;
  }

  // 3) Create a new period for the current year
  const code = `${currentYear} Accounting Period`;
  
  const { rows } = await client.query(
    `
    INSERT INTO accounting_periods(organization_id, code, start_date, end_date, status)
    VALUES ($1, $2, $3, $4, 'open')
    ON CONFLICT (organization_id, code) DO UPDATE
      SET start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          status = 'open',
          updated_at = NOW()
    RETURNING id
    `,
    [orgId, code, yearStart, yearEnd]
  );

  return rows[0].id;
};
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
      { code: "CHEQUE", name: "Cheque" },
    ];

    for (const m of methods) {
      await client.query(
        `
        INSERT INTO payment_methods(organization_id, code, name, status)
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

    // Primary contact
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

    // Primary address
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

  const ensureDemoVendor = async ({ orgId, apAccountId }) => {
    const name = "Demo Vendor Ltd";
    const code = "VEND-DEMO";

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
      await client.query(
        `
        UPDATE business_partners
        SET default_payable_account_id = COALESCE(default_payable_account_id, $3),
            status='active',
            updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        `,
        [orgId, partnerId, apAccountId]
      );
    } else {
      const { rows } = await client.query(
        `
        INSERT INTO business_partners(
          organization_id, type, name, code, email, phone, status,
          default_payable_account_id
        )
        VALUES ($1,'vendor',$2,$3,$4,$5,'active',$6)
        RETURNING id
        `,
        [
          orgId,
          name,
          code,
          "demo.vendor@aptbooks.local",
          "+233200000010",
          apAccountId,
        ]
      );
      partnerId = rows[0].id;
    }

    // Primary contact
    await client.query(
      `
      INSERT INTO business_partner_contacts(
        organization_id, partner_id, name, email, phone, role, is_primary
      )
      VALUES ($1,$2,'Payables Contact','payables@demo.local','+233200000011','Payables',TRUE)
      ON CONFLICT DO NOTHING
      `,
      [orgId, partnerId]
    );

    // Primary address
    await client.query(
      `
      INSERT INTO business_partner_addresses(
        organization_id, partner_id, label, line1, city, region, country, is_primary
      )
      VALUES ($1,$2,'Head Office','456 Independence Ave','Accra','Greater Accra','Ghana',TRUE)
      ON CONFLICT DO NOTHING
      `,
      [orgId, partnerId]
    );

    return partnerId;
  };

  const upsertSystemSetting = async (orgId, key, valueJson) => {
    await client.query(
      `INSERT INTO system_settings(organization_id, key, value_json)
       VALUES($1,$2,$3)
       ON CONFLICT (organization_id, key) DO UPDATE SET value_json=EXCLUDED.value_json`,
      [orgId, key, valueJson]
    );
  };

  const ensureInventoryCostMethodDefault = async (orgId) => {
    await upsertSystemSetting(orgId, "inventoryCostMethod", { method: "WEIGHTED_VERAGE", locked: false });
  };

  const ensureInventoryMasterData = async ({
    orgId,
    inventoryAccountId,
    cogsAccountId,
    adjustmentAccountId,
    clearingAccountId,
  }) => {
    // Unit
    await client.query(
      `INSERT INTO item_units(organization_id, code, name)
       VALUES($1,'EA','Each')
       ON CONFLICT (organization_id, code) DO NOTHING`,
      [orgId]
    );
    const { rows: unitRows } = await client.query(
      `SELECT id FROM item_units WHERE organization_id=$1 AND code='EA' LIMIT 1`,
      [orgId]
    );
    const unitId = unitRows[0].id;

    // Warehouse
    await client.query(
      `INSERT INTO warehouses(organization_id, code, name, is_active)
       VALUES($1,'MAIN','Main Warehouse',TRUE)
       ON CONFLICT (organization_id, code) DO NOTHING`,
      [orgId]
    );
    const { rows: whRows } = await client.query(
      `SELECT id FROM warehouses WHERE organization_id=$1 AND code='MAIN' LIMIT 1`,
      [orgId]
    );
    const warehouseId = whRows[0].id;

    // Item category (with accounting links)
    await client.query(
      `INSERT INTO item_categories(
         organization_id, code, name,
         inventory_account_id, cogs_account_id, adjustment_account_id, clearing_account_id
       )
       VALUES($1,'GEN','General Items',$2,$3,$4,$5)
       ON CONFLICT (organization_id, code) DO UPDATE
         SET inventory_account_id=EXCLUDED.inventory_account_id,
             cogs_account_id=EXCLUDED.cogs_account_id,
             adjustment_account_id=EXCLUDED.adjustment_account_id,
             clearing_account_id=EXCLUDED.clearing_account_id`,
      [orgId, inventoryAccountId, cogsAccountId, adjustmentAccountId, clearingAccountId]
    );
    const { rows: catRows } = await client.query(
      `SELECT id FROM item_categories WHERE organization_id=$1 AND code='GEN' LIMIT 1`,
      [orgId]
    );
    const itemCategoryId = catRows[0].id;

    // Demo item
    await client.query(
      `INSERT INTO inventory_items(organization_id, category_id, unit_id, sku, name, is_active)
       VALUES($1,$2,$3,'SKU-DEMO','Demo Item',TRUE)
       ON CONFLICT (organization_id, sku) DO UPDATE
         SET category_id=EXCLUDED.category_id,
             unit_id=EXCLUDED.unit_id,
             name=EXCLUDED.name,
             is_active=TRUE`,
      [orgId, itemCategoryId, unitId]
    );
    const { rows: itemRows } = await client.query(
      `SELECT id FROM inventory_items WHERE organization_id=$1 AND sku='SKU-DEMO' LIMIT 1`,
      [orgId]
    );
    const itemId = itemRows[0].id;

    return { unitId, warehouseId, itemCategoryId, itemId };
  };

  const ensureBankingSeed = async ({ orgId, bankGlAccountId, currencyCode = "GHS" }) => {
    await client.query(
      `INSERT INTO bank_accounts(organization_id, code, name, currency_code, gl_account_id, is_active)
       VALUES($1,'BANK-001','Demo Bank Account',$2,$3,TRUE)
       ON CONFLICT (organization_id, code) DO UPDATE
         SET currency_code=EXCLUDED.currency_code,
             gl_account_id=EXCLUDED.gl_account_id,
             is_active=TRUE`,
      [orgId, currencyCode, bankGlAccountId]
    );
    const { rows } = await client.query(
      `SELECT id FROM bank_accounts WHERE organization_id=$1 AND code='BANK-001' LIMIT 1`,
      [orgId]
    );
    return { bankAccountId: rows[0].id };
  };

  // ========== ACTUAL INITIALIZATION STARTS HERE ==========

  // 1) Ensure global permissions exist (these are organization-independent)
  const perms = [
    // Accounting kernel
    ["accounting.period.read", "Read periods"],
    ["accounting.period.manage", "Create/reopen periods"],
    ["accounting.period.close", "Close periods"],
    ["accounting.period.force_close", "Force close period (override checks)"],
    ["accounting.period.lock", "Lock an open period (read-only)"],
    ["accounting.period.unlock", "Unlock a locked period"],
    ["accounting.period.roll_forward", "Roll forward to create next period"],
    ["accounting.coa.read", "Read chart of accounts"],
    ["accounting.coa.manage", "Manage chart of accounts"],
    ["accounting.coa.archive", "Archive chart of accounts entries"],
    ["accounting.journal.create", "Create draft journals"],
    ["accounting.journal.edit", "Edit draft/rejected journals"],
    ["accounting.journal.submit", "Submit journals for approval"],
    ["accounting.journal.approve", "Approve submitted journals"],
    ["accounting.journal.reject", "Reject submitted journals"],
    ["accounting.journal.cancel", "Cancel draft/rejected journals"],
    ["accounting.journal.batch_post", "Batch post journals"],
    ["accounting.journal.post", "Post journals"],
    ["accounting.journal.void", "Void posted journals"],
    ["accounting.journal.read", "Read journals"],
    ["accounting.balances.read", "Read balances and reports"],
    ["accounting.exports.run", "Run accounting exports"],
    ["accounting.imports.run", "Run accounting imports"],
    ["accounting.reconcile.run", "Run accounting reconciliations"],
    ["accounting.fx.read", "Read FX rates"],
    ["accounting.fx.manage", "Manage FX rates"],

    // RBAC + administration
    ["rbac.permissions.read", "Read permissions"],
    ["rbac.roles.read", "Read roles"],
    ["rbac.roles.manage", "Manage roles and role permissions"],
    ["users.read", "Read users"],
    ["users.manage", "Create/disable users"],
    ["settings.read", "Read system settings"],
    ["settings.manage", "Manage system settings"],
    ["accounting.accruals.read", "Read accrual rules and runs"],
    ["accounting.accruals.manage", "Create/update accrual rules"],
    ["accounting.accruals.run", "Run accrual jobs manually"],
    ["webhooks.manage", "Manage webhooks"],
    ["webhooks.dispatch", "Dispatch webhook outbox"],

    // Business partners
    ["partners.read", "Read business partners"],
    ["partners.manage", "Manage business partners"],

    // Invoices
    ["transactions.invoice.read", "Read invoices"],
    ["transactions.invoice.manage", "Create draft invoices"],
    ["transactions.invoice.issue", "Issue invoices (post journals)"],
    ["transactions.invoice.void", "Void invoices (reversal)"],

    // Bills
    ["transactions.bill.read", "Read bills"],
    ["transactions.bill.manage", "Create draft bills"],
    ["transactions.bill.issue", "Issue bills (post journals)"],
    ["transactions.bill.void", "Void bills (reversal)"],

    // Vendor payments
    ["transactions.vendor_payment.read", "Read vendor payments"],
    ["transactions.vendor_payment.manage", "Create vendor payments"],
    ["transactions.vendor_payment.post", "Post vendor payments"],
    ["transactions.vendor_payment.void", "Void vendor payments"],

    // Customer receipts
    ["transactions.customer_receipt.read", "Read customer receipts"],
    ["transactions.customer_receipt.manage", "Create customer receipts"],
    ["transactions.customer_receipt.post", "Post customer receipts"],
    ["transactions.customer_receipt.void", "Void customer receipts"],

    // Assets
    ["assets.categories.read", "Read asset categories"],
    ["assets.categories.manage", "Manage asset categories"],
    ["assets.fixed_assets.read", "Read fixed assets"],
    ["assets.fixed_assets.manage", "Manage fixed assets"],
    ["assets.depreciation.run", "Run depreciation posting"],

    // Inventory
    ["inventory.units.read", "Read item units"],
    ["inventory.units.manage", "Manage item units"],
    ["inventory.categories.read", "Read item categories"],
    ["inventory.categories.manage", "Manage item categories"],
    ["inventory.items.read", "Read inventory items"],
    ["inventory.items.manage", "Manage inventory items"],
    ["inventory.warehouses.read", "Read warehouses"],
    ["inventory.warehouses.manage", "Manage warehouses"],
    ["inventory.transactions.read", "Read inventory transactions"],
    ["inventory.transactions.post", "Post inventory transactions"],
    ["inventory.settings.manage", "Manage inventory settings"],

    // Banking
    ["banking.accounts.read", "Read bank accounts"],
    ["banking.accounts.manage", "Manage bank accounts"],
    ["banking.statements.read", "Read bank statements"],
    ["banking.statements.manage", "Manage bank statements"],
    ["banking.reconciliation.run", "Run bank reconciliation"],

    // Compliance
    ["compliance.ifrs16.read", "Read IFRS16 leases and schedules"],
    ["compliance.ifrs16.manage", "Create/update IFRS16 leases and schedules"],
    ["compliance.ifrs16.post", "Post IFRS16 lease journals"],
    ["compliance.ifrs15.read", "Read IFRS15 contracts, obligations, and schedules"],
    ["compliance.ifrs15.manage", "Manage IFRS15 contracts, obligations, and schedules"],
    ["compliance.ifrs15.post", "Post IFRS15 revenue journals"],
    ["compliance.ifrs9.read", "Read IFRS9 ECL models, runs, and reports"],
    ["compliance.ifrs9.manage", "Manage IFRS9 ECL models, buckets, and runs"],
    ["compliance.ifrs9.post", "Post IFRS9 impairment journals"],
    ["compliance.ias12.read", "Read IAS12 tax authorities, rates, and settings"],
    ["compliance.ias12.manage", "Manage IAS12 tax authorities, rates, and settings"],
    ["compliance.ias12.post", "Post IAS12 tax journals"],

    // Reporting
    ["reporting.statements.read", "Read and generate financial statements"],
    ["reporting.kpis.read", "Read KPI definitions and values"],
    ["reporting.kpis.manage", "Manage KPI definitions"],
    ["reporting.budgets.read", "Read budgets"],
    ["reporting.budgets.manage", "Manage budgets and budget lines"],
    ["reporting.forecasts.read", "Read forecasts"],
    ["reporting.forecasts.manage", "Manage forecasts and forecast lines"],
    ["reporting.centers.read", "Read cost/profit/investment centers"],
    ["reporting.centers.manage", "Manage cost/profit/investment centers"],
    ["reporting.projects.read", "Read projects"],
    ["reporting.projects.manage", "Manage projects"],
    ["reporting.allocations.read", "Read allocation rules and results"],
    ["reporting.allocations.manage", "Manage allocation bases and rules"],
    ["reporting.exports.run", "Run report exports"],
    ["reporting.ar.read", "Read accounts receivable reports"],
    ["reporting.ap.read", "Read accounts payable reports"],
    ["reporting.banking.read", "Read banking reconciliation reports"],
    ["reporting.audit.read", "Run audit exports"],
    ["reporting.tax.read", "Read tax reports"],
    ["reporting.inventory.read", "Read inventory reports"],
    ["notifications.manage", "Managing of notifications"],
  ];

  for (const [code, description] of perms) {
    await upsertPermission(code, description);
  }

  // 2) Create Admin role and assign all permissions
  const roleId = await getOrCreateRole(orgId, "Admin");
  await client.query(
    `
    INSERT INTO role_permissions(role_id, permission_id)
    SELECT $1, p.id FROM permissions p
    ON CONFLICT DO NOTHING
    `,
    [roleId]
  );

  // 3) Create admin user
  const userId = await createAdminUser(orgId, adminEmail, adminPassword);
  await client.query(
    `INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, roleId]
  );

// 4) Create system user - check existence first
const { rows: existingSystemUser } = await client.query(
  `SELECT id FROM users WHERE organization_id=$1 AND email=$2 LIMIT 1`,
  [orgId, 'system@aptbooks.local']
);

if (existingSystemUser.length === 0) {
  // Try to insert, but handle any unique violations gracefully
  try {
    await client.query(
      `
      INSERT INTO users(organization_id, email, password_hash, status, is_system)
      VALUES ($1, $2, '', 'active', TRUE)
      `,
      [orgId, 'system@aptbooks.local']
    );
  } catch (insertError) {
    // If it's a unique violation, ignore (someone else created it)
    if (insertError.code === '23505') { // PostgreSQL unique violation code
      console.log('System user already exists, continuing...');
    } else {
      throw insertError; // Re-throw other errors
    }
    
  }
}

  // 5) Get account types
  const typeMap = await getAccountTypeMap();

  // 6) Create COA skeleton
  const coa = [
    ["1000", "Cash", typeMap.ASSET],
    ["1010", "Bank", typeMap.ASSET],
    ["1100", "Accounts Receivable", typeMap.ASSET],
    ["1200", "Inventory", typeMap.ASSET],
    ["2000", "Accounts Payable", typeMap.LIABILITY],
    ["2100", "Inventory Clearing (GRNI)", typeMap.LIABILITY],
    ["3000", "Owner's Equity", typeMap.EQUITY],
    ["4000", "Sales Revenue", typeMap.REVENUE],
    ["5000", "Operating Expenses", typeMap.EXPENSE],
    ["5200", "Cost of Goods Sold", typeMap.EXPENSE],
    ["5300", "Inventory Adjustments", typeMap.EXPENSE],
  ];

  for (const [code, name, accountTypeId] of coa) {
    await createCoaAccount(orgId, code, name, accountTypeId);
  }

  // 7) Get account IDs for later use
  const arAccountId = await getCoaIdByCode(orgId, "1100");
  const apAccountId = await getCoaIdByCode(orgId, "2000");
  const inventoryAccountId = await getCoaIdByCode(orgId, "1200");
  const inventoryClearingAccountId = await getCoaIdByCode(orgId, "2100");
  const cogsAccountId = await getCoaIdByCode(orgId, "5200");
  const inventoryAdjustmentAccountId = await getCoaIdByCode(orgId, "5300");
  const bankGlAccountId = await getCoaIdByCode(orgId, "1010");

  // 8) Create open period
  const periodId = await ensureOpenPeriod(orgId);

  // 9) Payment config
  await ensurePaymentConfig(orgId);

  // 10) Demo customer
  const demoCustomerId = await ensureDemoCustomer({ orgId, arAccountId });

  // 11) Demo vendor
  const demoVendorId = await ensureDemoVendor({ orgId, apAccountId });

  // 12) Inventory defaults
  await ensureInventoryCostMethodDefault(orgId);

  const inventory = await ensureInventoryMasterData({
    orgId,
    inventoryAccountId,
    cogsAccountId,
    adjustmentAccountId: inventoryAdjustmentAccountId,
    clearingAccountId: inventoryClearingAccountId,
  });

  // 13) Banking seed
  const banking = await ensureBankingSeed({ orgId, bankGlAccountId, currencyCode: baseCurrencyCode });

  // Return summary
  return {
    orgId,
    adminEmail,
    adminUserId: userId,
    periodId,
    demoCustomerId,
    demoVendorId,
    accounts: {
      cashAccountId: await getCoaIdByCode(orgId, "1000"),
      bankGlAccountId,
      arAccountId,
      inventoryAccountId,
      inventoryClearingAccountId,
      apAccountId,
      cogsAccountId,
      inventoryAdjustmentAccountId,
    },
    inventory: {
      unitId: inventory.unitId,
      warehouseId: inventory.warehouseId,
      itemCategoryId: inventory.itemCategoryId,
      itemId: inventory.itemId,
    },
    banking: {
      bankAccountId: banking.bankAccountId,
    },
  };
}

module.exports = {
  initializeOrganizationDefaults,
};