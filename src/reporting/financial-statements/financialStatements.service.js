const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");
const { trialBalance: trialBalanceSvc } = require("../../core/accounting/ledger/balances.service");
const repo = require("./financialStatements.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertPeriodId(periodId) {
  if (!periodId) throw new AppError(400, "periodId is required");
}

async function getPeriod({ orgId, periodId }) {
  const { rows } = await pool.query(
    `SELECT id, start_date, end_date, status FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(404, "Period not found");
  return rows[0];
}

async function listPeriodsForYtd({ orgId, periodId }) {
  const p = await getPeriod({ orgId, periodId });
  const year = new Date(p.end_date).getUTCFullYear();
  const startOfYear = `${year}-01-01`;
  const { rows } = await pool.query(
    `
    SELECT id
    FROM accounting_periods
    WHERE organization_id=$1
      AND start_date >= $2::date
      AND end_date <= $3::date
    ORDER BY start_date
    `,
    [orgId, startOfYear, p.end_date]
  );
  return rows.map((r) => r.id);
}

async function trialBalance({ orgId, periodId }) {
  assertPeriodId(periodId);
  return trialBalanceSvc({ orgId, periodId });
}

function netForStatement(row, signNormal) {
  // trialBalance rows include normal_balance.
  const debit = Number(row.debit_total || 0);
  const credit = Number(row.credit_total || 0);
  const normal = signNormal || row.normal_balance || "debit";
  return normal === "credit" ? credit - debit : debit - credit;
}

async function fetchTbMap({ orgId, periodId, mode }) {
  if (mode === "ytd") {
    const periodIds = await listPeriodsForYtd({ orgId, periodId });
    if (!periodIds.length) return new Map();
    const { rows } = await pool.query(
      `
      SELECT
        coa.id AS account_id,
        coa.code,
        coa.name,
        at.code AS account_type,
        at.normal_balance,
        SUM(COALESCE(glb.debit_total,0)) AS debit_total,
        SUM(COALESCE(glb.credit_total,0)) AS credit_total
      FROM chart_of_accounts coa
      JOIN account_types at ON at.id = coa.account_type_id
      LEFT JOIN general_ledger_balances glb
        ON glb.organization_id = coa.organization_id
       AND glb.account_id = coa.id
       AND glb.period_id = ANY($2::uuid[])
      WHERE coa.organization_id = $1
      GROUP BY coa.id, coa.code, coa.name, at.code, at.normal_balance
      ORDER BY coa.code
      `,
      [orgId, periodIds]
    );
    return new Map(rows.map((r) => [r.account_id, r]));
  }
  const rows = await trialBalanceSvc({ orgId, periodId });
  return new Map(rows.map((r) => [r.account_id, r]));
}

function buildTree(lines) {
  const byId = new Map(lines.map((l) => [l.id, { ...l, children: [] }]));
  const roots = [];
  for (const l of byId.values()) {
    if (l.parent_line_id && byId.has(l.parent_line_id)) {
      byId.get(l.parent_line_id).children.push(l);
    } else {
      roots.push(l);
    }
  }
  const sort = (arr) => {
    arr.sort((a, b) => (a.sort_order - b.sort_order) || (a.line_no - b.line_no));
    for (const x of arr) sort(x.children);
  };
  sort(roots);
  return roots;
}

function safeEvalFormula(expression, context) {
  // Minimal DSL: allow identifiers that match line_no (e.g. L10), and + - * / ( )
  // We map identifiers to numeric values from context.
  if (!expression) return 0;
  const cleaned = String(expression).trim();
  if (!cleaned) return 0;

  // Replace tokens like L123 with values
  const replaced = cleaned.replace(/\bL(\d+)\b/g, (_, n) => {
    const key = `L${n}`;
    const v = context[key];
    return Number.isFinite(v) ? String(v) : "0";
  });
  // Only allow safe chars
  if (!/^[0-9+\-*/().\s]+$/.test(replaced)) {
    throw new AppError(400, "Invalid formula expression");
  }
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${replaced});`)();
}

function computeLineAmounts({ line, lineAccounts, tbMap, ctx }) {
  if (!line.is_visible) return { amount: null };

  if (line.line_type === "account") {
    const mapped = lineAccounts.get(line.id) || [];
    let amount = 0;
    for (const m of mapped) {
      const tbRow = tbMap.get(m.account_id);
      if (!tbRow) continue;
      const normal = m.sign_override || m.normal_balance || tbRow.normal_balance;
      amount += netForStatement(tbRow, normal) * Number(m.weight || 1);
    }
    ctx[`L${line.line_no}`] = amount;
    return { amount };
  }

  if (line.line_type === "formula") {
    const amount = safeEvalFormula(line.expression, ctx);
    ctx[`L${line.line_no}`] = amount;
    return { amount };
  }

  // section/subtotal/total/text: computed from children (handled by caller) or null
  return { amount: null };
}

function rollupTree(node, childResults, ctx) {
  if (!node.is_visible) return null;
  const kids = (node.children || []).map((c) => childResults.get(c.id)).filter((x) => x !== null);
  const computed = childResults.get(node.id);

  let amount = computed?.amount;
  if (amount === null || amount === undefined) {
    // For section/subtotal/total default: sum visible children amounts
    const sum = kids.reduce((s, k) => s + (Number(k.amount) || 0), 0);
    if (["section", "subtotal", "total"].includes(node.line_type)) amount = sum;
  }
  if (amount !== null && amount !== undefined) ctx[`L${node.line_no}`] = amount;

  return {
    id: node.id,
    line_no: node.line_no,
    label: node.label,
    line_type: node.line_type,
    section_code: node.section_code || null,
    amount,
    children: kids
  };
}

async function ensureDefaultTemplate({ orgId, statementType }) {
  const existing = await repo.getDefaultTemplate({ orgId, statementType });
  if (existing) return existing;

  const tpl = await repo.createTemplate({
    orgId,
    statementType,
    name: `Default ${statementType.replace(/_/g, " ")}`,
    description: "Auto-generated default template"
  });

  // Build a minimal but production-safe structure. It is intentionally conservative:
  // - uses account categories where possible
  // - falls back to account_type grouping
  const { rows: accounts } = await pool.query(
    `
    SELECT
      coa.id,
      coa.code,
      coa.name,
      at.code AS account_type,
      at.normal_balance,
      ac.name AS category_name
    FROM chart_of_accounts coa
    JOIN account_types at ON at.id = coa.account_type_id
    LEFT JOIN account_categories ac ON ac.id = coa.category_id
    WHERE coa.organization_id=$1 AND coa.status='active'
    ORDER BY coa.code
    `,
    [orgId]
  );

  let lines = [];
  let mappings = [];
  let lineNo = 10;
  const addSection = (label, sectionCode) => {
    const section = {
      line_no: lineNo,
      label,
      line_type: "section",
      sort_order: lineNo,
      parent_line_id: null,
      is_visible: true,
      dr_cr_normal: "auto",
      section_code: sectionCode
    };
    lineNo += 10;
    lines.push(section);
    return section;
  };
  const addAccountGroupLine = (parent, label, sectionCode, accountFilterFn, normalOverride) => {
    const ln = {
      line_no: lineNo,
      label,
      line_type: "account",
      sort_order: lineNo,
      parent_line_id: null, // filled after insert
      is_visible: true,
      dr_cr_normal: normalOverride || "auto",
      section_code: sectionCode
    };
    lineNo += 10;
    lines.push({ ...ln, _parent_tmp: parent.line_no });
    const accts = accounts.filter(accountFilterFn);
    // mappings will be resolved to line_id after insert
    mappings.push({ _line_no: ln.line_no, accounts: accts, normalOverride });
  };

  if (statementType === "income_statement") {
    const rev = addSection("Revenue", "REV");
    addAccountGroupLine(rev, "Revenue", "REV", (a) => a.account_type === "REVENUE", "credit");

    const cogs = addSection("Cost of sales", "COGS");
    addAccountGroupLine(
      cogs,
      "Cost of sales",
      "COGS",
      (a) => a.account_type === "EXPENSE" && /cogs|cost of sales|cost of goods/i.test(a.category_name || a.name || ""),
      "debit"
    );

    const opex = addSection("Operating expenses", "OPEX");
    addAccountGroupLine(
      opex,
      "Operating expenses",
      "OPEX",
      (a) => a.account_type === "EXPENSE" && !/cogs|cost of sales|cost of goods/i.test(a.category_name || a.name || ""),
      "debit"
    );

    const other = addSection("Other income/expenses", "OTHER");
    // Basic heuristic: any expense category/name containing 'interest'/'finance' considered other expense
    addAccountGroupLine(
      other,
      "Other income",
      "OTHER_INCOME",
      (a) => a.account_type === "REVENUE" && /other|interest|finance/i.test(a.category_name || a.name || ""),
      "credit"
    );
    addAccountGroupLine(
      other,
      "Other expenses",
      "OTHER_EXP",
      (a) => a.account_type === "EXPENSE" && /interest|finance|other/i.test(a.category_name || a.name || ""),
      "debit"
    );

    // Net income as formula: L(revenue) - L(cogs) - L(opex) + L(other income) - L(other exp)
    const netIncomeLine = {
      line_no: lineNo,
      label: "Net income",
      line_type: "formula",
      expression: `L${rev.line_no + 10} - L${cogs.line_no + 10} - L${opex.line_no + 10} + L${other.line_no + 10} - L${other.line_no + 20}`,
      sort_order: lineNo,
      parent_line_id: null,
      is_visible: true,
      dr_cr_normal: "auto",
      section_code: "NET_INCOME"
    };
    lineNo += 10;
    lines.push(netIncomeLine);
  } else if (statementType === "balance_sheet") {
    const assets = addSection("Assets", "ASSETS");
    addAccountGroupLine(assets, "Assets", "ASSETS", (a) => a.account_type === "ASSET", "debit");
    const liab = addSection("Liabilities", "LIAB");
    addAccountGroupLine(liab, "Liabilities", "LIAB", (a) => a.account_type === "LIABILITY", "credit");
    const eq = addSection("Equity", "EQUITY");
    addAccountGroupLine(eq, "Equity", "EQUITY", (a) => a.account_type === "EQUITY", "credit");

    const check = {
      line_no: lineNo,
      label: "Check (Assets - (Liabilities + Equity))",
      line_type: "formula",
      expression: `L${assets.line_no + 10} - (L${liab.line_no + 10} + L${eq.line_no + 10})`,
      sort_order: lineNo,
      parent_line_id: null,
      is_visible: true,
      dr_cr_normal: "auto",
      section_code: "CHECK"
    };
    lineNo += 10;
    lines.push(check);
  } else if (statementType === "cash_flow") {
    // Structure only. Amounts will be computed by cashFlowStatement().
    addSection("Operating activities", "CFO");
    addSection("Investing activities", "CFI");
    addSection("Financing activities", "CFF");
  } else {
    throw new AppError(400, "Unsupported statementType");
  }

  // Insert lines
  const inserted = await repo.bulkInsertLines({
    orgId,
    templateId: tpl.id,
    lines: lines.map((l, idx) => ({
      ...l,
      line_no: l.line_no,
      // parent_line_id is resolved after insertion
      parent_line_id: null
    }))
  });

  const byLineNo = new Map(inserted.map((l) => [l.line_no, l]));

  // Patch parent_line_id where needed
  const parentUpdates = inserted
    .map((l) => {
      const original = lines.find((x) => x.line_no === l.line_no);
      if (original && original._parent_tmp) {
        const parent = byLineNo.get(original._parent_tmp);
        if (parent) return { id: l.id, parentId: parent.id };
      }
      return null;
    })
    .filter(Boolean);

  for (const u of parentUpdates) {
    await pool.query(`UPDATE statement_lines SET parent_line_id=$2 WHERE id=$1`, [u.id, u.parentId]);
  }

  // Insert line->accounts mappings
  const lineAccounts = [];
  for (const m of mappings) {
    const ln = byLineNo.get(m._line_no);
    if (!ln) continue;
    for (const a of m.accounts) {
      lineAccounts.push({
        line_id: ln.id,
        account_id: a.id,
        weight: 1,
        sign_override: m.normalOverride || null
      });
    }
  }
  await repo.bulkInsertLineAccounts({ mappings: lineAccounts });
  return tpl;
}

async function buildTemplateStatement({ orgId, statementType, periodId, comparePeriodId, mode }) {
  assertPeriodId(periodId);
  const tpl = await ensureDefaultTemplate({ orgId, statementType });

  const { lines, mappings } = await repo.getTemplateGraph({ orgId, templateId: tpl.id });
  const lineAccounts = new Map();
  for (const m of mappings) {
    if (!lineAccounts.has(m.line_id)) lineAccounts.set(m.line_id, []);
    lineAccounts.get(m.line_id).push(m);
  }

  const tree = buildTree(lines);

  const tbMap = await fetchTbMap({ orgId, periodId, mode });
  const cmpTbMap = comparePeriodId ? await fetchTbMap({ orgId, periodId: comparePeriodId, mode }) : null;

  const ctx = {};
  const childResults = new Map();
  // First pass: compute leaf amounts and formula lines; section totals computed on rollup
  for (const line of lines) {
    const r = computeLineAmounts({ line, lineAccounts, tbMap, ctx });
    childResults.set(line.id, { ...r, id: line.id, amount: r.amount });
  }

  const roll = (node) => {
    for (const c of node.children || []) roll(c);
    const res = rollupTree(node, childResults, ctx);
    childResults.set(node.id, res);
  };
  for (const r of tree) roll(r);
  const built = tree.map((r) => childResults.get(r.id)).filter(Boolean);

  let cmpBuilt = null;
  if (cmpTbMap) {
    const ctx2 = {};
    const child2 = new Map();
    for (const line of lines) {
      const r = computeLineAmounts({ line, lineAccounts, tbMap: cmpTbMap, ctx: ctx2 });
      child2.set(line.id, { ...r, id: line.id, amount: r.amount });
    }
    const roll2 = (node) => {
      for (const c of node.children || []) roll2(c);
      const res = rollupTree(node, child2, ctx2);
      child2.set(node.id, res);
    };
    for (const r of tree) roll2(r);
    cmpBuilt = tree.map((r) => child2.get(r.id)).filter(Boolean);
  }

  return {
    statement_type: statementType,
    template_id: tpl.id,
    period_id: periodId,
    compare_period_id: comparePeriodId || null,
    mode: mode || "period",
    lines: built,
    compare: cmpBuilt ? { period_id: comparePeriodId, lines: cmpBuilt } : null
  };
}

async function incomeStatement({ orgId, periodId, comparePeriodId, mode }) {
  return buildTemplateStatement({ orgId, statementType: "income_statement", periodId, comparePeriodId, mode });
}

async function balanceSheet({ orgId, periodId, comparePeriodId }) {
  // Balance sheet is as-of. We still support compare period.
  return buildTemplateStatement({ orgId, statementType: "balance_sheet", periodId, comparePeriodId, mode: "as_of" });
}

async function cashFlowStatement({ orgId, periodId, comparePeriodId }) {
  assertPeriodId(periodId);
  const buildOne = async (pid) => {
    const period = await getPeriod({ orgId, periodId: pid });

    // Identify cash accounts: bank accounts plus any manually registered.
    const { rows: cashAccounts } = await pool.query(
      `
      SELECT account_id FROM cash_flow_cash_accounts WHERE organization_id=$1
      UNION
      SELECT gl_account_id AS account_id FROM bank_accounts WHERE organization_id=$1
      `,
      [orgId]
    );
    const cashIds = Array.from(new Set(cashAccounts.map((r) => r.account_id)));
    if (!cashIds.length) {
      return {
        period_id: pid,
        from: period.start_date,
        to: period.end_date,
        lines: [],
        totals: { operating: 0, investing: 0, financing: 0, net_change: 0 }
      };
    }

    const { rows: categories } = await pool.query(
      `SELECT id, section, code, name, sort_order FROM cash_flow_categories WHERE organization_id=$1 AND is_active=true ORDER BY section, sort_order`,
      [orgId]
    );
    const byId = new Map(categories.map((c) => [c.id, c]));
    const unclassified = categories.find((c) => c.code === "UNCLASSIFIED") || null;

    const { rows: mappings } = await pool.query(
      `
      SELECT account_id, category_id
      FROM cash_flow_account_mappings
      WHERE organization_id=$1
      `,
      [orgId]
    );
    const mapAccountToCat = new Map(mappings.map((m) => [m.account_id, m.category_id]));

    // Get posted journal lines for cash accounts in period
    const { rows: cashLines } = await pool.query(
      `
      SELECT
        je.id AS journal_id,
        je.entry_date,
        jel.id AS line_id,
        jel.account_id,
        jel.debit,
        jel.credit,
        jel.amount_base
      FROM journal_entries je
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.organization_id=$1
        AND je.status='posted'
        AND je.entry_date BETWEEN $2::date AND $3::date
        AND jel.account_id = ANY($4::uuid[])
      ORDER BY je.entry_date, je.entry_no, jel.line_no
      `,
      [orgId, period.start_date, period.end_date, cashIds]
    );

    // For each journal, fetch non-cash lines once.
    const journalIds = Array.from(new Set(cashLines.map((l) => l.journal_id)));
    const nonCashByJournal = new Map();
    if (journalIds.length) {
      const { rows: otherLines } = await pool.query(
        `
        SELECT
          je.id AS journal_id,
          jel.account_id,
          jel.debit,
          jel.credit,
          jel.amount_base
        FROM journal_entries je
        JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.id = ANY($1::uuid[])
          AND jel.account_id <> ALL($2::uuid[])
        `,
        [journalIds, cashIds]
      );
      for (const l of otherLines) {
        if (!nonCashByJournal.has(l.journal_id)) nonCashByJournal.set(l.journal_id, []);
        nonCashByJournal.get(l.journal_id).push(l);
      }
    }

    const totals = { operating: 0, investing: 0, financing: 0 };
    const buckets = new Map();

    const addAmount = (categoryId, amount) => {
      const cat = byId.get(categoryId) || unclassified;
      const catKey = cat ? cat.id : "UNMAPPED";
      if (!buckets.has(catKey)) {
        buckets.set(catKey, {
          category: cat ? { id: cat.id, section: cat.section, code: cat.code, name: cat.name } : { id: null, section: "operating", code: "UNMAPPED", name: "Unmapped" },
          amount: 0
        });
      }
      buckets.get(catKey).amount += amount;
      if (cat) totals[cat.section] += amount;
      else totals.operating += amount;
    };

    for (const cl of cashLines) {
      const cashChange = Number(cl.debit || 0) - Number(cl.credit || 0); // cash accounts are debit-normal
      const others = nonCashByJournal.get(cl.journal_id) || [];
      if (!others.length) {
        addAmount(unclassified?.id, cashChange);
        continue;
      }
      const weights = others.map((o) => Math.abs(Number(o.amount_base || (Number(o.debit || 0) + Number(o.credit || 0)))));
      const denom = weights.reduce((s, w) => s + w, 0) || 0;
      for (let i = 0; i < others.length; i++) {
        const o = others[i];
        const w = denom ? weights[i] / denom : 1 / others.length;
        const allocated = cashChange * w;
        const catId = mapAccountToCat.get(o.account_id) || unclassified?.id;
        addAmount(catId, allocated);
      }
    }

    const lines = Array.from(buckets.values()).sort((a, b) => {
      const sa = a.category.section;
      const sb = b.category.section;
      if (sa !== sb) return sa.localeCompare(sb);
      return a.category.name.localeCompare(b.category.name);
    });
    const net_change = totals.operating + totals.investing + totals.financing;
    return {
      period_id: pid,
      from: period.start_date,
      to: period.end_date,
      lines,
      totals: { ...totals, net_change }
    };
  };

  const current = await buildOne(periodId);
  const compare = comparePeriodId ? await buildOne(comparePeriodId) : null;
  return {
    statement_type: "cash_flow",
    period_id: periodId,
    compare_period_id: comparePeriodId || null,
    data: current,
    compare
  };
}

function findLineBySectionCode(lines, sectionCode) {
  for (const l of lines || []) {
    if ((l.section_code || null) === sectionCode) return l;
    const child = findLineBySectionCode(l.children || [], sectionCode);
    if (child) return child;
  }
  return null;
}

async function getPreviousPeriodId({ orgId, periodId }) {
  const p = await getPeriod({ orgId, periodId });
  const { rows } = await pool.query(
    `
    SELECT id
    FROM accounting_periods
    WHERE organization_id=$1
      AND end_date < $2::date
    ORDER BY end_date DESC
    LIMIT 1
    `,
    [orgId, p.start_date]
  );
  return rows[0]?.id || null;
}

async function equityBalanceAsOf({ orgId, periodId }) {
  // Uses the same underlying source as other statements (general_ledger_balances via trialBalance).
  const tb = await trialBalanceSvc({ orgId, periodId });
  let equity = 0;
  for (const r of tb) {
    if (r.account_type !== "EQUITY") continue;
    equity += netForStatement(r, "credit");
  }
  return equity;
}

async function equityMovements({ orgId, fromDate, toDate }) {
  const { rows } = await pool.query(
    `
    SELECT
      rem.movement_code,
      COALESCE(SUM(jel.credit - jel.debit),0) AS amount
    FROM reporting_equity_mappings rem
    JOIN journal_entry_lines jel ON jel.account_id = rem.account_id
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    JOIN journal_entry_types jet ON jet.id = je.journal_entry_type_id
    WHERE je.organization_id=$1
      AND je.status='posted'
      AND je.entry_date BETWEEN $2::date AND $3::date
      AND (rem.journal_entry_type_code IS NULL OR rem.journal_entry_type_code = jet.code)
    GROUP BY rem.movement_code
    ORDER BY rem.movement_code
    `,
    [orgId, fromDate, toDate]
  );
  const map = {};
  for (const r of rows) map[r.movement_code] = Number(r.amount || 0);
  return map;
}

async function changesInEquityStatement({ orgId, periodId, comparePeriodId }) {
  assertPeriodId(periodId);

  const buildOne = async (pid) => {
    const p = await getPeriod({ orgId, periodId: pid });
    const prevId = await getPreviousPeriodId({ orgId, periodId: pid });
    const opening = prevId ? await equityBalanceAsOf({ orgId, periodId: prevId }) : 0;
    const closingReported = await equityBalanceAsOf({ orgId, periodId: pid });

    // Net income from the income statement template (preferred), fallback to 0.
    const isPayload = await incomeStatement({ orgId, periodId: pid, comparePeriodId: null, mode: "period" });
    const netLine = findLineBySectionCode(isPayload.lines || [], "NET_INCOME");
    const netIncome = Number(netLine?.amount || 0);

    const movements = await equityMovements({ orgId, fromDate: p.start_date, toDate: p.end_date });
    // Avoid double counting if retained earnings posting already included in movement mappings.
    // We treat net income as its own required component.
    const movementTotal = Object.values(movements).reduce((s, v) => s + Number(v || 0), 0);
    const computedClosing = opening + netIncome + movementTotal;
    const diff = computedClosing - closingReported;

    return {
      period_id: pid,
      from: p.start_date,
      to: p.end_date,
      opening_balance: opening,
      net_income: netIncome,
      movements,
      total_movements: movementTotal,
      computed_closing_balance: computedClosing,
      reported_closing_balance: closingReported,
      integrity: {
        difference: diff,
        within_tolerance: Math.abs(diff) < 0.01
      }
    };
  };

  const current = await buildOne(periodId);
  const compare = comparePeriodId ? await buildOne(comparePeriodId) : null;
  return {
    statement_type: "changes_in_equity",
    period_id: periodId,
    compare_period_id: comparePeriodId || null,
    data: current,
    compare
  };
}

async function generateAndPersist({ orgId, periodId, statementType, comparePeriodId, mode, actorUserId, req }) {
  assertPeriodId(periodId);
  if (!statementType) throw new AppError(400, "statementType is required");

  let payload;
  let templateId = null;
  const parameters = { comparePeriodId: comparePeriodId || null, mode: mode || null };
  switch (statementType) {
    case "trial_balance":
      payload = await trialBalance({ orgId, periodId });
      break;
    case "income_statement":
      payload = await incomeStatement({ orgId, periodId, comparePeriodId, mode: mode || "period" });
      templateId = payload.template_id;
      break;
    case "balance_sheet":
      payload = await balanceSheet({ orgId, periodId, comparePeriodId });
      templateId = payload.template_id;
      break;
    case "cash_flow":
      payload = await cashFlowStatement({ orgId, periodId, comparePeriodId });
      templateId = (await ensureDefaultTemplate({ orgId, statementType: "cash_flow" })).id;
      break;
    case "changes_in_equity":
      payload = await changesInEquityStatement({ orgId, periodId, comparePeriodId });
      templateId = null;
      break;
    default:
      throw new AppError(400, "Unsupported statementType");
  }

  const created = await repo.insertFinancialStatement({
    orgId,
    periodId,
    statementType,
    templateId,
    asOfDate: null,
    comparePeriodId,
    mode: mode || (statementType === "balance_sheet" ? "as_of" : "period"),
    parameters,
    generatedByUserId: actorUserId,
    payload
  });

  await writeAudit({
    organizationId: orgId,
    actorUserId,
    action: "reporting.statement.generate",
    entityType: "financial_statement",
    entityId: created.id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    before: null,
    after: { periodId, statementType, comparePeriodId: comparePeriodId || null, mode: mode || null }
  });

  return created;
}

async function listGenerated({ orgId, periodId, statementType, limit }) {
  return repo.listFinancialStatements({ orgId, periodId, statementType, limit });
}

module.exports = {
  trialBalance,
  incomeStatement,
  balanceSheet,
  cashFlowStatement,
  changesInEquityStatement,
  generateAndPersist,
  listGenerated
};
