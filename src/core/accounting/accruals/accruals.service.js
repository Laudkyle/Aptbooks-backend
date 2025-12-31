const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");

const periodIF = require("../../../interfaces/periodManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");

// --------------------------
// Helpers for DEFERRAL rules
// --------------------------
function assertDeferralRuleShape({ rule, lines }) {
  if (rule.rule_type !== "DEFERRAL")
    throw new AppError(500, "Internal: not a DEFERRAL rule");
  // v1 strictness: exactly 2 lines, one debit and one credit, both fixed
  if (!Array.isArray(lines) || lines.length !== 2) {
    throw new AppError(
      400,
      "DEFERRAL rules must have exactly 2 lines (1 debit, 1 credit)"
    );
  }
  const debitLines = lines.filter((l) => l.dc === "debit");
  const creditLines = lines.filter((l) => l.dc === "credit");
  if (debitLines.length !== 1 || creditLines.length !== 1) {
    throw new AppError(
      400,
      "DEFERRAL rules must have exactly 1 debit line and 1 credit line"
    );
  }
  for (const l of lines) {
    if (l.amount_type !== "fixed")
      throw new AppError(400, "DEFERRAL v1 supports fixed amount_type only");
    if (!(Number(l.amount_value) > 0))
      throw new AppError(400, "amount_value must be > 0");
  }
}

// Build journal lines from rule lines. If amountOverride is provided, it replaces amount_value.
function buildJournalLinesFromRuleLines({
  ruleLines,
  amountOverride,
  memoSuffix,
}) {
  return ruleLines
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) => {
      const amt =
        amountOverride != null
          ? Number(amountOverride)
          : Number(l.amount_value);
      const debit = l.dc === "debit" ? amt : 0;
      const credit = l.dc === "credit" ? amt : 0;
      return {
        accountId: l.account_id,
        debit,
        credit,
        description: (l.description || memoSuffix || "").trim() || null,
      };
    });
}
function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sumFixedLines(lines) {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    const amt = Number(l.amountValue || 0);
    if (l.dc === "debit") debit += amt;
    else credit += amt;
  }
  debit = Number(debit.toFixed(2));
  credit = Number(credit.toFixed(2));
  return { debit, credit };
}
function parseYMD(input, fieldName = "date") {
  // Accept: "YYYY-MM-DD" OR JS Date object
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime()))
      throw new AppError(400, `Invalid ${fieldName}`);
    return new Date(
      Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate())
    );
  }

  if (typeof input === "string") {
    // Strict YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      throw new AppError(
        400,
        `Invalid ${fieldName}: ${input} (expected YYYY-MM-DD)`
      );
    }
    const d = new Date(`${input}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()))
      throw new AppError(400, `Invalid ${fieldName}: ${input}`);
    return d;
  }

  if (input == null) return null;

  throw new AppError(400, `Invalid ${fieldName} type`);
}

async function assertPostableActiveAccount({ orgId, accountId }) {
  const { rows } = await pool.query(
    `SELECT is_postable, status FROM chart_of_accounts WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, "Invalid accountId in rule line");
  if (!rows[0].is_postable)
    throw new AppError(400, "Non-postable account used in rule line");
  if (rows[0].status !== "active")
    throw new AppError(400, "Inactive account used in rule line");
}

/**
 * Create an accrual rule + lines.
 * payload example:
 * {
 *   code, name,
 *   ruleType: 'REVERSING'|'RECURRING'|'DEFERRAL'|'DERIVED',
 *   frequency: 'DAILY'|'WEEKLY'|'MONTHLY'|'PERIOD_END'|'ON_DEMAND',
 *   autoReverse, reverseTiming,
 *   startDate, endDate,
 *   status: 'active'|'inactive',
 *   isRequired: boolean,
 *   lines: [{ lineNo?, accountId, dc:'debit'|'credit', amountValue, description }]
 * }
 */
async function createRule({ orgId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Basic bounds validation
    if (payload.startDate && payload.endDate) {
      const sd = parseYMD(payload.startDate);
      const ed = parseYMD(payload.endDate);
      if (ed < sd) throw new AppError(400, "endDate must be >= startDate");
    }

    // REVERSING rules should be consistent
    if (payload.ruleType === "REVERSING") {
      if (!payload.autoReverse)
        throw new AppError(400, "REVERSING rules must have autoReverse=true");
      if (
        payload.reverseTiming &&
        payload.reverseTiming !== "NEXT_PERIOD_START"
      ) {
        throw new AppError(400, "reverseTiming must be NEXT_PERIOD_START");
      }
    }

    // Validate lines
    const lines = payload.lines || [];
    if (!Array.isArray(lines) || lines.length === 0)
      throw new AppError(400, "lines required");

    // Normalize and validate each line
    const normalized = lines.map((l, idx) => ({
      lineNo: Number(l.lineNo || idx + 1),
      accountId: l.accountId,
      dc: l.dc,
      amountValue: Number(l.amountValue || 0),
      description: l.description || null,
    }));

    for (const l of normalized) {
      if (!l.accountId) throw new AppError(400, "line.accountId required");
      if (l.dc !== "debit" && l.dc !== "credit")
        throw new AppError(400, "line.dc must be debit|credit");
      if (!Number.isFinite(l.amountValue) || l.amountValue <= 0)
        throw new AppError(400, "line.amountValue must be > 0");
      await assertPostableActiveAccount({ orgId, accountId: l.accountId });
    }

    // Balance check (fixed-only v1)
    const totals = sumFixedLines(normalized);
    if (totals.debit !== totals.credit) {
      throw new AppError(
        400,
        `Rule lines not balanced (debit=${totals.debit}, credit=${totals.credit})`
      );
    }

    const { rows: rRows } = await client.query(
      `
      INSERT INTO accrual_rules(
        organization_id, code, name, rule_type, frequency,
        auto_reverse, reverse_timing, start_date, end_date, status, is_required,
        created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
      RETURNING *
      `,
      [
        orgId,
        payload.code,
        payload.name,
        payload.ruleType,
        payload.frequency,
        Boolean(payload.autoReverse),
        payload.reverseTiming || null,
        payload.startDate || null,
        payload.endDate || null,
        payload.status || "active",
        Boolean(payload.isRequired),
      ]
    );

    const rule = rRows[0];

    for (const l of normalized) {
      await client.query(
        `
        INSERT INTO accrual_rule_lines(
          accrual_rule_id, line_no, account_id, dc, amount_type, amount_value, description
        )
        VALUES ($1,$2,$3,$4,'fixed',$5,$6)
        `,
        [rule.id, l.lineNo, l.accountId, l.dc, l.amountValue, l.description]
      );
    }
    // If DEFERRAL: create/update schedule (optional)
    if (payload.ruleType === "DEFERRAL" && payload.deferralSchedule) {
      const { totalAmount, periodCount, startPeriodId } =
        payload.deferralSchedule;

      // Ensure rule lines are valid for DEFERRAL
      const { rows: ruleLines } = await client.query(
        `SELECT line_no, account_id, dc, amount_type, amount_value, description
     FROM accrual_rule_lines WHERE accrual_rule_id=$1 ORDER BY line_no`,
        [rule.id]
      );

      assertDeferralRuleShape({
        rule: { rule_type: "DEFERRAL" },
        lines: ruleLines.map((x) => ({
          ...x,
          amount_type: x.amount_type,
          amount_value: x.amount_value,
        })),
      });

      // Initialise schedule as active
      await client.query(
        `
    INSERT INTO accrual_schedules
      (accrual_rule_id, total_amount, remaining_amount, recognition_method, period_count, start_period_id, status)
    VALUES
      ($1,$2,$2,'straight_line',$3,$4,'active')
    ON CONFLICT (accrual_rule_id)
    DO UPDATE SET
      total_amount=EXCLUDED.total_amount,
      remaining_amount=EXCLUDED.remaining_amount,
      period_count=EXCLUDED.period_count,
      start_period_id=EXCLUDED.start_period_id,
      status='active',
      updated_at=NOW()
    `,
        [rule.id, totalAmount, periodCount, startPeriodId]
      );
    }

    await client.query("COMMIT");
    return rule;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listRules({ orgId }) {
  const { rows } = await pool.query(
    `SELECT * FROM accrual_rules WHERE organization_id=$1 ORDER BY created_at DESC`,
    [orgId]
  );
  return rows;
}

async function runDeferralRecognitions({ orgId, actorUserId, periodId }) {
  // 0) Read target period (NO FOR UPDATE here)
  const { rows: pRows } = await pool.query(
    `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!pRows.length) throw new AppError(400, "Invalid periodId");
  const period = pRows[0];
  if (period.status !== "open") throw new AppError(409, "Period is not open");

  // 1) Find eligible schedules (NO FOR UPDATE here; we claim per schedule later)
  const { rows: schedules } = await pool.query(
    `
    SELECT
      s.id AS schedule_id,
      s.accrual_rule_id,
      s.total_amount,
      s.remaining_amount,
      s.period_count,
      s.start_period_id,
      sp.start_date AS schedule_start_date,
      r.code AS rule_code,
      r.name AS rule_name
    FROM accrual_schedules s
    JOIN accrual_rules r ON r.id = s.accrual_rule_id
    JOIN accounting_periods sp ON sp.id = s.start_period_id AND sp.organization_id=$1
    WHERE r.organization_id=$1
      AND r.status='active'
      AND r.rule_type='DEFERRAL'
      AND s.status='active'
      AND s.remaining_amount > 0
      AND sp.start_date <= $2::date
    ORDER BY r.code ASC
    `,
    [orgId, period.start_date]
  );

  const results = [];

  for (const s of schedules) {
    const totalAmount = Number(s.total_amount);
    const remaining = Number(s.remaining_amount);
    const periodCount = Number(s.period_count || 0);
    if (!(periodCount > 0)) continue;

    const perPeriod = Number((totalAmount / periodCount).toFixed(2));
    const recognitionAmount = Number(Math.min(perPeriod, remaining).toFixed(2));
    if (!(recognitionAmount > 0)) {
      // tiny rounding residue: mark complete safely
      await pool.query(
        `UPDATE accrual_schedules SET status='complete', remaining_amount=0, updated_at=NOW() WHERE id=$1 AND status='active'`,
        [s.schedule_id]
      );
      continue;
    }

    // 2) Claim/create run in a short transaction (no journal posting here)
    let runId = null;
    let alreadyRan = false;

    {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Lock schedule row to prevent concurrent decrements
        const { rows: lockedSched } = await client.query(
          `SELECT id, remaining_amount, status FROM accrual_schedules WHERE id=$1 FOR UPDATE`,
          [s.schedule_id]
        );
        if (!lockedSched.length || lockedSched[0].status !== "active") {
          await client.query("ROLLBACK");
          continue;
        }

        // Insert accrual run once per (org, rule, period, date)
        // Your uq_accrual_runs_once / uq_accrual_runs_once-like index should block duplicates.
        try {
          const { rows: runRows } = await client.query(
            `
           INSERT INTO accrual_runs
            (organization_id, accrual_rule_id, schedule_id, period_id, as_of_date, status, started_at)
              VALUES ($1,$2,$3,$4,$5,'running',NOW())
              RETURNING id

            `,
            [
              orgId,
              s.accrual_rule_id,
              s.schedule_id,
              period.id,
              period.end_date,
            ]
          );
          runId = runRows[0].id;
        } catch (e) {
          if (String(e.code) === "23505") {
            alreadyRan = true;
          } else {
            throw e;
          }
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        client.release();
        throw e;
      } finally {
        client.release();
      }
    }

    if (alreadyRan) {
      results.push({
        scheduleId: s.schedule_id,
        ruleId: s.accrual_rule_id,
        periodId: period.id,
        status: "skipped",
        reason: "already_ran_for_period",
      });

      continue;
    }
  
    // 3) Load rule + lines (outside any lock-heavy tx)
    const { rows: ruleRows } = await pool.query(
      `SELECT id, rule_type, frequency, status, code, name
       FROM accrual_rules WHERE organization_id=$1 AND id=$2`,
      [orgId, s.accrual_rule_id]
    );
    if (!ruleRows.length) {
      // mark run failed
      await pool.query(
        `UPDATE accrual_runs SET status='failed', failed_at=NOW(), failure_reason=$3, failure_count=failure_count+1, completed_at=NOW()
         WHERE organization_id=$1 AND id=$2`,
        [orgId, runId, "rule_not_found"]
      );
      continue;
    }
    const rule = ruleRows[0];

    const { rows: ruleLines } = await pool.query(
      `SELECT line_no, account_id, dc, amount_type, amount_value, description
       FROM accrual_rule_lines WHERE accrual_rule_id=$1 ORDER BY line_no`,
      [rule.id]
    );

    try {
      assertDeferralRuleShape({ rule, lines: ruleLines });
    } catch (e) {
      await pool.query(
        `UPDATE accrual_runs SET status='failed', failed_at=NOW(), failure_reason=$3, failure_count=failure_count+1, completed_at=NOW(), error=$4
         WHERE organization_id=$1 AND id=$2`,
        [orgId, runId, "invalid_deferral_rule_shape", String(e.message || e)]
      );
      continue;
    }

    const journalLines = buildJournalLinesFromRuleLines({
      ruleLines,
      amountOverride: recognitionAmount,
      memoSuffix: `Deferral ${rule.code}`,
    });

    const debitTotal = Number(
      journalLines.reduce((a, l) => a + Number(l.debit || 0), 0).toFixed(2)
    );
    const creditTotal = Number(
      journalLines.reduce((a, l) => a + Number(l.credit || 0), 0).toFixed(2)
    );
    if (debitTotal !== creditTotal) {
      await pool.query(
        `UPDATE accrual_runs SET status='failed', failed_at=NOW(), failure_reason=$3, failure_count=failure_count+1, completed_at=NOW()
         WHERE organization_id=$1 AND id=$2`,
        [orgId, runId, "journal_not_balanced"]
      );
      continue;
    }

    // 4) Post journal via kernel interface (safe: no outer tx holding locks)
    const idempotencyKey = `accrual:deferral:${s.schedule_id}:${period.id}`;

    let posted;
    try {
      const draft = await journalIF.createDraftJournal({
        orgId,
        actorUserId,
        payload: {
          periodId: period.id,
          entryDate: period.end_date,
          typeCode: "ADJUSTMENT",
          memo: `Deferral recognition (${rule.code}) - ${rule.name}`,
          idempotencyKey,
          lines: journalLines,
        },
      });

      posted = await journalIF.postDraftJournal({
        orgId,
        journalId: draft.journalId,
        actorUserId,
      });
    } catch (e) {
      // Persist failure on run (do NOT change schedule)
      await pool.query(
        `UPDATE accrual_runs
         SET status='failed',
             failed_at=NOW(),
             failure_reason=$3,
             error=$4,
             failure_count=failure_count+1,
             completed_at=NOW()
         WHERE organization_id=$1 AND id=$2`,
        [orgId, runId, "journal_post_failed", String(e.message || e)]
      );
      continue;
    }

    // 5) Link posting + decrement schedule in a short transaction
    {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Link run → journal (idempotent)
        await client.query(
          `
          INSERT INTO accrual_run_postings(accrual_run_id, journal_entry_id)
          VALUES ($1,$2)
          ON CONFLICT (accrual_run_id) DO NOTHING
          `,
          [runId, posted.journalId]
        );

        // Mark run posted
        await client.query(
          `
          UPDATE accrual_runs
          SET status='posted', completed_at=NOW()
          WHERE organization_id=$1 AND id=$2
          `,
          [orgId, runId]
        );

       // Decrement schedule safely using current DB value (prevents double-decrement)
const { rows: schedNow } = await client.query(
  `SELECT remaining_amount FROM accrual_schedules WHERE id=$1 FOR UPDATE`,
  [s.schedule_id]
);

if (schedNow.length) {
  const nowRemaining = Number(schedNow[0].remaining_amount);
  const newRemainingValue = Number((nowRemaining - recognitionAmount).toFixed(2));
  
  // Ensure it doesn't go negative
  const finalRemaining = Math.max(0, newRemainingValue);
  await client.query(
  `
  UPDATE accrual_schedules
  SET remaining_amount=$2::numeric,
      status = CASE WHEN $2::numeric <= 0 THEN 'complete' ELSE status END,
      updated_at=NOW()
  WHERE id=$1
  `,
  [s.schedule_id, finalRemaining]
);
}

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        // Important: journal is posted but schedule update failed.
        // This should be alerted (operator can reconcile by recomputing remaining).
        await pool.query(
          `UPDATE accrual_runs
           SET error = COALESCE(error,'') || $3
           WHERE organization_id=$1 AND id=$2`,
          [orgId, runId, ` | schedule_update_failed: ${String(e.message || e)}`]
        );
        throw e;
      } finally {
        client.release();
      }
    }

    results.push({
      scheduleId: s.schedule_id,
      ruleId: rule.id,
      periodId: period.id,
      runId,
      journalId: posted.journalId,
      recognitionAmount,
    });
  }

  return results;
}

async function getRuleWithLines({ orgId, ruleId }) {
  const { rows: r } = await pool.query(
    `SELECT * FROM accrual_rules WHERE organization_id=$1 AND id=$2`,
    [orgId, ruleId]
  );
  if (!r.length) throw new AppError(404, "Accrual rule not found");

  const { rows: lines } = await pool.query(
    `SELECT * FROM accrual_rule_lines WHERE accrual_rule_id=$1 ORDER BY line_no`,
    [ruleId]
  );
  return { rule: r[0], lines };
}

/**
 * Core runner: posts one rule for a given asOfDate.
 * - Finds open period for date (or uses periodIdOverride if provided)
 * - Idempotent: if a run exists and posted/reversed/skipped => returns skipped
 * - Uses advisory transaction lock to prevent duplicates without requiring a DB unique constraint
 */
async function runOne({
  orgId,
  actorUserId,
  ruleId,
  asOfDate,
  periodIdOverride = null,
}) {
  const asOf = parseYMD(asOfDate);
  const asOfYMD = ymd(asOf);

  const { rule, lines } = await getRuleWithLines({ orgId, ruleId });

  // Bounds
  if (rule.start_date) {
    const sd = parseYMD(ymd(parseYMD(rule.start_date)));
    if (asOf < sd)
      return {
        skipped: true,
        reason: "Before rule start_date",
        ruleId,
        asOfDate: asOfYMD,
      };
  }
  if (rule.end_date) {
    const ed = parseYMD(ymd(parseYMD(rule.end_date)));
    if (asOf > ed)
      return {
        skipped: true,
        reason: "After rule end_date",
        ruleId,
        asOfDate: asOfYMD,
      };
  }

  // Determine period
  let period = null;
  if (periodIdOverride) {
    const { rows: p } = await pool.query(
      `SELECT * FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
      [orgId, periodIdOverride]
    );
    if (!p.length) throw new AppError(400, "Invalid periodId");
    if (p[0].status !== "open")
      return {
        skipped: true,
        reason: "Target period not open",
        ruleId,
        asOfDate: asOfYMD,
      };
    period = p[0];
  } else {
    // Graceful skip if no open period covers date
    try {
      period = await periodIF.findOpenPeriodForDate({ orgId, date: asOfYMD });
      if (!period)
        return {
          skipped: true,
          reason: "No open period for date",
          ruleId,
          asOfDate: asOfYMD,
        };
    } catch (_) {
      return {
        skipped: true,
        reason: "No open period for date",
        ruleId,
        asOfDate: asOfYMD,
      };
    }
  }

  // v1: fixed-only rule line totals
  const totals = sumFixedLines(
    lines.map((l) => ({
      dc: l.dc,
      amountValue: Number(l.amount_value || 0),
    }))
  );
  if (totals.debit !== totals.credit) {
    // This should not happen if createRule validated, but keep it defensive
    throw new AppError(500, "Accrual rule lines are not balanced");
  }

  // Prepare journal lines
  const journalLines = lines.map((l) => ({
    accountId: l.account_id,
    debit: l.dc === "debit" ? Number(l.amount_value) : 0,
    credit: l.dc === "credit" ? Number(l.amount_value) : 0,
    description: l.description || rule.name,
  }));

  const idempotencyKey = `accrual:post:${ruleId}:${period.id}:${asOfYMD}`;

  const client = await pool.connect();
  let runRow = null;

  try {
    await client.query("BEGIN");

    // Advisory lock for (orgId, ruleId, periodId, asOfDate) to prevent concurrent duplicates
    // Uses hashtext which is stable; suitable for xact lock.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `accrual_run:${orgId}:${ruleId}:${period.id}:${asOfYMD}`,
    ]);

    // If run already exists, return idempotently
    const { rows: existing } = await client.query(
      `
      SELECT * FROM accrual_runs
      WHERE organization_id=$1 AND accrual_rule_id=$2 AND period_id=$3 AND as_of_date=$4
      LIMIT 1
      `,
      [orgId, ruleId, period.id, asOfYMD]
    );

    if (existing.length) {
      const ex = existing[0];
      if (["posted", "reversed", "skipped"].includes(ex.status)) {
        await client.query("COMMIT");
        return {
          skipped: true,
          reason: `Already ${ex.status}`,
          runId: ex.id,
          ruleId,
          asOfDate: asOfYMD,
        };
      }
      runRow = ex;
    } else {
      const { rows: created } = await client.query(
        `
        INSERT INTO accrual_runs(
          organization_id, accrual_rule_id, period_id, as_of_date, status, started_at, created_at
        )
        VALUES ($1,$2,$3,$4,'running',NOW(),NOW())
        RETURNING *
        `,
        [orgId, ruleId, period.id, asOfYMD]
      );
      runRow = created[0];
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // Post journal OUTSIDE the above transaction.
  // Journal module handles its own transaction and idempotency (by idempotencyKey).
  try {
    const draft = await journalIF.createDraftJournal({
      orgId,
      actorUserId,
      payload: {
        periodId: period.id,
        entryDate: asOfYMD,
        typeCode: "ADJUSTMENT",
        memo: `${rule.code}: ${rule.name} (${asOfYMD})`,
        idempotencyKey,
        lines: journalLines,
      },
    });

    const posted = await journalIF.postDraftJournal({
      orgId,
      journalId: draft.journalId,
      actorUserId,
    });

    // Persist linkage + mark posted
    await pool.query(
      `
      INSERT INTO accrual_run_postings(accrual_run_id, journal_entry_id, posted_at)
      VALUES ($1,$2,NOW())
      ON CONFLICT (accrual_run_id) DO NOTHING
      `,
      [runRow.id, posted.journalId]
    );

    await pool.query(
      `
      UPDATE accrual_runs
      SET status='posted', completed_at=NOW(), error=NULL
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, runRow.id]
    );

    return { runId: runRow.id, status: "posted", journalId: posted.journalId };
  } catch (e) {
    // Persist failure
    await pool.query(
      `
      UPDATE accrual_runs
      SET status='failed', completed_at=NOW(), error=$3
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, runRow.id, String(e?.message || e)]
    );
    throw e;
  }
}

/**
 * Due logic runner for DAILY/WEEKLY/MONTHLY.
 */
async function runDueAccruals({ orgId, actorUserId, asOfDate }) {
  const { rows: rules } = await pool.query(
    `
    SELECT id, frequency, start_date, end_date
    FROM accrual_rules
    WHERE organization_id=$1
      AND status='active'
      AND frequency IN ('DAILY','WEEKLY','MONTHLY')
    ORDER BY created_at ASC
    `,
    [orgId]
  );

  const asOf = parseYMD(asOfDate);

  const withinBounds = (r) => {
    if (r.start_date) {
      const sd = parseYMD(ymd(parseYMD(r.start_date)));
      if (asOf < sd) return false;
    }
    if (r.end_date) {
      const ed = parseYMD(ymd(parseYMD(r.end_date)));
      if (asOf > ed) return false;
    }
    return true;
  };

  const isDue = (r) => {
    if (!withinBounds(r)) return false;

    if (r.frequency === "DAILY") return true;

    if (r.frequency === "WEEKLY") {
      // Anchor: start_date weekday; if none, Monday
      const anchor = r.start_date
        ? parseYMD(ymd(parseYMD(r.start_date)))
        : new Date("1970-01-05T00:00:00.000Z");
      return asOf.getUTCDay() === anchor.getUTCDay();
    }

    if (r.frequency === "MONTHLY") {
      // Anchor day-of-month; if none, 1st.
      const anchorDay = r.start_date
        ? parseYMD(ymd(parseYMD(r.start_date))).getUTCDate()
        : 1;
      const y = asOf.getUTCFullYear();
      const m = asOf.getUTCMonth();
      const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const dueDay = Math.min(anchorDay, lastDay);
      return asOf.getUTCDate() === dueDay;
    }

    return false;
  };

  const results = [];
  for (const r of rules) {
    if (!isDue(r)) continue;
    results.push(await runOne({ orgId, actorUserId, ruleId: r.id, asOfDate }));
  }
  return results;
}

/**
 * Period-end runner: run all active PERIOD_END rules for the given period.
 * Posts with asOfDateOverride = period.end_date by default (or caller override).
 */
async function runPeriodEndAccruals({
  orgId,
  actorUserId,
  periodId,
  asOfDateOverride = null,
}) {
  const { rows: p } = await pool.query(
    `SELECT id, status, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!p.length) throw new AppError(400, "Invalid periodId");
  if (p[0].status !== "open") throw new AppError(409, "Period is not open");

  const asOfDate = asOfDateOverride || ymd(parseYMD(p[0].end_date));

  const { rows: rules } = await pool.query(
    `
    SELECT id
    FROM accrual_rules
    WHERE organization_id=$1
      AND status='active'
      AND frequency='PERIOD_END'
      AND rule_type != 'DEFERRAL'
    ORDER BY created_at ASC
    `,
    [orgId]
  );

  const results = [];
  for (const r of rules) {
    results.push(
      await runOne({
        orgId,
        actorUserId,
        ruleId: r.id,
        asOfDate,
        periodIdOverride: periodId,
      })
    );
  }
  // After running PERIOD_END recurring rules:
  await runDeferralRecognitions({ orgId, actorUserId, periodId });
  return results;
}

async function runReversals({ orgId, actorUserId, periodId }) {
  // Reverse posted accrual runs requiring reversal, posting into provided open period.
  const client = await pool.connect();
  try {
    const { rows: pRows } = await client.query(
      `SELECT id, status, start_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
      [orgId, periodId]
    );
    if (!pRows.length) throw new AppError(400, "Invalid periodId");
    const targetPeriod = pRows[0];
    if (targetPeriod.status !== "open")
      throw new AppError(409, "Period is not open");

    const { rows } = await client.query(
      `
      SELECT ar.id AS run_id,
             ar.as_of_date,
             ar.period_id AS original_period_id,
             r.code,
             r.reverse_timing,
             ap.journal_entry_id,
             ap.id AS posting_id
      FROM accrual_runs ar
      JOIN accrual_rules r ON r.id = ar.accrual_rule_id
      JOIN accrual_run_postings ap ON ap.accrual_run_id = ar.id
      WHERE ar.organization_id=$1
        AND ar.status='posted'
        AND r.rule_type='REVERSING'
        AND r.auto_reverse=TRUE
        AND (r.reverse_timing IS NULL OR r.reverse_timing='NEXT_PERIOD_START')
        AND ap.reversal_journal_entry_id IS NULL
      ORDER BY ar.as_of_date ASC
      `,
      [orgId]
    );

    let reversedCount = 0;
    let failedCount = 0;

    for (const x of rows) {
      const idempotencyKey = `accrual:reverse:${x.run_id}:${periodId}`;

      try {
        // Post reversal journal into TARGET period at period start date
        const out = await journalIF.reversePostedJournal({
          orgId,
          journalId: x.journal_entry_id,
          actorUserId,
          targetPeriodId: targetPeriod.id,
          entryDate: targetPeriod.start_date,
          reason: `Auto-reversal for accrual ${x.code}`,
          idempotencyKey,
        });

        await client.query("BEGIN");

        // Set reversal linkage (idempotent)
        const { rowCount } = await client.query(
          `
          UPDATE accrual_run_postings
          SET reversal_journal_entry_id=$2,
              reversal_failed_at=NULL,
              reversal_failure_reason=NULL
          WHERE accrual_run_id=$1
            AND reversal_journal_entry_id IS NULL
          `,
          [x.run_id, out.reversalJournalId]
        );

        if (rowCount > 0) {
          await client.query(
            `
            UPDATE accrual_runs
            SET status='reversed',
                completed_at=NOW()
            WHERE id=$1 AND organization_id=$2
              AND status='posted'
            `,
            [x.run_id, orgId]
          );
          reversedCount += 1;
        }

        await client.query("COMMIT");
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
        failedCount += 1;

        // Persist reversal failure on posting record (do NOT change run from 'posted')
        await client.query(
          `
          UPDATE accrual_run_postings
          SET reversal_failed_at=NOW(),
              reversal_failure_reason=$2,
              reversal_failure_count = COALESCE(reversal_failure_count, 0) + 1
          WHERE accrual_run_id=$1
          `,
          [x.run_id, String(e?.message || e)]
        );
      }
    }

    return { reversedCount, failedCount };
  } finally {
    client.release();
  }
}

/**
 * Monitoring
 */
async function listRuns({ orgId, query }) {
  const params = [orgId];
  const where = ["ar.organization_id=$1"];
  let i = 2;

  if (query?.ruleId) {
    where.push(`ar.accrual_rule_id=$${i++}`);
    params.push(query.ruleId);
  }
  if (query?.periodId) {
    where.push(`ar.period_id=$${i++}`);
    params.push(query.periodId);
  }
  if (query?.status) {
    where.push(`ar.status=$${i++}`);
    params.push(query.status);
  }
  if (query?.from) {
    where.push(`ar.as_of_date >= $${i++}`);
    params.push(query.from);
  }
  if (query?.to) {
    where.push(`ar.as_of_date <= $${i++}`);
    params.push(query.to);
  }

  const limit = Math.min(Number(query?.limit || 50), 200);
  const offset = Math.max(Number(query?.offset || 0), 0);
  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT
      ar.*,
      r.code AS rule_code,
      r.name AS rule_name,
      r.rule_type,
      r.frequency,
      ap.journal_entry_id,
      ap.reversal_journal_entry_id
    FROM accrual_runs ar
    JOIN accrual_rules r ON r.id = ar.accrual_rule_id
    LEFT JOIN accrual_run_postings ap ON ap.accrual_run_id = ar.id
    WHERE ${where.join(" AND ")}
    ORDER BY ar.as_of_date DESC, ar.created_at DESC
    LIMIT $${i++} OFFSET $${i++}
    `,
    params
  );

  return rows;
}

async function getRun({ orgId, runId }) {
  const { rows } = await pool.query(
    `
    SELECT
      ar.*,
      r.code AS rule_code,
      r.name AS rule_name,
      r.rule_type,
      r.frequency,
      ap.journal_entry_id,
      ap.reversal_journal_entry_id
    FROM accrual_runs ar
    JOIN accrual_rules r ON r.id = ar.accrual_rule_id
    LEFT JOIN accrual_run_postings ap ON ap.accrual_run_id = ar.id
    WHERE ar.organization_id=$1 AND ar.id=$2
    `,
    [orgId, runId]
  );
  if (!rows.length) throw new AppError(404, "Accrual run not found");
  return rows[0];
}

module.exports = {
  createRule,
  listRules,
  getRuleWithLines,
  runOne,
  runDueAccruals,
  runPeriodEndAccruals,
  runReversals,
  listRuns,
  getRun,
  runDeferralRecognitions,
};
