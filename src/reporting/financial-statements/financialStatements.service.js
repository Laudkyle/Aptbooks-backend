const Decimal = require("decimal.js");
const { AppError } = require("../../shared/errors/AppError");
const { pool } = require("../../db/pool");
const { trialBalance: trialBalanceSvc } = require("../../core/accounting/ledger/balances.service");
const repo = require("./financialStatements.repository");
const { writeAudit } = require("../../core/foundation/audit-logs/audit.service");

function assertPeriodId(periodId) {
  if (!periodId) throw new AppError(400, "periodId is required");
}

async function getBaseCurrencyCode({ orgId }) {
  const { rows } = await pool.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  return rows[0]?.base_currency_code || "GHS";
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

function decimal(value) {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined || value === "") return new Decimal(0);
  return new Decimal(String(value));
}

function moneyDecimal(value) {
  return decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function moneyString(value) {
  return moneyDecimal(value).toFixed(2);
}

function netForStatement(row, signNormal) {
  const debit = decimal(row.debit_total || 0);
  const credit = decimal(row.credit_total || 0);
  const normal = signNormal || row.normal_balance || "debit";
  return normal === "credit" ? credit.minus(debit) : debit.minus(credit);
}

async function fetchTbMap({ orgId, periodId, mode }) {
  if (mode === "ytd") {
    const periodIds = await listPeriodsForYtd({ orgId, periodId });
    if (!periodIds.length) return new Map();
    const { rows } = await pool.query(
      `
      WITH posted_activity AS (
        SELECT
          account_id,
          SUM(debit_total) AS debit_total,
          SUM(credit_total) AS credit_total
        FROM accounting_posted_ledger_totals
        WHERE organization_id = $1
          AND period_id = ANY($2::uuid[])
        GROUP BY account_id
      )
      SELECT
        coa.id AS account_id,
        coa.code,
        coa.name,
        at.code AS account_type,
        at.normal_balance,
        COALESCE(pa.debit_total, 0) AS debit_total,
        COALESCE(pa.credit_total, 0) AS credit_total
      FROM chart_of_accounts coa
      JOIN account_types at ON at.id = coa.account_type_id
      LEFT JOIN posted_activity pa ON pa.account_id = coa.id
      WHERE coa.organization_id = $1
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
  // Minimal decimal DSL: line identifiers (L10), decimal literals, + - * / and
  // parentheses. It deliberately avoids JavaScript eval/Function so formulas
  // retain Decimal precision and cannot execute code.
  if (!expression) return new Decimal(0);
  const cleaned = String(expression).replace(/\s+/g, "");
  if (!cleaned) return new Decimal(0);

  const tokens = cleaned.match(/L\d+|\d+(?:\.\d+)?|[()+\-*/]/g) || [];
  if (tokens.join("") !== cleaned) throw new AppError(400, "Invalid formula expression");

  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];

  const parseFactor = () => {
    const token = take();
    if (token === undefined) throw new AppError(400, "Invalid formula expression");
    if (token === "+") return parseFactor();
    if (token === "-") return parseFactor().negated();
    if (token === "(") {
      const value = parseExpression();
      if (take() !== ")") throw new AppError(400, "Invalid formula expression");
      return value;
    }
    if (/^L\d+$/.test(token)) return decimal(context[token] || 0);
    if (/^\d+(?:\.\d+)?$/.test(token)) return decimal(token);
    throw new AppError(400, "Invalid formula expression");
  };

  const parseTerm = () => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      const right = parseFactor();
      if (operator === "*") value = value.times(right);
      else {
        if (right.isZero()) throw new AppError(400, "Formula division by zero");
        value = value.div(right);
      }
    }
    return value;
  };

  function parseExpression() {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const right = parseTerm();
      value = operator === "+" ? value.plus(right) : value.minus(right);
    }
    return value;
  }

  const result = parseExpression();
  if (index !== tokens.length) throw new AppError(400, "Invalid formula expression");
  return result;
}

function computeLineAmounts({ line, lineAccounts, tbMap, ctx }) {
  if (!line.is_visible) return { amount: null };

  if (line.line_type === "account") {
    let amount = new Decimal(0);
    const mapped = lineAccounts.get(line.id) || [];
    for (const m of mapped) {
      const tbRow = tbMap.get(m.account_id);
      if (!tbRow) continue;
      const normal = m.sign_override || m.normal_balance || tbRow.normal_balance;
      amount = amount.plus(netForStatement(tbRow, normal).times(decimal(m.weight || 1)));
    }
    amount = moneyDecimal(amount);
    ctx[`L${line.line_no}`] = amount;
    return { amount: amount.toFixed(2) };
  }

  if (line.line_type === "formula") {
    const amount = moneyDecimal(safeEvalFormula(line.expression, ctx));
    ctx[`L${line.line_no}`] = amount;
    return { amount: amount.toFixed(2) };
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
    const sum = kids.reduce((total, child) => total.plus(decimal(child.amount || 0)), new Decimal(0));
    if (["section", "subtotal", "total"].includes(node.line_type)) amount = moneyString(sum);
  }
  if (amount !== null && amount !== undefined) ctx[`L${node.line_no}`] = moneyDecimal(amount);

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



function accountTypeForStatementSection(sectionCode, label, statementType) {
  const section = String(sectionCode || "").toUpperCase();
  const text = String(label || "").toUpperCase();
  if (statementType === "income_statement") {
    if (section.includes("REVENUE") || text.includes("REVENUE") || text.includes("SALES")) return { accountType: "REVENUE", normal: "credit" };
    if (section.includes("EXPENSE") || section.includes("COGS") || text.includes("EXPENSE") || text.includes("COST")) return { accountType: "EXPENSE", normal: "debit" };
  }
  if (statementType === "balance_sheet") {
    if (section.includes("ASSET") || text.includes("ASSET")) return { accountType: "ASSET", normal: "debit" };
    if (section.includes("LIABIL") || text.includes("LIABIL")) return { accountType: "LIABILITY", normal: "credit" };
    if (section.includes("EQUITY") || text.includes("EQUITY") || text.includes("CAPITAL") || text.includes("RETAINED")) return { accountType: "EQUITY", normal: "credit" };
  }
  return null;
}

function normalizeLookup(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function buildLineAccountMap({ lines, mappings, tbMap, statementType }) {
  const lineAccounts = new Map();
  for (const m of mappings) {
    if (!lineAccounts.has(m.line_id)) lineAccounts.set(m.line_id, []);
    lineAccounts.get(m.line_id).push(m);
  }
  if (mappings.length) return lineAccounts;

  // Fallback for older/default templates whose line-account rows were never created.
  // This is intentionally used only when no explicit mappings exist for the selected template.
  const tbRows = Array.from(tbMap.values());
  const byExact = new Map();
  for (const row of tbRows) {
    byExact.set(normalizeLookup(row.code), row);
    byExact.set(normalizeLookup(row.name), row);
    byExact.set(normalizeLookup(`${row.code} ${row.name}`), row);
    byExact.set(normalizeLookup(`${row.code} - ${row.name}`), row);
    byExact.set(normalizeLookup(`${row.code} — ${row.name}`), row);
  }

  for (const line of lines) {
    if (line.line_type !== "account") continue;
    const matched = [];
    const exact = byExact.get(normalizeLookup(line.label));
    if (exact) matched.push(exact);

    if (!matched.length) {
      const sectionRule = accountTypeForStatementSection(line.section_code, line.label, statementType);
      const isAggregateLine = /TOTAL|REVENUE|SALES|EXPENSE|COST|ASSET|LIABIL|EQUITY|CAPITAL/i.test(String(line.label || ""));
      if (sectionRule && isAggregateLine) {
        matched.push(...tbRows.filter((row) => String(row.account_type || "").toUpperCase() === sectionRule.accountType));
      }
    }

    if (matched.length) {
      lineAccounts.set(line.id, matched.map((row) => ({
        line_id: line.id,
        account_id: row.account_id,
        weight: 1,
        sign_override: accountTypeForStatementSection(line.section_code, line.label, statementType)?.normal || row.normal_balance || null,
        normal_balance: row.normal_balance,
        account_type: row.account_type
      })));
    }
  }
  return lineAccounts;
}

function normalizeCategoryName(name, fallback) {
  const raw = String(name || "").trim();
  if (!raw) return fallback;
  const lc = raw.toLowerCase();
  if (fallback === "Current Assets" || fallback === "Non-Current Assets") {
    if (lc.includes("current") && !lc.includes("non")) return "Current Assets";
    if (lc.includes("non") || lc.includes("fixed") || lc.includes("long")) return "Non-Current Assets";
  }
  if (fallback === "Current Liabilities" || fallback === "Non-Current Liabilities") {
    if (lc.includes("current") && !lc.includes("non")) return "Current Liabilities";
    if (lc.includes("non") || lc.includes("long")) return "Non-Current Liabilities";
  }
  if (fallback === "Equity") return "Equity";
  return raw;
}

function shouldRebuildDetailedBalanceSheet(lines) {
  if (!lines.length) return true;
  const rootAssets = lines.find((l) => l.section_code === "ASSETS" && l.parent_line_id === null);
  const rootLiabs = lines.find((l) => l.section_code === "LIABILITIES" && l.parent_line_id === null);
  const hasNestedAssets = lines.some((l) => l.parent_line_id && l.section_code === "ASSETS");
  const hasNestedLiabs = lines.some((l) => l.parent_line_id && l.section_code === "LIABILITIES");
  const hasDetailSections = lines.some((l) => ["Current Assets", "Non-Current Assets", "Current Liabilities", "Non-Current Liabilities"].includes(l.label));
  return !(rootAssets && rootLiabs && hasNestedAssets && hasNestedLiabs && hasDetailSections);
}

async function ensureDefaultTemplate({ orgId, statementType }) {
  let existing = await repo.getDefaultTemplate({ orgId, statementType });

  if (existing && ["income_statement", "balance_sheet"].includes(statementType)) {
    const graph = await repo.getTemplateGraph({ orgId, templateId: existing.id });
    const isSystemDefault = String(existing.name || "").toLowerCase().startsWith("default ") || String(existing.description || "") === "System-generated default template";
    const shouldRebuildForMissingMappings = isSystemDefault && graph.lines.length > 0 && graph.mappings.length === 0;
    const shouldRebuildForShape = statementType === "balance_sheet" && shouldRebuildDetailedBalanceSheet(graph.lines);
    if (shouldRebuildForMissingMappings || shouldRebuildForShape) {
      await pool.query(`DELETE FROM statement_line_accounts WHERE line_id IN (SELECT id FROM statement_lines WHERE template_id=$1)`, [existing.id]);
      await pool.query(`DELETE FROM statement_lines WHERE template_id=$1`, [existing.id]);
      await pool.query(`DELETE FROM statement_templates WHERE id=$1`, [existing.id]);
      existing = null;
    }
  }

  if (existing) return existing;

  const tpl = await repo.createTemplate({
    orgId,
    statementType,
    name: `Default ${statementType.replace(/_/g, " ")}`,
    description: "System-generated default template"
  });

  const { rows: accounts } = await pool.query(
    `
    SELECT
      coa.id,
      coa.code,
      coa.name,
      coa.parent_account_id,
      coa.is_postable,
      at.code AS account_type,
      at.normal_balance,
      ac.name AS category_name
    FROM chart_of_accounts coa
    JOIN account_types at ON at.id = coa.account_type_id
    LEFT JOIN account_categories ac ON ac.id = coa.category_id
    WHERE coa.organization_id=$1 AND coa.status='active' AND coa.archived_at IS NULL
    ORDER BY coa.code
    `,
    [orgId]
  );

  if (!accounts.length) return tpl;

  let lineNo = 10;
  const lines = [];
  const mappings = [];

  const createLine = ({ key, label, type, parentKey = null, sectionCode = null, expression = null, drCrNormal = "auto" }) => {
    const line = {
      key,
      line_no: lineNo,
      label,
      line_type: type,
      sort_order: lineNo,
      parentKey,
      section_code: sectionCode,
      expression,
      dr_cr_normal: drCrNormal,
      is_visible: true
    };
    lineNo += 10;
    lines.push(line);
    return line;
  };

  const addLeafMappingLine = ({ key, label, parentKey, sectionCode, accountId, normalOverride }) => {
    createLine({ key, label, type: "account", parentKey, sectionCode, drCrNormal: normalOverride || "auto" });
    mappings.push({ key, account_id: accountId, weight: 1, sign_override: normalOverride || null });
  };

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const childrenByParent = new Map();
  for (const acc of accounts) {
    const k = acc.parent_account_id || "ROOT";
    if (!childrenByParent.has(k)) childrenByParent.set(k, []);
    childrenByParent.get(k).push(acc);
  }
  for (const arr of childrenByParent.values()) arr.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));

  const renderAccountTree = ({ parentAccountId, parentKey, sectionCode, normalOverride }) => {
    const children = childrenByParent.get(parentAccountId || "ROOT") || [];
    for (const acc of children) {
      const childKey = `ACC_${acc.id}`;
      const descendants = childrenByParent.get(acc.id) || [];
      if (descendants.length) {
        createLine({ key: childKey, label: acc.name, type: "section", parentKey, sectionCode, drCrNormal: normalOverride || acc.normal_balance || "auto" });
        renderAccountTree({ parentAccountId: acc.id, parentKey: childKey, sectionCode, normalOverride: normalOverride || acc.normal_balance || null });
      } else {
        addLeafMappingLine({ key: childKey, label: acc.name, parentKey, sectionCode, accountId: acc.id, normalOverride: normalOverride || acc.normal_balance || null });
      }
    }
  };

  if (statementType === "income_statement") {
    createLine({ key: "REV_SEC", label: "Revenue", type: "section", sectionCode: "REVENUE" });
    createLine({ key: "REV_TOTAL", label: "Total Revenue", type: "account", parentKey: "REV_SEC", sectionCode: "REVENUE", drCrNormal: "credit" });
    createLine({ key: "EXP_SEC", label: "Expenses", type: "section", sectionCode: "EXPENSES" });
    createLine({ key: "EXP_TOTAL", label: "Total Expenses", type: "account", parentKey: "EXP_SEC", sectionCode: "EXPENSES", drCrNormal: "debit" });
    for (const acc of accounts.filter((a) => a.account_type === "REVENUE")) mappings.push({ key: "REV_TOTAL", account_id: acc.id, weight: 1, sign_override: "credit" });
    for (const acc of accounts.filter((a) => a.account_type === "EXPENSE")) mappings.push({ key: "EXP_TOTAL", account_id: acc.id, weight: 1, sign_override: "debit" });
    createLine({ key: "NET_INC", label: "Net Income", type: "formula", expression: "L20 - L40", sectionCode: "NET_INCOME" });
  }

  if (statementType === "balance_sheet") {
    createLine({ key: "AST_SEC", label: "Assets", type: "section", sectionCode: "ASSETS" });
    createLine({ key: "AST_CUR", label: "Current Assets", type: "section", parentKey: "AST_SEC", sectionCode: "ASSETS" });
    createLine({ key: "AST_NCUR", label: "Non-Current Assets", type: "section", parentKey: "AST_SEC", sectionCode: "ASSETS" });

    createLine({ key: "LIA_SEC", label: "Liabilities", type: "section", sectionCode: "LIABILITIES" });
    createLine({ key: "LIA_CUR", label: "Current Liabilities", type: "section", parentKey: "LIA_SEC", sectionCode: "LIABILITIES" });
    createLine({ key: "LIA_NCUR", label: "Non-Current Liabilities", type: "section", parentKey: "LIA_SEC", sectionCode: "LIABILITIES" });

    createLine({ key: "EQ_SEC", label: "Equity", type: "section", sectionCode: "EQUITY" });

    const rootAssetAccounts = accounts.filter((a) => a.account_type === "ASSET" && !a.parent_account_id);
    const rootLiabilityAccounts = accounts.filter((a) => a.account_type === "LIABILITY" && !a.parent_account_id);
    const rootEquityAccounts = accounts.filter((a) => a.account_type === "EQUITY" && !a.parent_account_id);

    for (const acc of rootAssetAccounts) {
      const groupKey = normalizeCategoryName(acc.category_name, "Current Assets") === "Non-Current Assets" ? "AST_NCUR" : "AST_CUR";
      const descendants = childrenByParent.get(acc.id) || [];
      if (descendants.length) {
        const key = `ACC_${acc.id}`;
        createLine({ key, label: acc.name, type: "section", parentKey: groupKey, sectionCode: "ASSETS", drCrNormal: "debit" });
        renderAccountTree({ parentAccountId: acc.id, parentKey: key, sectionCode: "ASSETS", normalOverride: "debit" });
      } else {
        addLeafMappingLine({ key: `ACC_${acc.id}`, label: acc.name, parentKey: groupKey, sectionCode: "ASSETS", accountId: acc.id, normalOverride: "debit" });
      }
    }

    for (const acc of rootLiabilityAccounts) {
      const groupKey = normalizeCategoryName(acc.category_name, "Current Liabilities") === "Non-Current Liabilities" ? "LIA_NCUR" : "LIA_CUR";
      const descendants = childrenByParent.get(acc.id) || [];
      if (descendants.length) {
        const key = `ACC_${acc.id}`;
        createLine({ key, label: acc.name, type: "section", parentKey: groupKey, sectionCode: "LIABILITIES", drCrNormal: "credit" });
        renderAccountTree({ parentAccountId: acc.id, parentKey: key, sectionCode: "LIABILITIES", normalOverride: "credit" });
      } else {
        addLeafMappingLine({ key: `ACC_${acc.id}`, label: acc.name, parentKey: groupKey, sectionCode: "LIABILITIES", accountId: acc.id, normalOverride: "credit" });
      }
    }

    for (const acc of rootEquityAccounts) {
      const descendants = childrenByParent.get(acc.id) || [];
      if (descendants.length) {
        const key = `ACC_${acc.id}`;
        createLine({ key, label: acc.name, type: "section", parentKey: "EQ_SEC", sectionCode: "EQUITY", drCrNormal: "credit" });
        renderAccountTree({ parentAccountId: acc.id, parentKey: key, sectionCode: "EQUITY", normalOverride: "credit" });
      } else {
        addLeafMappingLine({ key: `ACC_${acc.id}`, label: acc.name, parentKey: "EQ_SEC", sectionCode: "EQUITY", accountId: acc.id, normalOverride: "credit" });
      }
    }

    createLine({ key: "AST_TOTAL", label: "Total Assets", type: "total", parentKey: "AST_SEC", sectionCode: "ASSETS", drCrNormal: "debit" });
    createLine({ key: "LIA_TOTAL", label: "Total Liabilities", type: "total", parentKey: "LIA_SEC", sectionCode: "LIABILITIES", drCrNormal: "credit" });
    createLine({ key: "EQ_TOTAL", label: "Total Equity", type: "total", parentKey: "EQ_SEC", sectionCode: "EQUITY", drCrNormal: "credit" });
    createLine({ key: "BS_CHECK", label: "Check (Assets - Liabilities - Equity)", type: "formula", expression: `L${lineNo - 30} - L${lineNo - 20} - L${lineNo - 10}`, sectionCode: "CHECK" });
  }

  if (statementType === "cash_flow") {
    createLine({ key: "CF_OP", label: "Operating Activities", type: "section", sectionCode: "OPERATING" });
    createLine({ key: "CF_INV", label: "Investing Activities", type: "section", sectionCode: "INVESTING" });
    createLine({ key: "CF_FIN", label: "Financing Activities", type: "section", sectionCode: "FINANCING" });
  }

  if (!lines.length) return tpl;

  const inserted = await repo.bulkInsertLines({
    orgId,
    templateId: tpl.id,
    lines: lines.map((l) => ({
      line_no: l.line_no,
      label: l.label,
      line_type: l.line_type,
      expression: l.expression,
      sort_order: l.sort_order,
      parent_line_id: null,
      is_visible: true,
      dr_cr_normal: l.dr_cr_normal,
      section_code: l.section_code
    }))
  });

  const keyToId = new Map();
  for (let i = 0; i < lines.length; i++) keyToId.set(lines[i].key, inserted[i].id);

  for (const l of lines) {
    if (l.parentKey) {
      await pool.query(`UPDATE statement_lines SET parent_line_id=$1 WHERE id=$2`, [keyToId.get(l.parentKey), keyToId.get(l.key)]);
    }
  }

  const finalMappings = mappings
    .map((m) => ({ line_id: keyToId.get(m.key), account_id: m.account_id, weight: m.weight, sign_override: m.sign_override }))
    .filter((m) => m.line_id && m.account_id);

  if (finalMappings.length) await repo.bulkInsertLineAccounts({ mappings: finalMappings });

  return tpl;
}

async function buildTemplateStatement({ orgId, statementType, periodId, comparePeriodId, mode }) {
  assertPeriodId(periodId);
  const tpl = await ensureDefaultTemplate({ orgId, statementType });

  const { lines, mappings } = await repo.getTemplateGraph({ orgId, templateId: tpl.id });
  const tree = buildTree(lines);

  const tbMap = await fetchTbMap({ orgId, periodId, mode });
  const cmpTbMap = comparePeriodId ? await fetchTbMap({ orgId, periodId: comparePeriodId, mode }) : null;
  const lineAccounts = buildLineAccountMap({ lines, mappings, tbMap, statementType });

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

  const baseCurrencyCode = await getBaseCurrencyCode({ orgId });
  return {
    statement_type: statementType,
    base_currency_code: baseCurrencyCode,
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
        totals: { operating: "0.00", investing: "0.00", financing: "0.00", net_change: "0.00" }
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
        AND je.status IN ('posted','voided')
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

    const totals = {
      operating: new Decimal(0),
      investing: new Decimal(0),
      financing: new Decimal(0)
    };
    const buckets = new Map();

    const addAmount = (categoryId, rawAmount) => {
      const amount = moneyDecimal(rawAmount);
      const cat = byId.get(categoryId) || unclassified;
      const catKey = cat ? cat.id : "UNMAPPED";
      if (!buckets.has(catKey)) {
        buckets.set(catKey, {
          category: cat ? { id: cat.id, section: cat.section, code: cat.code, name: cat.name } : { id: null, section: "operating", code: "UNMAPPED", name: "Unmapped" },
          amount: new Decimal(0)
        });
      }
      buckets.get(catKey).amount = buckets.get(catKey).amount.plus(amount);
      if (cat) totals[cat.section] = totals[cat.section].plus(amount);
      else totals.operating = totals.operating.plus(amount);
    };

    for (const cl of cashLines) {
      const cashChange = moneyDecimal(decimal(cl.debit || 0).minus(decimal(cl.credit || 0))); // cash accounts are debit-normal
      const others = nonCashByJournal.get(cl.journal_id) || [];
      if (!others.length) {
        addAmount(unclassified?.id, cashChange);
        continue;
      }

      const weights = others.map((other) => {
        const explicitBase = decimal(other.amount_base || 0).abs();
        if (!explicitBase.isZero()) return explicitBase;
        return decimal(other.debit || 0).plus(decimal(other.credit || 0)).abs();
      });
      const denominator = weights.reduce((sum, weight) => sum.plus(weight), new Decimal(0));

      // Round each allocation at the money boundary and assign the residual to
      // the final line. This guarantees allocations sum exactly to cashChange.
      let allocatedSoFar = new Decimal(0);
      for (let i = 0; i < others.length; i++) {
        const other = others[i];
        let allocated;
        if (i === others.length - 1) {
          allocated = cashChange.minus(allocatedSoFar);
        } else if (!denominator.isZero()) {
          allocated = moneyDecimal(cashChange.times(weights[i]).div(denominator));
          allocatedSoFar = allocatedSoFar.plus(allocated);
        } else {
          allocated = moneyDecimal(cashChange.div(others.length));
          allocatedSoFar = allocatedSoFar.plus(allocated);
        }
        const catId = mapAccountToCat.get(other.account_id) || unclassified?.id;
        addAmount(catId, allocated);
      }
    }

    const lines = Array.from(buckets.values())
      .map((row) => ({ ...row, amount: moneyString(row.amount) }))
      .sort((a, b) => {
        const sa = a.category.section;
        const sb = b.category.section;
        if (sa !== sb) return sa.localeCompare(sb);
        return a.category.name.localeCompare(b.category.name);
      });
    const netChange = totals.operating.plus(totals.investing).plus(totals.financing);
    return {
      period_id: pid,
      from: period.start_date,
      to: period.end_date,
      lines,
      totals: {
        operating: moneyString(totals.operating),
        investing: moneyString(totals.investing),
        financing: moneyString(totals.financing),
        net_change: moneyString(netChange)
      }
    };
  };

  const current = await buildOne(periodId);
  const compare = comparePeriodId ? await buildOne(comparePeriodId) : null;
  const baseCurrencyCode = await getBaseCurrencyCode({ orgId });
  return {
    statement_type: "cash_flow",
    base_currency_code: baseCurrencyCode,
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
  // Uses the same canonical posted/voided journal-line source as the other statements.
  const tb = await trialBalanceSvc({ orgId, periodId });
  let equity = new Decimal(0);
  for (const r of tb) {
    if (r.account_type !== "EQUITY") continue;
    equity = equity.plus(netForStatement(r, "credit"));
  }
  return moneyDecimal(equity);
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
      AND je.status IN ('posted','voided')
      AND je.entry_date BETWEEN $2::date AND $3::date
      AND (rem.journal_entry_type_code IS NULL OR rem.journal_entry_type_code = jet.code)
    GROUP BY rem.movement_code
    ORDER BY rem.movement_code
    `,
    [orgId, fromDate, toDate]
  );
  const map = {};
  for (const r of rows) map[r.movement_code] = moneyString(r.amount || 0);
  return map;
}

async function changesInEquityStatement({ orgId, periodId, comparePeriodId }) {
  assertPeriodId(periodId);

  const buildOne = async (pid) => {
    const p = await getPeriod({ orgId, periodId: pid });
    const prevId = await getPreviousPeriodId({ orgId, periodId: pid });
    const opening = prevId ? await equityBalanceAsOf({ orgId, periodId: prevId }) : new Decimal(0);
    const closingReported = await equityBalanceAsOf({ orgId, periodId: pid });

    // Net income from the income statement template (preferred), fallback to 0.
    const isPayload = await incomeStatement({ orgId, periodId: pid, comparePeriodId: null, mode: "period" });
    const netLine = findLineBySectionCode(isPayload.lines || [], "NET_INCOME");
    const netIncome = moneyDecimal(netLine?.amount || 0);

    const movements = await equityMovements({ orgId, fromDate: p.start_date, toDate: p.end_date });
    // Avoid double counting if retained earnings posting already included in movement mappings.
    // We treat net income as its own required component.
    const movementTotal = Object.values(movements).reduce(
      (total, value) => total.plus(decimal(value || 0)),
      new Decimal(0)
    );
    const computedClosing = moneyDecimal(opening.plus(netIncome).plus(movementTotal));
    const diff = moneyDecimal(computedClosing.minus(closingReported));

    return {
      period_id: pid,
      from: p.start_date,
      to: p.end_date,
      opening_balance: moneyString(opening),
      net_income: moneyString(netIncome),
      movements,
      total_movements: moneyString(movementTotal),
      computed_closing_balance: moneyString(computedClosing),
      reported_closing_balance: moneyString(closingReported),
      integrity: {
        difference: moneyString(diff),
        within_tolerance: diff.abs().lt("0.01")
      }
    };
  };

  const current = await buildOne(periodId);
  const compare = comparePeriodId ? await buildOne(comparePeriodId) : null;
  const baseCurrencyCode = await getBaseCurrencyCode({ orgId });
  return {
    statement_type: "changes_in_equity",
    base_currency_code: baseCurrencyCode,
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
