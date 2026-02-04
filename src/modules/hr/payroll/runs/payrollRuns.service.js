const { AppError } = require("../../../../shared/errors/AppError");
const journalIF = require("../../../../interfaces/journalPosting.interface");

const runsRepo = require("./payrollRuns.repository");
const employeesRepo = require("../../employees/employees.repository");
const assignmentsRepo = require("../employee-components/employeeComponents.repository");
const componentsRepo = require("../components/components.repository");
const statutoryRepo = require("../../statutory/statutory.repository");
const benefitsRepo = require("../../benefits/benefits.repository");

function computeDaysInclusive(startDate, endDate) {
  const ms = 24 * 60 * 60 * 1000;
  const a = new Date(startDate);
  const b = new Date(endDate);
  return Math.floor((b - a) / ms) + 1;
}

function computeBaseSalaryForPeriod(employee, period) {
  const amount = Number(employee.base_salary_amount || 0);
  if (!amount) return 0;

  const freq = employee.base_salary_frequency || "monthly";
  if (freq === "monthly") return amount;
  const days = computeDaysInclusive(period.start_date, period.end_date);
  if (freq === "daily") return amount * days;
  if (freq === "weekly") return amount * (days / 7);
  return amount;
}

function computeProgressiveAmount(amount, brackets) {
  const taxable = Number(amount || 0);
  if (!taxable || !Array.isArray(brackets) || !brackets.length) return 0;

  const sorted = [...brackets].sort((x, y) => {
    const ax = x.up_to === null || x.up_to === undefined ? Number.POSITIVE_INFINITY : Number(x.up_to);
    const ay = y.up_to === null || y.up_to === undefined ? Number.POSITIVE_INFINITY : Number(y.up_to);
    return ax - ay;
  });

  let tax = 0;
  let prev = 0;

  for (const b of sorted) {
    const limit = b.up_to === null || b.up_to === undefined ? Number.POSITIVE_INFINITY : Number(b.up_to);
    const top = Math.min(taxable, limit);
    const slice = Math.max(0, top - prev);
    if (slice > 0) {
      tax += slice * normalizeRate(b.rate);
    }
    prev = limit;
    if (taxable <= limit) break;
  }

  return tax;
}

function normalizeRate(rate) {
  // Accept either percentage (e.g., 5.5) or fraction (e.g., 0.055)
  const r = Number(rate || 0);
  if (!r) return 0;
  return r > 1 ? r / 100 : r;
}

function applyCap(amount, capAmount) {
  const cap = capAmount === null || capAmount === undefined ? null : Number(capAmount);
  if (cap === null || Number.isNaN(cap) || cap <= 0) return amount;
  return Math.min(Number(amount || 0), cap);
}

async function createRun({ orgId, actorUserId, payload }) {
  return runsRepo.createRun(orgId, actorUserId, payload);
}

async function listRuns({ orgId, query }) {
  return runsRepo.listRuns(orgId, query);
}

async function getRun({ orgId, runId }) {
  const run = await runsRepo.getRun(orgId, runId);
  if (!run) throw new AppError(404, "Payroll run not found");
  return run;
}

async function listRunLines({ orgId, runId }) {
  return runsRepo.listRunLines(orgId, runId);
}

async function calculateRun({ orgId, actorUserId, runId }) {
  const run = await getRun({ orgId, runId });
  if (!["draft", "calculated"].includes(run.status)) {
    throw new AppError(409, "Payroll run must be in draft or calculated status");
  }

  const period = await runsRepo.getPeriod(orgId, run.period_id);
  if (!period) throw new AppError(400, "Invalid period_id");
  if (period.status !== "open") throw new AppError(409, "Accounting period not open");

  const employees = await employeesRepo.listEmployees(orgId, { status: "active" });

  const allAssignments = await assignmentsRepo.listAssignments(orgId, { status: "active" });
  const assignmentByEmployee = new Map();
  for (const a of allAssignments) {
    const k = String(a.employee_id);
    if (!assignmentByEmployee.has(k)) assignmentByEmployee.set(k, []);
    assignmentByEmployee.get(k).push(a);
  }

  // Build a lookup of components
  const components = await componentsRepo.listComponents(orgId, { status: "active" });
  const componentById = new Map(components.map((c) => [String(c.id), c]));

  // Statutory rules and benefits effective as of run pay date
  const statutoryRules = await statutoryRepo.listRules(orgId, { status: "active" });
  const employeeBenefits = await benefitsRepo.listEmployeeBenefitsEffective(orgId, run.pay_date);
  const benefitsByEmployee = new Map();
  for (const eb of employeeBenefits) {
    const k = String(eb.employee_id);
    if (!benefitsByEmployee.has(k)) benefitsByEmployee.set(k, []);
    benefitsByEmployee.get(k).push(eb);
  }

  const lines = [];
  for (const e of employees) {
    const base = computeBaseSalaryForPeriod(e, period);
    const assignments = assignmentByEmployee.get(String(e.id)) || [];

    let earnings = 0;
    let deductions = 0;
    let employerContrib = 0;

    const breakdown = {
      base_salary: base,
      earnings: [],
      deductions: [],
      statutory: [],
      benefits: [],
      employer_contributions_total: 0,
    };

    for (const a of assignments) {
      const c = componentById.get(String(a.component_id));
      if (!c) continue;
      let amt = 0;
      if (c.calculation_method === "percent_base") {
        const pct = Number(a.percent ?? 0);
        amt = (base * pct) / 100;
      } else {
        amt = Number(a.amount ?? 0);
      }
      if (!amt) continue;

      if (c.kind === "earning") {
        earnings += amt;
        breakdown.earnings.push({ component_id: c.id, code: c.code, amount: amt });
      } else {
        deductions += amt;
        breakdown.deductions.push({ component_id: c.id, code: c.code, amount: amt });
      }
    }

    // Statutory deductions/contributions (percent of base or gross)
    // Rates may be provided as percent (e.g., 5.5) or fraction (0.055).
    for (const r of statutoryRules) {
      const baseOn = r.base_on || "base";
      const basis = baseOn === "gross" ? (base + earnings) : base;
      if (!basis) continue;

      let empAmt = 0;
      let emprAmt = 0;

      if (r.rule_type === "income_tax" && (r.calculation_method || "flat") === "progressive") {
        const allowance = Number(r.allowance_amount || 0);
        const taxable = Math.max(0, Number(basis) - allowance);
        const brackets = r.brackets_json || r.brackets || [];
        empAmt = applyCap(computeProgressiveAmount(taxable, brackets), r.cap_amount);
        emprAmt = 0;
      } else {
        empAmt = applyCap(basis * normalizeRate(r.employee_rate), r.cap_amount);
        emprAmt = applyCap(basis * normalizeRate(r.employer_rate), r.cap_amount);
      }

      if (empAmt) deductions += empAmt;
      if (emprAmt) employerContrib += emprAmt;

      if (empAmt || emprAmt) {
        breakdown.statutory.push({
          rule_id: r.id,
          code: r.code,
          name: r.name,
          rule_type: r.rule_type,
          employee_amount: empAmt ? Number(empAmt) : 0,
          employer_amount: emprAmt ? Number(emprAmt) : 0,
          expense_account_id: r.expense_account_id,
          liability_account_id: r.liability_account_id,
        });
      }
    }

    // Benefits (employee and employer rates)
    const eBenefits = benefitsByEmployee.get(String(e.id)) || [];
    for (const b of eBenefits) {
      const baseOn = b.base_on || "base";
      const basis = baseOn === "gross" ? (base + earnings) : base;
      if (!basis) continue;

      const empAmt = applyCap(basis * normalizeRate(b.employee_rate), b.cap_amount);
      const emprAmt = applyCap(basis * normalizeRate(b.employer_rate), b.cap_amount);

      if (empAmt) deductions += empAmt;
      if (emprAmt) employerContrib += emprAmt;

      if (empAmt || emprAmt) {
        breakdown.benefits.push({
          code: b.plan_code,
          plan_name: b.plan_name,
          employee_amount: empAmt ? Number(empAmt) : 0,
          employer_amount: emprAmt ? Number(emprAmt) : 0,
          expense_account_id: b.expense_account_id,
          liability_account_id: b.liability_account_id,
        });
      }
    }

    const gross = base + earnings;
    const net = gross - deductions;

    breakdown.employer_contributions_total = employerContrib;

    lines.push({
      employee_id: e.id,
      base_salary: base,
      total_earnings: earnings,
      total_deductions: deductions,
      employer_contributions: employerContrib,
      gross_pay: gross,
      net_pay: net,
      currency: run.currency || e.base_salary_currency || "GHS",
      breakdown,
    });
  }

  await runsRepo.replaceRunLines(orgId, runId, lines);
  await runsRepo.setRunStatus(orgId, runId, "calculated", actorUserId);

  return { runId, status: "calculated", linesCount: lines.length };
}

function round2(n) {
  return Number(Number(n).toFixed(2));
}

async function buildJournal({ orgId, actorUserId, runId, idempotencyKey }) {
  const run = await getRun({ orgId, runId });
  if (run.status !== "calculated") {
    throw new AppError(409, "Run must be calculated before building a journal");
  }

  const existing = await runsRepo.getRunJournal(orgId, runId);
  if (existing?.journal_entry_id) {
    return { runId, journalId: existing.journal_entry_id, status: existing.journal_status || "draft" };
  }

  const period = await runsRepo.getPeriod(orgId, run.period_id);
  if (!period) throw new AppError(400, "Invalid period_id");
  if (period.status !== "open") throw new AppError(409, "Accounting period not open");

  const lines = await runsRepo.listRunLines(orgId, runId);
  if (!lines.length) throw new AppError(400, "No payroll run lines found");

  // Load employees for account mapping
  const employeeIds = lines.map((l) => l.employee_id);
  const employees = await runsRepo.getEmployeesForIds(orgId, employeeIds);
  const empById = new Map(employees.map((e) => [String(e.id), e]));

  // Load components to map deductions -> liability accounts
  const components = await componentsRepo.listComponents(orgId, { status: "active" });
  const compByCode = new Map(components.map((c) => [String(c.code), c]));

  // Aggregate amounts
  const debitByAccount = new Map();
  const creditByAccount = new Map();

  for (const l of lines) {
    const e = empById.get(String(l.employee_id));
    if (!e) continue;
    if (!e.expense_account_id) throw new AppError(400, `Employee missing expense_account_id: ${e.employee_no}`);
    if (!e.payable_account_id) throw new AppError(400, `Employee missing payable_account_id: ${e.employee_no}`);

    const totalExpense = Number(l.gross_pay || 0);
    const net = Number(l.net_pay || 0);
    debitByAccount.set(String(e.expense_account_id), (debitByAccount.get(String(e.expense_account_id)) || 0) + totalExpense);
    creditByAccount.set(String(e.payable_account_id), (creditByAccount.get(String(e.payable_account_id)) || 0) + net);

    // Deductions: credit liability accounts
    const b = l.breakdown_json || l.breakdown || null;
    const deductions = (b && b.deductions) || [];
    const statutory = (b && b.statutory) || [];
    const benefits = (b && b.benefits) || [];

    // Standard payroll component deductions
    for (const d of deductions) {
      const code = String(d.code || "");
      const c = compByCode.get(code);
      const liabilityAccountId = d.liability_account_id || c?.liability_account_id;
      if (!liabilityAccountId) {
        throw new AppError(400, `Deduction ${code || '(unknown)'} missing liability_account_id`);
      }
      creditByAccount.set(String(liabilityAccountId), (creditByAccount.get(String(liabilityAccountId)) || 0) + Number(d.amount || 0));
    }

    // Statutory and benefits: employee portion behaves like a deduction (credit liability)
    for (const s of statutory) {
      const empAmt = Number(s.employee_amount || 0);
      if (!empAmt) continue;
      if (!s.liability_account_id) throw new AppError(400, `Statutory ${s.code} missing liability_account_id`);
      creditByAccount.set(String(s.liability_account_id), (creditByAccount.get(String(s.liability_account_id)) || 0) + empAmt);
    }
    for (const bn of benefits) {
      const empAmt = Number(bn.employee_amount || 0);
      if (!empAmt) continue;
      if (!bn.liability_account_id) throw new AppError(400, `Benefit ${bn.code} missing liability_account_id`);
      creditByAccount.set(String(bn.liability_account_id), (creditByAccount.get(String(bn.liability_account_id)) || 0) + empAmt);
    }

    // Employer contributions: debit expense, credit liability
    for (const s of statutory) {
      const emprAmt = Number(s.employer_amount || 0);
      if (!emprAmt) continue;
      if (!s.expense_account_id) throw new AppError(400, `Statutory ${s.code} missing expense_account_id`);
      if (!s.liability_account_id) throw new AppError(400, `Statutory ${s.code} missing liability_account_id`);
      debitByAccount.set(String(s.expense_account_id), (debitByAccount.get(String(s.expense_account_id)) || 0) + emprAmt);
      creditByAccount.set(String(s.liability_account_id), (creditByAccount.get(String(s.liability_account_id)) || 0) + emprAmt);
    }
    for (const bn of benefits) {
      const emprAmt = Number(bn.employer_amount || 0);
      if (!emprAmt) continue;
      if (!bn.expense_account_id) throw new AppError(400, `Benefit ${bn.code} missing expense_account_id`);
      if (!bn.liability_account_id) throw new AppError(400, `Benefit ${bn.code} missing liability_account_id`);
      debitByAccount.set(String(bn.expense_account_id), (debitByAccount.get(String(bn.expense_account_id)) || 0) + emprAmt);
      creditByAccount.set(String(bn.liability_account_id), (creditByAccount.get(String(bn.liability_account_id)) || 0) + emprAmt);
    }
  }

  const journalLines = [];
  for (const [accountId, amount] of debitByAccount.entries()) {
    if (round2(amount) === 0) continue;
    journalLines.push({ accountId, debit: round2(amount), credit: 0, description: "Payroll expense" });
  }
  for (const [accountId, amount] of creditByAccount.entries()) {
    if (round2(amount) === 0) continue;
    journalLines.push({ accountId, debit: 0, credit: round2(amount), description: "Payroll payable/liability" });
  }

  // Ensure balanced
  const sumD = round2(journalLines.reduce((a, x) => a + Number(x.debit || 0), 0));
  const sumC = round2(journalLines.reduce((a, x) => a + Number(x.credit || 0), 0));
  if (sumD !== sumC) {
    throw new AppError(400, `Payroll journal not balanced (debit=${sumD}, credit=${sumC}). Check deduction configuration.`);
  }

  const draft = await journalIF.createDraftJournal({
    orgId,
    actorUserId,
    payload: {
      periodId: run.period_id,
      entryDate: run.pay_date,
      memo: `Payroll run ${run.id}`,
      idempotencyKey: idempotencyKey || null,
      typeCode: "GENERAL",
      lines: journalLines,
    },
  });

  await runsRepo.linkRunJournal(orgId, runId, draft.journalId, actorUserId);

  return { runId, journalId: draft.journalId, status: "draft" };
}

async function postJournal({ orgId, actorUserId, runId }) {
  const run = await getRun({ orgId, runId });
  const link = await runsRepo.getRunJournal(orgId, runId);
  if (!link?.journal_entry_id) throw new AppError(400, "No journal built for this payroll run");

  const posted = await journalIF.postDraftJournal({ orgId, journalId: link.journal_entry_id, actorUserId });
  await runsRepo.markJournalPosted(orgId, runId, link.journal_entry_id, actorUserId);
  await runsRepo.setRunStatus(orgId, runId, "posted", actorUserId);
  return { runId, journalId: posted.journalId, status: "posted" };
}

module.exports = {
  createRun,
  listRuns,
  getRun,
  calculateRun,
  buildJournal,
  postJournal,
  listRunLines,
};
