const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const { findOpenPeriodForDate } = require("../../interfaces/periodManagement.interface");
const { postJournal } = require("../../interfaces/journalPosting.interface");
const Decimal = require('decimal.js');

// Configure Decimal.js for financial calculations
Decimal.set({
  precision: 20,      // High precision for financial calculations
  rounding: Decimal.ROUND_HALF_EVEN,  // Banker's rounding (standard for accounting)
  toExpNeg: -10,      // Prevent scientific notation for small numbers
  toExpPos: 20,       // Prevent scientific notation for large numbers
});

// ------------------------------
// Decimal Utilities
// ------------------------------

function toDecimal(value, defaultValue = new Decimal(0)) {
  if (value instanceof Decimal) return value;
  if (value === null || value === undefined || value === '') return defaultValue;
  
  try {
    return new Decimal(value);
  } catch (error) {
    console.warn(`Failed to convert value to Decimal: ${value}`, error);
    return defaultValue;
  }
}

function roundCurrency(value, decimals = 2) {
  const decimal = toDecimal(value);
  return decimal.toDecimalPlaces(decimals, Decimal.ROUND_HALF_EVEN);
}

function toCurrencyNumber(value, decimals = 2) {
  return roundCurrency(value, decimals).toNumber();
}

function calculatePresentValue({
  payment,
  annualDiscountRate,
  termMonths,
  paymentTiming = 'arrears',
}) {
  const PMT = toDecimal(payment);
  const r = toDecimal(annualDiscountRate).div(12); // Monthly rate
  const n = toDecimal(termMonths);
  
  // Handle zero interest rate
  if (r.equals(0)) {
    const pv = PMT.times(n);
    return paymentTiming === 'advance' ? pv : pv;
  }
  
  // Calculate (1 + r)^-n
  const onePlusR = new Decimal(1).plus(r);
  const power = onePlusR.pow(n.negated());
  
  // PV of ordinary annuity: PMT × [1 - (1 + r)^-n] / r
  const pvOrdinary = PMT.times(new Decimal(1).minus(power)).div(r);
  
  // If payments are in advance, multiply by (1 + r)
  if (paymentTiming === 'advance') {
    return pvOrdinary.times(onePlusR);
  }
  
  return pvOrdinary;
}

// ------------------------------
// Helpers
// ------------------------------

function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Handle month-end rollover
  if (d.getUTCDate() < day) {
    d.setUTCDate(0);
  }
  return d;
}

function toISODate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function assertLeaseInOrg({ orgId, leaseId }) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM leases
    WHERE id=$1 AND organization_id=$2
    LIMIT 1
    `,
    [leaseId, orgId]
  );
  if (!rows.length) throw new AppError(404, "Lease not found");
  return rows[0];
}

async function assertPostableAccount({ orgId, accountId, label }) {
  const { rows } = await pool.query(
    `
    SELECT id, status, is_postable
    FROM chart_of_accounts
    WHERE organization_id=$1 AND id=$2
    LIMIT 1
    `,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, `Invalid ${label}`);
  if (rows[0].status !== "active") throw new AppError(400, `${label} must be an active account`);
  if (!rows[0].is_postable) throw new AppError(400, `${label} must be postable`);
}

function assertLeaseStatusAllowed(lease, allowed, action) {
  if (!allowed.includes(lease.status)) {
    throw new AppError(409, `${action} is not allowed when lease status is '${lease.status}'`);
  }
}

// ------------------------------
// Public API
// ------------------------------

async function listLeases({ orgId, query }) {
  const limit = Math.min(Number(query?.limit || 50), 200);
  const offset = Math.max(Number(query?.offset || 0), 0);
  const status = query?.status;

  const where = ["organization_id=$1"];
  const params = [orgId];
  if (status) {
    params.push(status);
    where.push(`status=$${params.length}`);
  }

  const { rows } = await pool.query(
    `
    SELECT id, code, name, status, commencement_date, term_months,
           payment_amount, payments_per_year, annual_discount_rate,
           payment_timing,
           initial_recognition_date,
           initial_recognition_journal_id,
           created_at, updated_at
    FROM leases
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `,
    [...params, limit, offset]
  );

  return { items: rows, limit, offset };
}

async function createLease({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Validate GL mappings up-front (org ownership + postable)
    await assertPostableAccount({ orgId, accountId: payload.rou_asset_account_id, label: "rou_asset_account_id" });
    await assertPostableAccount({ orgId, accountId: payload.lease_liability_account_id, label: "lease_liability_account_id" });
    await assertPostableAccount({ orgId, accountId: payload.interest_expense_account_id, label: "interest_expense_account_id" });
    await assertPostableAccount({ orgId, accountId: payload.depreciation_expense_account_id, label: "depreciation_expense_account_id" });
    await assertPostableAccount({ orgId, accountId: payload.accumulated_depreciation_account_id, label: "accumulated_depreciation_account_id" });
    await assertPostableAccount({ orgId, accountId: payload.cash_account_id, label: "cash_account_id" });

    // Enforce uniqueness by (org, code)
    const { rows: existing } = await client.query(
      `SELECT 1 FROM leases WHERE organization_id=$1 AND code=$2 LIMIT 1`,
      [orgId, payload.code]
    );
    if (existing.length) throw new AppError(409, "Lease code already exists");

    // Validate numeric fields using Decimal
    const paymentAmount = toDecimal(payload.payment_amount);
    const annualDiscountRate = toDecimal(payload.annual_discount_rate);
    const termMonths = toDecimal(payload.term_months);

    if (!paymentAmount.greaterThan(0)) {
      throw new AppError(400, "Payment amount must be greater than 0");
    }
    if (!annualDiscountRate.greaterThanOrEqualTo(0)) {
      throw new AppError(400, "Annual discount rate must be non-negative");
    }
    if (!termMonths.greaterThan(0)) {
      throw new AppError(400, "Term months must be greater than 0");
    }

    const { rows } = await client.query(
      `
      INSERT INTO leases(
        organization_id,
        code,
        name,
        status,
        commencement_date,
        term_months,
        payment_amount,
        payments_per_year,
        annual_discount_rate,
        payment_timing,
        rou_asset_account_id,
        lease_liability_account_id,
        interest_expense_account_id,
        depreciation_expense_account_id,
        accumulated_depreciation_account_id,
        cash_account_id,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
      `,
      [
        orgId,
        payload.code,
        payload.name,
        payload.status,
        toISODate(payload.commencement_date),
        termMonths.toNumber(),
        paymentAmount.toNumber(),
        payload.payments_per_year,
        annualDiscountRate.toNumber(),
        payload.payment_timing,
        payload.rou_asset_account_id,
        payload.lease_liability_account_id,
        payload.interest_expense_account_id,
        payload.depreciation_expense_account_id,
        payload.accumulated_depreciation_account_id,
        payload.cash_account_id,
        actorUserId,
      ]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getLease({ orgId, leaseId }) {
  const lease = await assertLeaseInOrg({ orgId, leaseId });
  return lease;
}

/**
 * Generate IFRS16 schedule using Decimal.js for precise calculations
 */
async function generateSchedule({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lease = await assertLeaseInOrg({ orgId, leaseId });

    // Allow schedule generation only for draft/active leases
    assertLeaseStatusAllowed(lease, ["draft", "active"], "Schedule generation");

    if (payload.replace) {
      await client.query(`DELETE FROM lease_schedule_lines WHERE lease_id=$1`, [leaseId]);
    } else {
      const { rows: anyExisting } = await client.query(
        `SELECT 1 FROM lease_schedule_lines WHERE lease_id=$1 LIMIT 1`,
        [leaseId]
      );
      if (anyExisting.length) {
        throw new AppError(409, "Schedule already exists. Use replace=true to regenerate.");
      }
    }

    // Convert to Decimal for precise calculations
    const nPeriods = toDecimal(lease.term_months);
    const periodicRate = toDecimal(lease.annual_discount_rate).div(12);
    const payment = toDecimal(lease.payment_amount);
    const timing = lease.payment_timing || "arrears";

    // Calculate present value using Decimal.js
    const initialLiability = calculatePresentValue({
      payment: payment,
      annualDiscountRate: toDecimal(lease.annual_discount_rate),
      termMonths: nPeriods,
      paymentTiming: timing,
    });

    // Store with 6 decimal places for calculation precision
    const preciseLiability = initialLiability.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
    const monthlyDepreciation = preciseLiability.div(nPeriods).toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);

    // Validate calculations
    if (!preciseLiability.greaterThan(0)) {
      throw new AppError(400, "Calculated initial liability is not positive");
    }

    let opening = preciseLiability;
    const startDate = new Date(lease.commencement_date);

    for (let i = 1; i <= nPeriods.toNumber(); i += 1) {
      const dueDate = timing === "advance" ? addMonths(startDate, i - 1) : addMonths(startDate, i);

      let interest;
      let principal;
      let closing;

      if (timing === "advance") {
        // Payment at the beginning of the period.
        principal = payment;
        const afterPayment = opening.minus(principal);
        interest = afterPayment.times(periodicRate);
        closing = afterPayment.plus(interest);
      } else {
        // Payment at the end of the period.
        interest = opening.times(periodicRate);
        principal = payment.minus(interest);
        
        if (principal.lessThan(0)) {
          throw new AppError(400, "Payment amount is too low for the discount rate; schedule would go negative");
        }
        closing = opening.minus(principal);
      }

      // Round all amounts to 6 decimal places for storage
      const openingRounded = opening.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
      const paymentRounded = payment.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
      const interestRounded = interest.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
      const principalRounded = principal.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
      const closingRounded = closing.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
      const depreciationRounded = monthlyDepreciation.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);

      await client.query(
        `
        INSERT INTO lease_schedule_lines(
          lease_id,
          line_no,
          due_date,
          opening_balance,
          payment_amount,
          interest_amount,
          principal_amount,
          closing_balance,
          depreciation_amount,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
        [
          leaseId,
          i,
          toISODate(dueDate),
          openingRounded.toNumber(),
          paymentRounded.toNumber(),
          interestRounded.toNumber(),
          principalRounded.toNumber(),
          closingRounded.toNumber(),
          depreciationRounded.toNumber(),
          actorUserId,
        ]
      );

      opening = closing;
    }

    // Store derived metrics for reference
    await client.query(
      `
      UPDATE leases
      SET initial_lease_liability=$2,
          monthly_depreciation_amount=$3,
          updated_at=NOW()
      WHERE id=$1 AND organization_id=$4
      `,
      [
        leaseId,
        preciseLiability.toNumber(),  // Store with 6 decimal precision
        monthlyDepreciation.toNumber(),
        orgId
      ]
    );

    await client.query("COMMIT");
    return {
      lease_id: leaseId,
      initial_lease_liability: toCurrencyNumber(preciseLiability),
      precise_liability: preciseLiability.toNumber(),
      monthly_depreciation_amount: toCurrencyNumber(monthlyDepreciation),
      precise_depreciation: monthlyDepreciation.toNumber(),
      lines_created: nPeriods.toNumber(),
      calculation_decimals: 6,
      currency_decimals: 2,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getSchedule({ orgId, leaseId }) {
  await assertLeaseInOrg({ orgId, leaseId });
  const { rows } = await pool.query(
    `
    SELECT line_no, due_date, opening_balance, payment_amount, interest_amount,
           principal_amount, closing_balance, depreciation_amount,
           posted_interest_payment_journal_id,
           posted_depreciation_journal_id
    FROM lease_schedule_lines
    WHERE lease_id=$1
    ORDER BY line_no ASC
    `,
    [leaseId]
  );
  return { lease_id: leaseId, lines: rows };
}

async function postLeasePeriod({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lease = await assertLeaseInOrg({ orgId, leaseId });

    // Only active leases can post periodic entries
    assertLeaseStatusAllowed(lease, ["active"], "Periodic posting");

    // Validate GL accounts (in case COA changed since lease creation)
    await assertPostableAccount({ orgId, accountId: lease.interest_expense_account_id, label: "interest_expense_account_id" });
    await assertPostableAccount({ orgId, accountId: lease.lease_liability_account_id, label: "lease_liability_account_id" });
    await assertPostableAccount({ orgId, accountId: lease.cash_account_id, label: "cash_account_id" });
    await assertPostableAccount({ orgId, accountId: lease.depreciation_expense_account_id, label: "depreciation_expense_account_id" });
    await assertPostableAccount({ orgId, accountId: lease.accumulated_depreciation_account_id, label: "accumulated_depreciation_account_id" });

    const from = toISODate(payload.from_date);
    const to = toISODate(payload.to_date);

    // Pull schedule lines due within range
    const { rows: lines } = await client.query(
      `
      SELECT *
      FROM lease_schedule_lines
      WHERE lease_id=$1 AND due_date BETWEEN $2 AND $3
      ORDER BY due_date ASC
      FOR UPDATE
      `,
      [leaseId, from, to]
    );

    if (!lines.length) {
      await client.query("ROLLBACK");
      return { posted: 0, message: "No schedule lines in range" };
    }

    let posted = 0;
    const journalIds = [];

    for (const line of lines) {
      const entryDate = line.due_date;
      const period = await findOpenPeriodForDate({ orgId, date: entryDate });

      // 1) Interest + payment (single combined journal)
      if (payload.post_interest_and_payment && !line.posted_interest_payment_journal_id) {
        // Use Decimal to verify balance
        const total = toDecimal(line.payment_amount);
        const interest = toDecimal(line.interest_amount);
        const principal = toDecimal(line.principal_amount);

        // Verify that interest + principal equals payment (within tolerance)
        const sum = interest.plus(principal);
        const tolerance = new Decimal(0.000001); // 0.000001 tolerance for rounding
        if (sum.minus(total).abs().greaterThan(tolerance)) {
          throw new AppError(400, `Schedule line does not balance (interest + principal != payment). Expected ${total}, got ${sum}`);
        }

        const postedJournal = await postJournal({
          orgId,
          actorUserId,
          payload: {
            periodId: period.id,
            entryDate: entryDate,
            memo: `IFRS16 Lease ${lease.code} - payment #${line.line_no}`,
            lines: [
              // Dr Interest expense
              {
                accountId: lease.interest_expense_account_id,
                debit: toCurrencyNumber(interest),
                credit: 0,
                memo: "Lease interest",
              },
              // Dr Lease liability (principal)
              {
                accountId: lease.lease_liability_account_id,
                debit: toCurrencyNumber(principal),
                credit: 0,
                memo: "Lease principal",
              },
              // Cr Cash
              {
                accountId: lease.cash_account_id,
                debit: 0,
                credit: toCurrencyNumber(total),
                memo: "Lease payment",
              },
            ],
          },
        });

        await client.query(
          `
          UPDATE lease_schedule_lines
          SET posted_interest_payment_journal_id=$2, updated_at=NOW()
          WHERE id=$1
          `,
          [line.id, postedJournal.journalId]
        );

        journalIds.push(postedJournal.journalId);
        posted += 1;
      }

      // 2) Depreciation
      if (payload.post_depreciation && !line.posted_depreciation_journal_id) {
        const dep = toDecimal(line.depreciation_amount);

        const postedJournal = await postJournal({
          orgId,
          actorUserId,
          payload: {
            periodId: period.id,
            entryDate: entryDate,
            memo: `IFRS16 Lease ${lease.code} - depreciation #${line.line_no}`,
            lines: [
              {
                accountId: lease.depreciation_expense_account_id,
                debit: toCurrencyNumber(dep),
                credit: 0,
                memo: "ROU depreciation",
              },
              {
                accountId: lease.accumulated_depreciation_account_id,
                debit: 0,
                credit: toCurrencyNumber(dep),
                memo: "Accumulated depreciation - ROU",
              },
            ],
          },
        });

        await client.query(
          `
          UPDATE lease_schedule_lines
          SET posted_depreciation_journal_id=$2, updated_at=NOW()
          WHERE id=$1
          `,
          [line.id, postedJournal.journalId]
        );

        journalIds.push(postedJournal.journalId);
        posted += 1;
      }
    }

    await client.query("COMMIT");
    return { posted, journal_ids: journalIds };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Initial recognition (IFRS 16):
 *   Dr Right-of-use (ROU) asset
 *   Cr Lease liability
 *
 * Amount is the initial lease liability (PV of payments under the current simplified schedule assumptions).
 * Idempotent: if already posted, returns the existing journal id.
 */
async function postInitialRecognition({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock lease row for idempotency and concurrent posting safety.
    const { rows: leaseRows } = await client.query(
      `
      SELECT *
      FROM leases
      WHERE id=$1 AND organization_id=$2
      FOR UPDATE
      `,
      [leaseId, orgId]
    );
    if (!leaseRows.length) throw new AppError(404, "Lease not found");
    const lease = leaseRows[0];

    // Initial recognition is only permitted while draft.
    assertLeaseStatusAllowed(lease, ["draft"], "Initial recognition posting");

    // Validate GL accounts (in case COA changed)
    await assertPostableAccount({ orgId, accountId: lease.rou_asset_account_id, label: "rou_asset_account_id" });
    await assertPostableAccount({ orgId, accountId: lease.lease_liability_account_id, label: "lease_liability_account_id" });

    if (lease.initial_recognition_journal_id) {
      await client.query("COMMIT");
      return {
        already_posted: true,
        journal_id: lease.initial_recognition_journal_id,
        recognition_date: lease.initial_recognition_date,
      };
    }

    const entryDate = payload?.entryDate ? toISODate(payload.entryDate) : toISODate(lease.commencement_date);

    // Ensure a period is open for the recognition date.
    const period = await findOpenPeriodForDate({ orgId, date: entryDate });

    // Determine initial liability amount using Decimal.js
    let initialLiability;
    
    if (lease.initial_lease_liability != null) {
      // Use persisted derived value if available
      initialLiability = toDecimal(lease.initial_lease_liability);
    } else {
      // Calculate present value using Decimal.js
      initialLiability = calculatePresentValue({
        payment: lease.payment_amount,
        annualDiscountRate: lease.annual_discount_rate,
        termMonths: lease.term_months,
        paymentTiming: lease.payment_timing || "arrears",
      });
    }

    // Validate the amount is positive
    if (!initialLiability.greaterThan(0)) {
      throw new AppError(400, "Initial recognition amount must be greater than 0");
    }

    // Round to 6 decimal places for calculation consistency
    const preciseAmount = initialLiability.toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
    
    // Convert to currency amount (2 decimal places) for journal posting
    const journalAmount = toCurrencyNumber(preciseAmount);

    // Validate the amount is still positive after rounding
    if (journalAmount <= 0) {
      throw new AppError(400, "Amount after rounding is not positive");
    }

    // Post the journal entry
    const postedJournal = await postJournal({
      orgId,
      actorUserId,
      payload: {
        periodId: period.id,
        entryDate: entryDate,
        memo: payload?.memo || `IFRS16 Lease ${lease.code} - initial recognition`,
        lines: [
          {
            accountId: lease.rou_asset_account_id,
            debit: journalAmount,
            credit: 0,
            memo: "Recognise right-of-use asset",
          },
          {
            accountId: lease.lease_liability_account_id,
            debit: 0,
            credit: journalAmount,
            memo: "Recognise lease liability",
          },
        ],
      },
    });

    // Update lease with recognition details
    await client.query(
      `
      UPDATE leases
      SET 
        initial_recognition_journal_id = $2,
        initial_recognition_date = $3,
        initial_lease_liability = $4, 
        status = 'active',
        activated_at = COALESCE(activated_at, NOW()),
        updated_at = NOW()
      WHERE id = $1 AND organization_id = $5
      `,
      [
        leaseId,
        postedJournal.journalId,
        entryDate,
        preciseAmount.toNumber(),  // Store with 6 decimal precision
        orgId
      ]
    );

    await client.query("COMMIT");
    
    return {
      already_posted: false,
      journal_id: postedJournal.journalId,
      recognition_date: entryDate,
      amount: journalAmount,
      precise_amount: preciseAmount.toNumber(), // Include precise amount for reference
      currency_decimals: 2,
      calculation_decimals: 6,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function updateLeaseStatus({ orgId, actorUserId, leaseId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT *
      FROM leases
      WHERE id=$1 AND organization_id=$2
      FOR UPDATE
      `,
      [leaseId, orgId]
    );
    if (!rows.length) throw new AppError(404, "Lease not found");
    const lease = rows[0];

    const nextStatus = payload.status;
    const current = lease.status;

    if (current === nextStatus) {
      await client.query("COMMIT");
      return { changed: false, before: lease, after: lease };
    }

    // Transition rules (production-grade minimum):
    // - draft -> active is ONLY through initial recognition posting
    // - active -> closed (requires all schedule lines posted)
    // - active -> terminated (blocks further postings; requires no future lines already posted)
    // - closed/terminated are terminal states
    if (current === "draft" && nextStatus === "active") {
      throw new AppError(409, "Use initial recognition posting to activate a lease");
    }
    if (current === "draft" && nextStatus === "closed") {
      throw new AppError(409, "Cannot close a draft lease");
    }
    if (["closed", "terminated"].includes(current)) {
      throw new AppError(409, `Cannot change status from '${current}'`);
    }

    const effectiveDate = payload.effective_date ? toISODate(payload.effective_date) : null;

    if (current === "active" && nextStatus === "closed") {
      const { rows: unposted } = await client.query(
        `
        SELECT 1
        FROM lease_schedule_lines
        WHERE lease_id=$1
          AND (posted_interest_payment_journal_id IS NULL OR posted_depreciation_journal_id IS NULL)
        LIMIT 1
        `,
        [leaseId]
      );
      if (unposted.length) {
        throw new AppError(409, "Cannot close lease while there are unposted schedule lines");
      }
    }

    if ((current === "active" && nextStatus === "terminated") || (current === "draft" && nextStatus === "terminated")) {
      if (!effectiveDate) {
        throw new AppError(400, "effective_date is required to terminate a lease");
      }

      if (current === "draft" && lease.initial_recognition_journal_id) {
        throw new AppError(409, "Cannot terminate a draft lease that already has initial recognition posted");
      }

      // Prevent termination if there are already posted lines after the effective date
      const { rows: futurePosted } = await client.query(
        `
        SELECT 1
        FROM lease_schedule_lines
        WHERE lease_id=$1
          AND due_date > $2
          AND (
            posted_interest_payment_journal_id IS NOT NULL
            OR posted_depreciation_journal_id IS NOT NULL
          )
        LIMIT 1
        `,
        [leaseId, effectiveDate]
      );
      if (futurePosted.length) {
        throw new AppError(409, "Cannot terminate: there are already posted schedule lines after the effective_date");
      }
    }

    const tsFields = {
      activated_at: lease.activated_at,
      terminated_at: lease.terminated_at,
      closed_at: lease.closed_at,
    };

    if (nextStatus === "terminated") tsFields.terminated_at = tsFields.terminated_at || new Date().toISOString();
    if (nextStatus === "closed") tsFields.closed_at = tsFields.closed_at || new Date().toISOString();

    const reason = payload.reason || null;

    const { rows: afterRows } = await client.query(
      `
      UPDATE leases
      SET status=$3,
          status_reason=$4,
          terminated_at=$5,
          closed_at=$6,
          updated_at=NOW()
      WHERE id=$1 AND organization_id=$2
      RETURNING *
      `,
      [leaseId, orgId, nextStatus, reason, tsFields.terminated_at, tsFields.closed_at]
    );

    await client.query("COMMIT");
    return { changed: true, before: lease, after: afterRows[0] };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  listLeases,
  createLease,
  getLease,
  generateSchedule,
  getSchedule,
  postLeasePeriod,
  postInitialRecognition,
  updateLeaseStatus,
  // Export utilities for testing
  toDecimal,
  roundCurrency,
  calculatePresentValue,
};