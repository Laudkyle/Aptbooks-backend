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
    const code = "2026 Accounting Period";
    const start = "2026-01-01";
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
      { code: "CHEQUE", name: "Cheque" },
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

    // Optional: primary contact
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

    // Optional: primary address
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
    // Default to Weighted Average for Phase 4B. The transactions service will lock this after first posted journal.
    await upsertSystemSetting(orgId, "inventoryCostMethod", { method: "WEIGHTED_AVERAGE", locked: false });
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
    // Bank account entity (Tier 7)
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
      ["accounting.reconcile.export", "Export accounting reconciliation results"],
      ["accounting.reconcile.resolve", "Resolve accounting reconciliation exceptions"],
      ["accounting.reconcile.policy", "Manage accounting reconciliation policies"],
      ["accounting.fx.read", "Read FX rates"],
      ["accounting.fx.manage", "Manage FX rates"],

      // RBAC + administration (Tier 0)
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

      // Tier 2
      ["partners.read", "Read business partners"],
      ["partners.manage", "Manage business partners"],

      // Tier 3 (Invoices)
      ["transactions.invoice.read", "Read invoices"],
      ["transactions.invoice.manage", "Create draft invoices"],
      ["transactions.invoice.issue", "Issue invoices (post journals)"],
      ["transactions.invoice.void", "Void invoices (reversal)"],

      ["transactions.bill.read", "Read bills"],
      ["transactions.bill.manage", "Create draft bills"],
      ["transactions.bill.issue", "Issue bills (post journals)"],
      ["transactions.bill.void", "Void bills (reversal)"],

      ["transactions.vendor_payment.read", "Read vendor payments"],
      ["transactions.vendor_payment.manage", "Create vendor payments"],
      ["transactions.vendor_payment.post", "Post vendor payments"],
      ["transactions.vendor_payment.void", "Void vendor payments"],

      // Tier 3 (Customer receipts)
      ["transactions.customer_receipt.read", "Read customer receipts"],
      ["transactions.customer_receipt.manage", "Create customer receipts"],
      ["transactions.customer_receipt.post", "Post customer receipts"],
      ["transactions.customer_receipt.void", "Void customer receipts"],

      // Quotations
      ["transactions.quotation.read", "Read quotations"],
      ["transactions.quotation.manage", "Create/manage quotations"],
      ["transactions.quotation.issue", "Issue quotations"],
      ["transactions.quotation.void", "Void quotations"],

      // Sales Orders
      ["transactions.sales_order.read", "Read sales orders"],
      ["transactions.sales_order.manage", "Create/manage sales orders"],
      ["transactions.sales_order.issue", "Issue sales orders"],
      ["transactions.sales_order.void", "Void sales orders"],

      // Purchase Requisitions
      ["transactions.purchase_requisition.read", "Read purchase requisitions"],
      ["transactions.purchase_requisition.manage", "Create/manage purchase requisitions"],
      ["transactions.purchase_requisition.issue", "Issue purchase requisitions"],
      ["transactions.purchase_requisition.void", "Void purchase requisitions"],

      // Purchase Orders
      ["transactions.purchase_order.read", "Read purchase orders"],
      ["transactions.purchase_order.manage", "Create/manage purchase orders"],
      ["transactions.purchase_order.issue", "Issue purchase orders"],
      ["transactions.purchase_order.void", "Void purchase orders"],

      // Goods Receipts
      ["transactions.goods_receipt.read", "Read goods receipts"],
      ["transactions.goods_receipt.manage", "Create/manage goods receipts"],
      ["transactions.goods_receipt.post", "Post goods receipts"],
      ["transactions.goods_receipt.void", "Void goods receipts"],

      // Expenses
      ["transactions.expense.read", "Read expenses"],
      ["transactions.expense.manage", "Create/manage expenses"],
      ["transactions.expense.post", "Post expenses"],
      ["transactions.expense.void", "Void expenses"],

      // Petty Cash
      ["transactions.petty_cash.read", "Read petty cash transactions"],
      ["transactions.petty_cash.manage", "Create/manage petty cash transactions"],
      ["transactions.petty_cash.post", "Post petty cash transactions"],
      ["transactions.petty_cash.void", "Void petty cash transactions"],

      // Advances
      ["transactions.advance.read", "Read advances"],
      ["transactions.advance.manage", "Create/manage advances"],
      ["transactions.advance.post", "Post advances"],
      ["transactions.advance.void", "Void advances"],

      // Returns
      ["transactions.return.read", "Read returns"],
      ["transactions.return.manage", "Create/manage returns"],
      ["transactions.return.post", "Post returns"],
      ["transactions.return.void", "Void returns"],

      // Refunds
      ["transactions.refund.read", "Read refunds"],
      ["transactions.refund.manage", "Create/manage refunds"],
      ["transactions.refund.post", "Post refunds"],
      ["transactions.refund.void", "Void refunds"],

      // Assets (Tier 4)
      ["assets.categories.read", "Read asset categories"],
      ["assets.categories.manage", "Manage asset categories"],
      ["assets.fixed_assets.read", "Read fixed assets"],
      ["assets.fixed_assets.manage", "Manage fixed assets"],
      ["assets.depreciation.run", "Run depreciation posting"],

      // Inventory (Tier 5) - Expanded with all permissions
      ["inventory.categories.read", "Read item categories"],
      ["inventory.categories.manage", "Manage item categories"],
      ["inventory.units.read", "Read item units"],
      ["inventory.units.manage", "Manage item units"],
      ["inventory.items.read", "Read inventory items"],
      ["inventory.items.manage", "Manage inventory items"],
      ["inventory.warehouses.read", "Read warehouses"],
      ["inventory.warehouses.manage", "Manage warehouses"],
      ["inventory.transactions.read", "Read inventory transactions"],
      ["inventory.transactions.manage", "Manage draft inventory transactions"],
      ["inventory.transactions.approve", "Approve inventory transactions"],
      ["inventory.transactions.post", "Post inventory transactions"],
      ["inventory.reservations.read", "Read stock reservations"],
      ["inventory.reservations.manage", "Manage stock reservations"],
      ["inventory.transfers.read", "Read stock transfer requests"],
      ["inventory.transfers.manage", "Manage draft stock transfer requests"],
      ["inventory.transfers.approve", "Approve stock transfer requests"],
      ["inventory.transfers.post", "Post stock transfer requests"],
      ["inventory.traceability.read", "Read batch and serial traceability"],
      ["inventory.traceability.manage", "Manage batch and serial traceability"],
      ["inventory.reorder.read", "Read reorder settings and suggestions"],
      ["inventory.reorder.manage", "Manage reorder settings and automation"],
      ["inventory.settings.manage", "Manage inventory settings"],

      // Banking (Tier 7)
      ["banking.accounts.read", "Read bank accounts"],
      ["banking.accounts.manage", "Manage bank accounts"],
      ["banking.statements.read", "Read bank statements"],
      ["banking.statements.manage", "Manage bank statements"],
      ["banking.reconciliation.run", "Run bank reconciliation"],
      ["banking.treasury.read", "Read treasury and cash-management data"],
      ["banking.treasury.manage", "Manage treasury instructions and cash-management records"],
      ["banking.treasury.approve", "Approve treasury payment batches and transfers"],
      ["banking.treasury.execute", "Execute treasury payments, transfers, and cheques"],

      // Compliance (Tier 8) - IFRS 16 Leases
      ["compliance.ifrs16.read", "Read IFRS16 leases and schedules"],
      ["compliance.ifrs16.manage", "Create/update IFRS16 leases and schedules"],
      ["compliance.ifrs16.post", "Post IFRS16 lease journals"],

      // Compliance (Tier 8) - IFRS 15 Revenue
      ["compliance.ifrs15.read", "Read IFRS15 contracts, obligations, and schedules"],
      ["compliance.ifrs15.manage", "Manage IFRS15 contracts, obligations, and schedules"],
      ["compliance.ifrs15.post", "Post IFRS15 revenue journals"],

      // Compliance (Tier 8) - IFRS 9 Financial Instruments (Stage 1: Simplified ECL)
      ["compliance.ifrs9.read", "Read IFRS9 ECL models, runs, and reports"],
      ["compliance.ifrs9.manage", "Manage IFRS9 ECL models, buckets, and runs"],
      ["compliance.ifrs9.post", "Post IFRS9 impairment journals"],

      // Compliance (Tier 8) - IAS 12 Income Taxes
      ["compliance.ias12.read", "Read IAS12 tax authorities, rates, and settings"],
      ["compliance.ias12.manage", "Manage IAS12 tax authorities, rates, and settings"],
      ["compliance.ias12.post", "Post IAS12 tax journals"],

      // Reporting (Tier 6)
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
      
      // Reporting - Operational reports
      ["reporting.ar.read", "Read accounts receivable reports"],
      ["reporting.ap.read", "Read accounts payable reports"],
      ["reporting.banking.read", "Read banking reconciliation reports"],
      ["reporting.audit.read", "Run audit exports"],
      ["reporting.tax.read", "Read tax reports"],
      
      ["reporting.inventory.read", "Read inventory reports"],

      // Optional override
      ["notifications.manage", "Managing of notifications"],
      ["automation.recurring.read", "Read recurring transaction automations"],
      ["automation.recurring.manage", "Manage recurring transaction automations"],
      ["automation.recurring.run", "Run recurring transaction automations"],
      ["automation.jobs.read", "Read accounting job automation tasks"],
      ["automation.read", "Read automation tasks"],
      ["automation.manage", "Manage automation tasks"],
      ["automation.jobs.manage", "Manage accounting job automation tasks"],
      ["automation.run", "Run automation tasks"],
      ["automation.jobs.run", "Run accounting job automation tasks"],
      ["automation.reconciliation.read", "Read auto reconciliation profiles and results"],
      ["automation.reconciliation.manage", "Manage auto reconciliation profiles"],
      ["automation.reconciliation.run", "Run auto reconciliation profiles"],
      ["automation.document-matching.read", "Read intelligent document matching"],
      ["automation.document-matching.manage", "Manage intelligent document matching profiles"],
      ["automation.document-matching.run", "Run intelligent document matching"],
      ["automation.classification.read", "Read automation classification rules and logs"],
      ["automation.classification.manage", "Manage automation classification rules"],
      ["automation.classification.run", "Run automation classification"],
      ["automation.notifications.read", "Read smart notification rules"],
      ["automation.notifications.manage", "Manage smart notification rules"],
      ["automation.notifications.run", "Run smart notification rules"],
      ["printing.templates.read", "Read document templates and assignments"],
      ["printing.templates.manage", "Manage document templates, versions, and assignments"],
      ["printing.render", "Render transaction documents using assigned templates"],
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
      await client.query(
        `
        INSERT INTO chart_of_accounts(organization_id, code, name, account_type_id, is_postable, status)
        VALUES ($1,$2,$3,$4,true,'active')
        ON CONFLICT (organization_id, code) DO NOTHING
        `,
        [orgId, code, name, accountTypeId]
      );
    }
    await client
      .query(
        `
  INSERT INTO users(organization_id, email, password_hash, status, is_system)
  VALUES ($1, 'system@aptbooks.local', '', 'active', TRUE)
  ON CONFLICT DO NOTHING
  `,
        [orgId]
      )
      .catch(async () => {
        await client.query(
          `
    INSERT INTO users(organization_id, email, password_hash, status)
    VALUES ($1, 'system@aptbooks.local', '', 'active')
    ON CONFLICT DO NOTHING
    `,
          [orgId]
        );
      });

    // 5) Ensure open period for invoice issue tests
    const periodId = await ensureOpenPeriod(orgId);

    // 6) Payment config (Phase 2)
    await ensurePaymentConfig(orgId);

    // 7) Demo customer with A/R set
    const arAccountId = await getCoaIdByCode(orgId, "1100");
    if (!arAccountId) throw new Error("Missing A/R account 1100 in COA");

    const demoCustomerId = await ensureDemoCustomer({ orgId, arAccountId });

    // 8) Demo vendor with A/P set (Phase 2b)
    const apAccountId = await getCoaIdByCode(orgId, "2000");
    if (!apAccountId) throw new Error("Missing A/P account 2000 in COA");

    const demoVendorId = await ensureDemoVendor({ orgId, apAccountId });

    // 9) Phase 4 defaults & master data for Postman testing
    await ensureInventoryCostMethodDefault(orgId);

    const inventoryAccountId = await getCoaIdByCode(orgId, "1200");
    const inventoryClearingAccountId = await getCoaIdByCode(orgId, "2100");
    const cogsAccountId = await getCoaIdByCode(orgId, "5200");
    const inventoryAdjustmentAccountId = await getCoaIdByCode(orgId, "5300");
    const bankGlAccountId = await getCoaIdByCode(orgId, "1010");

    if (!inventoryAccountId) throw new Error("Missing Inventory account 1200 in COA");
    if (!inventoryClearingAccountId) throw new Error("Missing Inventory Clearing account 2100 in COA");
    if (!cogsAccountId) throw new Error("Missing COGS account 5200 in COA");
    if (!inventoryAdjustmentAccountId) throw new Error("Missing Inventory Adjustments account 5300 in COA");
    if (!bankGlAccountId) throw new Error("Missing Bank account 1010 in COA");

    const inventory = await ensureInventoryMasterData({
      orgId,
      inventoryAccountId,
      cogsAccountId,
      adjustmentAccountId: inventoryAdjustmentAccountId,
      clearingAccountId: inventoryClearingAccountId,
    });

    const banking = await ensureBankingSeed({ orgId, bankGlAccountId, currencyCode: "GHS" });


    await client.query("COMMIT");

    console.log("Seed complete:", {
      orgId,
      adminEmail,
      adminPassword: user.created ? adminPassword : "(unchanged)",
      openPeriodId: periodId,
      demoCustomerId,
      demoVendorId,
      settings: {
        inventoryCostMethod: { method: "WEIGHTED_AVERAGE", locked: false },
      },
      accounts: {
        cashAccountId: await getCoaIdByCode(orgId, "1000"),
        bankGlAccountId: await getCoaIdByCode(orgId, "1010"),
        arAccountId,
        inventoryAccountId: await getCoaIdByCode(orgId, "1200"),
        inventoryClearingAccountId: await getCoaIdByCode(orgId, "2100"),
        apAccountId,
        revenueAccountId: await getCoaIdByCode(orgId, "4000"),
        expenseAccountId: await getCoaIdByCode(orgId, "5000"),
        cogsAccountId: await getCoaIdByCode(orgId, "5200"),
        inventoryAdjustmentAccountId: await getCoaIdByCode(orgId, "5300"),
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