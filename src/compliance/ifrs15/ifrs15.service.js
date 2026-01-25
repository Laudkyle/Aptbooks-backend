const { pool } = require("../../db/pool");
const { AppError } = require("../../shared/errors/AppError");
const Decimal = require("decimal.js");
const journalPosting = require("../../interfaces/journalPosting.interface");

// -------------------------
// Helpers
// -------------------------

function asDateOnly(d) {
  // d can be Date or string
  if (d instanceof Date) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(d).slice(0, 10);
}

function daysBetweenInclusive(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00Z`).getTime();
  const end = new Date(`${endStr}T00:00:00Z`).getTime();
  const ms = end - start;
  if (ms < 0) return 0;
  return Math.floor(ms / 86400000) + 1;
}

function overlapDays(aStart, aEnd, bStart, bEnd) {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return daysBetweenInclusive(s, e);
}

async function getSettings(client, orgId) {
  const { rows } = await client.query(
    `SELECT organization_id, revenue_account_id, contract_asset_account_id, contract_liability_account_id,
            default_billing_account_id, rounding_decimals
     FROM ifrs15_settings
     WHERE organization_id=$1`,
    [orgId]
  );
  return rows[0] || null;
}


async function getSettingsOrThrow(client, orgId) {

  const s = await getSettings(client, orgId);
  if (!s) throw new AppError(409, "IFRS15 settings not configured");
  if (!s.revenue_account_id || !s.contract_asset_account_id || !s.contract_liability_account_id) {
    throw new AppError(409, "IFRS15 settings missing required posting accounts");
  }
  return s;
}


async function getCustomerBusinessPartnerOrThrow(client, orgId, businessPartnerId) {
  const { rows } = await client.query(
    `SELECT id, type, status
     FROM business_partners
     WHERE organization_id=$1 AND id=$2`,
    [orgId, businessPartnerId]
  );
  if (!rows.length) throw new AppError(404, "Business partner not found");
  if (rows[0].type !== 'customer') throw new AppError(409, "Business partner must be of type 'customer'");
  if (rows[0].status !== 'active') throw new AppError(409, "Business partner is not active");
  return rows[0];
}
async function getContractOrThrow(client, orgId, contractId) {
  const { rows } = await client.query(
    `SELECT * FROM ifrs15_contracts WHERE organization_id=$1 AND id=$2`,
    [orgId, contractId]
  );
  if (!rows.length) throw new AppError(404, "Contract not found");
  return rows[0];
}

async function listObligations(client, orgId, contractId) {
  // Join via contract to ensure org scoping, even if a foreign contract_id is guessed.
  const { rows } = await client.query(
    `SELECT o.*
     FROM ifrs15_performance_obligations o
     JOIN ifrs15_contracts c ON c.id = o.contract_id
     WHERE o.contract_id=$1 AND c.organization_id=$2
     ORDER BY o.created_at ASC`,
    [contractId, orgId]
  );
  return rows;
}

async function recordEvent(client, { orgId, contractId, actorUserId, eventType, meta }) {
  await client.query(
    `INSERT INTO ifrs15_contract_events(organization_id, contract_id, event_type, actor_user_id, meta)
     VALUES ($1,$2,$3,$4,$5)`,
    [orgId, contractId, eventType, actorUserId, meta ? JSON.stringify(meta) : null]
  );
}

// -------------------------
// IFRS 15 Contract Modification Decision Engine (IFRS 15.20-21)
// -------------------------

function decideModificationOutcome({
  addsDistinctGoodsServices,
  priceIncreaseCommensurateWithSSP,
  remainingGoodsServicesDistinct,
}) {
  // Conservative defaults: treat as NOT a separate contract unless the
  // strict IFRS 15.20 criteria are met.
  const adds = !!addsDistinctGoodsServices;
  const commensurate = !!priceIncreaseCommensurateWithSSP;
  const remainingDistinct = remainingGoodsServicesDistinct == null ? true : !!remainingGoodsServicesDistinct;

  // IFRS 15.20: separate contract if (a) distinct goods/services are added
  // and (b) price increase reflects SSP for those goods/services.
  if (adds && commensurate) {
    return {
      outcome: "SEPARATE_CONTRACT",
      basis: "IFRS15.20",
    };
  }

  // IFRS 15.21: not a separate contract.
  // If remaining goods/services are distinct, treat prospectively (termination + new for remaining).
  // If not distinct, treat as part of existing contract with cumulative catch-up.
  if (adds && !commensurate && remainingDistinct) {
    return {
      outcome: "PROSPECTIVE",
      basis: "IFRS15.21(a)",
    };
  }

  return {
    outcome: "CUMULATIVE",
    basis: "IFRS15.21(b)",
  };
}

async function findPeriodForDateOrThrow(client, orgId, dateStr) {
  const { rows } = await client.query(
    `SELECT id, start_date, end_date, status
     FROM accounting_periods
     WHERE organization_id=$1 AND start_date <= $2 AND end_date >= $2
     ORDER BY start_date DESC
     LIMIT 1`,
    [orgId, dateStr]
  );
  if (!rows.length) throw new AppError(409, "No accounting period covers the given entry date");
  return rows[0];
}

async function listPeriodsOverlappingRange(client, orgId, startDate, endDate) {
  const { rows } = await client.query(
    `SELECT id, start_date, end_date, status
     FROM accounting_periods
     WHERE organization_id=$1
       AND daterange(start_date, end_date, '[]') && daterange($2, $3, '[]')
     ORDER BY start_date ASC`,
    [orgId, startDate, endDate]
  );
  if (!rows.length) throw new AppError(409, "No accounting periods overlap the obligation date range");
  return rows;
}

// -------------------------
// Public API
// -------------------------

async function getSettingsPublic({ orgId }) {
  return getSettings(pool, orgId);// not used (kept for parity)
}



async function upsertSettings({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert
    const { rows } = await client.query(
      `INSERT INTO ifrs15_settings(
         organization_id, revenue_account_id, contract_asset_account_id, contract_liability_account_id,
         default_billing_account_id, rounding_decimals
       )
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_id) DO UPDATE SET
         revenue_account_id=EXCLUDED.revenue_account_id,
         contract_asset_account_id=EXCLUDED.contract_asset_account_id,
         contract_liability_account_id=EXCLUDED.contract_liability_account_id,
         default_billing_account_id=EXCLUDED.default_billing_account_id,
         rounding_decimals=EXCLUDED.rounding_decimals,
         updated_at=NOW()
       RETURNING *`,
      [
        orgId,
        payload.revenue_account_id,
        payload.contract_asset_account_id,
        payload.contract_liability_account_id,
        (payload.default_billing_account_id || payload.billing_account_id || null),
        payload.rounding_decimals ?? 2,
      ]
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listContracts({ orgId, query }) {
  const limit = Math.min(Number(query.limit || 50), 200);
  const offset = Math.max(Number(query.offset || 0), 0);
  const status = query.status;

  const params = [orgId];
  let where = "WHERE organization_id=$1";
  if (status) {
    params.push(status);
    where += ` AND status=$${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT id, business_partner_id, code, contract_date, currency_code, transaction_price,
            billing_policy, billing_account_id, status, start_date, end_date, created_at, updated_at
     FROM ifrs15_contracts
     ${where}
     ORDER BY created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return rows;
}

async function createContract({ orgId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const businessPartnerId = payload.business_partner_id || payload.customer_id;
    if (!businessPartnerId) throw new AppError(400, "business_partner_id is required");
    await getCustomerBusinessPartnerOrThrow(client, orgId, businessPartnerId);


    // If billing_account_id is omitted, allow settings default later.
    const { rows } = await client.query(
      `INSERT INTO ifrs15_contracts(
         organization_id, business_partner_id, code, contract_date, currency_code, transaction_price,
         billing_policy, billing_account_id, status, start_date, end_date, created_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11)
       RETURNING *`,
      [
        orgId,
        businessPartnerId,
        payload.code,
        asDateOnly(payload.contract_date),
        payload.currency_code || null,
        new Decimal(payload.transaction_price).toFixed(6),
        payload.billing_policy || "UPFRONT",
        payload.billing_account_id || null,
        payload.start_date ? asDateOnly(payload.start_date) : null,
        payload.end_date ? asDateOnly(payload.end_date) : null,
        actorUserId,
      ]
    );

    await recordEvent(client, {
      orgId,
      contractId: rows[0].id,
      actorUserId,
      eventType: "CONTRACT_CREATED",
      meta: { code: payload.code },
    });

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getContract({ orgId, contractId }) {
  const client = await pool.connect();
  try {
    const contract = await getContractOrThrow(client, orgId, contractId);
    const obligations = await listObligations(client, orgId, contractId);

    // Simple derived balances (from schedule)
    const { rows: bal } = await client.query(
      `SELECT
         COALESCE(SUM(scheduled_amount),0)::numeric(18,6) AS scheduled_total,
         COALESCE(SUM(recognized_amount),0)::numeric(18,6) AS recognized_total
       FROM ifrs15_recognition_schedule_lines
       WHERE organization_id=$1 AND contract_id=$2`,
      [orgId, contractId]
    );

    return { contract, obligations, balances: bal[0] };
  } finally {
    client.release();
  }
}

async function addObligation({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "draft") throw new AppError(409, "Cannot add obligations after activation");

    // Basic validation: required dates
    if (payload.obligation_type === "POINT_IN_TIME") {
      if (!payload.satisfaction_date) throw new AppError(400, "satisfaction_date is required for POINT_IN_TIME");
    } else {
      if (!payload.start_date || !payload.end_date) throw new AppError(400, "start_date and end_date are required for OVER_TIME");
    }

    const { rows } = await client.query(
      `INSERT INTO ifrs15_performance_obligations(
         contract_id, description, obligation_type, satisfaction_method,
         standalone_selling_price, start_date, end_date, satisfaction_date
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        contractId,
        payload.description,
        payload.obligation_type,
        payload.satisfaction_method || "TIME",
        new Decimal(payload.standalone_selling_price).toFixed(6),
        payload.start_date ? asDateOnly(payload.start_date) : null,
        payload.end_date ? asDateOnly(payload.end_date) : null,
        payload.satisfaction_date ? asDateOnly(payload.satisfaction_date) : null,
      ]
    );

    await recordEvent(client, {
      orgId,
      contractId,
      actorUserId,
      eventType: "OBLIGATION_ADDED",
      meta: { obligation_id: rows[0].id },
    });

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function activateContract({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const settings = await getSettingsOrThrow(client, orgId);
    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "draft") throw new AppError(409, "Contract already activated");

    const obligations = await listObligations(client, orgId, contractId);
    if (!obligations.length) throw new AppError(409, "Contract has no performance obligations");

    // Deterministic allocation: relative SSP
    const totalSSP = obligations.reduce((s, o) => s.plus(o.standalone_selling_price), new Decimal(0));
    if (totalSSP.lte(0)) throw new AppError(409, "Total SSP must be > 0");

    const txPrice = new Decimal(contract.transaction_price);
    const rounding = Number(settings.rounding_decimals ?? 2);

    // Allocate with rounding residual to last obligation
    let allocatedSum = new Decimal(0);
    for (let i = 0;i < obligations.length;i++) {
      const o = obligations[i];
      let alloc;
      if (i === obligations.length - 1) {
        alloc = txPrice.minus(allocatedSum);
      } else {
        const ratio = new Decimal(o.standalone_selling_price).div(totalSSP);
        alloc = txPrice.mul(ratio).toDecimalPlaces(rounding);
        allocatedSum = allocatedSum.plus(alloc);
      }
      const ratioStored = new Decimal(o.standalone_selling_price).div(totalSSP).toFixed(12);
      await client.query(
        `UPDATE ifrs15_performance_obligations
         SET allocated_ratio=$2, allocated_amount=$3, updated_at=NOW()
         WHERE id=$1 AND contract_id=$4`,
        [o.id, ratioStored, alloc.toFixed(6), contractId]
      );
    }

    const entryDate = payload.entry_date ? asDateOnly(payload.entry_date) : asDateOnly(contract.contract_date);

    await client.query(
      `UPDATE ifrs15_contracts
       SET status='active', updated_at=NOW()
       WHERE organization_id=$1 AND id=$2`,
      [orgId, contractId]
    );

    await recordEvent(client, { orgId, contractId, actorUserId, eventType: "CONTRACT_ACTIVATED", meta: { entry_date: entryDate } });

    // Optional initial billing for UPFRONT
    if (contract.billing_policy === "UPFRONT") {
      const billingAccountId = contract.billing_account_id || settings.default_billing_account_id;
      if (!billingAccountId) throw new AppError(409, "billing_account_id is required for UPFRONT billing (or set default_billing_account_id in settings)");

      const period = await findPeriodForDateOrThrow(client, orgId, entryDate);

      const idempotencyKey = `IFRS15:CONTRACT:${contractId}:BILL:UPFRONT`;
      const memo = payload.memo || `IFRS15 upfront billing for contract ${contract.code}`;

      const j = await journalPosting.postJournal({
        orgId,
        actorUserId,
        payload: {
          typeCode: "GENERAL",
          periodId: period.id,
          entryDate,
          memo,
          idempotencyKey,
          lines: [
            { accountId: billingAccountId, debit: txPrice.toFixed(2), credit: 0, description: "Upfront billing" },
            { accountId: settings.contract_liability_account_id, debit: 0, credit: txPrice.toFixed(2), description: "Contract liability" },
          ],
        },
      });

      await client.query(
        `INSERT INTO ifrs15_posting_ledger(organization_id, contract_id, period_id, event_type, idempotency_key, journal_id, actor_user_id, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        [orgId, contractId, period.id, "UPFRONT_BILLING", idempotencyKey, j.journalId || j.journal_id || null, actorUserId, JSON.stringify({ memo })]
      );

      await recordEvent(client, { orgId, contractId, actorUserId, eventType: "UPFRONT_BILLING_POSTED", meta: { journalId: j.journalId || null } });
    }

    await client.query("COMMIT");
    return { ok: true, status: "active" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function generateSchedule({ orgId, actorUserId, contractId, payload, client: maybeClient }) {
  const client = maybeClient || (await pool.connect());
  const managedTx = !maybeClient;
  try {
    if (managedTx) await client.query("BEGIN");

    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active to generate schedule");

    const obligations = await listObligations(client, orgId, contractId);
    if (!obligations.length) throw new AppError(409, "No obligations");

    const fromDate = payload?.from_date ? asDateOnly(payload.from_date) : null;
    if (payload.replace) {
      await client.query(`DELETE FROM ifrs15_recognition_schedule_lines WHERE organization_id=$1 AND contract_id=$2`, [orgId, contractId]);
    } else if (fromDate) {
      await client.query(
        `DELETE FROM ifrs15_recognition_schedule_lines
         WHERE organization_id=$1 AND contract_id=$2 AND status IN ('open','scheduled') AND recognition_date >= $3`,
        [orgId, contractId, fromDate]
      );
    }

    let linesCreated = 0;

    for (const o of obligations) {
      const allocAmt = new Decimal(o.allocated_amount || 0);
      if (allocAmt.lte(0)) continue;

      if (o.obligation_type === "POINT_IN_TIME") {
        const sat = o.satisfaction_date;
        if (!sat) throw new AppError(409, "POINT_IN_TIME obligation missing satisfaction_date");
        const period = await findPeriodForDateOrThrow(client, orgId, sat);

        await client.query(
          `INSERT INTO ifrs15_recognition_schedule_lines(
             organization_id, contract_id, obligation_id, period_id, recognition_date,
             scheduled_amount, recognized_amount, status
           )
           VALUES ($1,$2,$3,$4,$5,$6,0,'scheduled')
           ON CONFLICT DO NOTHING`,
          [orgId, contractId, o.id, period.id, sat, allocAmt.toFixed(6)]
        );
        linesCreated += 1;
      } else {
        // OVER_TIME
        const start = o.start_date || contract.start_date;
        const end = o.end_date || contract.end_date;
        if (!start || !end) throw new AppError(409, "OVER_TIME obligation requires start_date and end_date (on obligation or contract)");

        const periodsAll = await listPeriodsOverlappingRange(client, orgId, start, end);
        const periods = periodsAll.filter((p) => overlapDays(start, end, p.start_date, p.end_date) > 0);
        const totalDays = daysBetweenInclusive(start, end);
        if (totalDays <= 0) throw new AppError(409, "Invalid obligation date range");

        // allocate per-period by overlap days;rounding residual to last period
        let allocated = new Decimal(0);
        for (let i = 0;i < periods.length;i++) {
          const p = periods[i];
          const ov = overlapDays(start, end, p.start_date, p.end_date);
          let amt;
          if (i === periods.length - 1) {
            amt = allocAmt.minus(allocated);
          } else {
            amt = allocAmt.mul(new Decimal(ov).div(totalDays));
            // store at 6dp;posting rounds to 2dp as Tier-1 does
            amt = amt.toDecimalPlaces(6);
            allocated = allocated.plus(amt);
          }

          const recDate = p.end_date;// recognition anchored to period end
          await client.query(
            `INSERT INTO ifrs15_recognition_schedule_lines(
               organization_id, contract_id, obligation_id, period_id, recognition_date,
               scheduled_amount, recognized_amount, status
             )
             VALUES ($1,$2,$3,$4,$5,$6,0,'scheduled')
             ON CONFLICT DO NOTHING`,
            [orgId, contractId, o.id, p.id, recDate, amt.toFixed(6)]
          );
          linesCreated += 1;
        }
      }
    }

    await recordEvent(client, { orgId, contractId, actorUserId, eventType: "SCHEDULE_GENERATED", meta: { replace: !!payload.replace, linesCreated } });

    if (managedTx) await client.query("COMMIT");
    return { ok: true, lines_created: linesCreated };
  } catch (e) {
    if (managedTx) await client.query("ROLLBACK");
    throw e;
  } finally {
    if (managedTx) client.release();
  }
}

async function getSchedule({ orgId, contractId }) {
  const { rows } = await pool.query(
    `SELECT id, obligation_id, period_id, recognition_date, scheduled_amount, recognized_amount,
            status, posted_journal_id, posted_at
     FROM ifrs15_recognition_schedule_lines
     WHERE organization_id=$1 AND contract_id=$2
     ORDER BY recognition_date ASC`,
    [orgId, contractId]
  );
  return { lines: rows };
}

function effectiveTransactionPrice(contract) {
  const base = new Decimal(contract.base_transaction_price ?? contract.transaction_price ?? 0);
  const vc = new Decimal(contract.variable_consideration_included ? (contract.variable_consideration_included_amount ?? contract.variable_consideration_estimate ?? 0) : 0);
  return base.plus(vc);
}

async function rebuildUnpostedScheduleFromDate(client, { orgId, contractId, actorUserId, fromDate }) {
  // Delete unposted schedule lines from the first period that overlaps fromDate onwards.
  // Keep posted lines intact.
  const d = asDateOnly(fromDate);
  await client.query(
    `DELETE FROM ifrs15_recognition_schedule_lines
     WHERE organization_id=$1 AND contract_id=$2 AND status IN ('open','scheduled') AND recognition_date >= $3`,
    [orgId, contractId, d]
  );

  // Re-generate schedule lines (idempotent via ON CONFLICT DO NOTHING). Posted lines will remain.
  await generateSchedule({ orgId, actorUserId, contractId, payload: { replace: false, from_date: d }, client });
}

async function reallocateAllocations(client, { orgId, contractId, actorUserId, sourceEvent, sourceId, effectiveDate }) {
  const contract = await getContractOrThrow(client, orgId, contractId);
  const obligations = await listObligations(client, orgId, contractId);
  if (!obligations.length) throw new AppError(409, "Contract has no performance obligations");

  const effPrice = effectiveTransactionPrice(contract);
  const totalSsp = obligations.reduce((s, o) => s.plus(new Decimal(o.standalone_selling_price || 0)), new Decimal(0));
  if (totalSsp.lte(0)) throw new AppError(409, "Total standalone selling price must be > 0");

  const snap = [];
  for (const o of obligations) {
    const ssp = new Decimal(o.standalone_selling_price || 0);
    const ratio = ssp.div(totalSsp);
    const alloc = effPrice.mul(ratio).toDecimalPlaces(6);
    await client.query(
      `UPDATE ifrs15_performance_obligations
       SET allocated_amount=$1, updated_at=NOW()
       WHERE id=$2 AND contract_id=$3`,
      [alloc.toFixed(6), o.id, contractId]
    );
    snap.push({ obligation_id: o.id, ssp: ssp.toFixed(6), ratio: ratio.toFixed(12), allocated_amount: alloc.toFixed(6) });
  }

  // Update contract.transaction_price to the effective transaction price to keep Stage 1 flows consistent
  await client.query(
    `UPDATE ifrs15_contracts SET transaction_price=$2, updated_at=NOW() WHERE organization_id=$1 AND id=$3`,
    [orgId, effPrice.toFixed(6), contractId]
  );

  await client.query(
    `INSERT INTO ifrs15_reallocation_snapshots(contract_id, source_event, source_id, effective_date, total_ssp, transaction_price_effective, snapshot_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [contractId, sourceEvent, sourceId || null, asDateOnly(effectiveDate), totalSsp.toFixed(6), effPrice.toFixed(6), JSON.stringify({ obligations: snap })]
  );

  await recordEvent(client, {
    orgId,
    contractId,
    actorUserId,
    eventType: "REALLOCATION",
    meta: { source_event: sourceEvent, source_id: sourceId || null, effective_date: asDateOnly(effectiveDate), transaction_price_effective: effPrice.toFixed(6) },
  });

  await rebuildUnpostedScheduleFromDate(client, { orgId, contractId, actorUserId, fromDate: effectiveDate });
}

async function postRevenueForPeriod({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const settings = await getSettingsOrThrow(client, orgId);
    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active");

    // Period
    const { rows: pRows } = await client.query(
      `SELECT id, status, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.period_id]
    );
    if (!pRows.length) throw new AppError(400, "Invalid period_id");
    const period = pRows[0];

    const entryDate = payload.entry_date ? asDateOnly(payload.entry_date) : period.end_date;

    // Find unposted schedule lines for this period
    const { rows: lines } = await client.query(
      `SELECT id, scheduled_amount, recognized_amount
       FROM ifrs15_recognition_schedule_lines
       WHERE organization_id=$1 AND contract_id=$2 AND period_id=$3 AND status IN ('open','scheduled')
       ORDER BY recognition_date ASC`,
      [orgId, contractId, period.id]
    );

    if (!lines.length) throw new AppError(409, "No open schedule lines for this period");

    const toRecognize = lines.reduce(
      (s, l) => s.plus(new Decimal(l.scheduled_amount).minus(l.recognized_amount || 0)),
      new Decimal(0)
    );

    if (toRecognize.lte(0)) throw new AppError(409, "Nothing to recognize");

    // Determine debit account
    let debitAccount;
    if (contract.billing_policy === "UPFRONT") debitAccount = settings.contract_liability_account_id;
    else debitAccount = settings.contract_asset_account_id;

    const memo = payload.memo || `IFRS15 revenue recognition for contract ${contract.code}`;
    const idempotencyKey = `IFRS15:CONTRACT:${contractId}:PERIOD:${period.id}:REV`;

    const j = await journalPosting.postJournal({
      orgId,
      actorUserId,
      payload: {
        typeCode: "GENERAL",
        periodId: period.id,
        entryDate,
        memo,
        idempotencyKey,
        lines: [
          { accountId: debitAccount, debit: toRecognize.toFixed(2), credit: 0, description: "Revenue recognition" },
          { accountId: settings.revenue_account_id, debit: 0, credit: toRecognize.toFixed(2), description: "Revenue" },
        ],
      },
    });

    const journalId = j.journalId || j.journal_id || null;

    // Update schedule lines as posted
    await client.query(
      `UPDATE ifrs15_recognition_schedule_lines
       SET recognized_amount = scheduled_amount,
           status='posted',
           posted_journal_id=$4,
           posted_at=NOW()
       WHERE organization_id=$1 AND contract_id=$2 AND period_id=$3 AND status IN ('open','scheduled')`,
      [orgId, contractId, period.id, journalId]
    );

    await client.query(
      `INSERT INTO ifrs15_posting_ledger(organization_id, contract_id, period_id, event_type, idempotency_key, journal_id, actor_user_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [orgId, contractId, period.id, "REVENUE_RECOGNITION", idempotencyKey, journalId, actorUserId, JSON.stringify({ amount: toRecognize.toFixed(6) })]
    );

    await recordEvent(client, { orgId, contractId, actorUserId, eventType: "REVENUE_POSTED", meta: { period_id: period.id, amount: toRecognize.toFixed(6), journalId } });

    await client.query("COMMIT");

    return { ok: true, period_id: period.id, recognized_amount: toRecognize.toFixed(6), journal_id: journalId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// -------------------------
// Stage 2: Contract modifications & reallocation
// -------------------------

async function createModification({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active");

    const { rows } = await client.query(
      `INSERT INTO ifrs15_contract_modifications(
         organization_id, contract_id, modification_date, modification_type,
         new_base_transaction_price, notes,
         adds_distinct_goods_services, price_increase_commensurate_with_ssp, remaining_goods_services_distinct,
         status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)
       RETURNING *`,
      [
        orgId,
        contractId,
        asDateOnly(payload.modification_date),
        payload.modification_type,
        payload.new_base_transaction_price != null ? new Decimal(payload.new_base_transaction_price).toFixed(6) : null,
        payload.notes || null,
        payload.adds_distinct_goods_services ?? null,
        payload.price_increase_commensurate_with_ssp ?? null,
        payload.remaining_goods_services_distinct ?? null,
        actorUserId,
      ]
    );

    await recordEvent(client, {
      orgId,
      contractId,
      actorUserId,
      eventType: "MODIFICATION_CREATED",
      meta: { modification_id: rows[0].id, modification_date: asDateOnly(payload.modification_date), modification_type: payload.modification_type },
    });

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function applyModification({ orgId, actorUserId, contractId, modificationId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active");

    const { rows: mRows } = await client.query(
      `SELECT * FROM ifrs15_contract_modifications WHERE organization_id=$1 AND contract_id=$2 AND id=$3`,
      [orgId, contractId, modificationId]
    );
    if (!mRows.length) throw new AppError(404, "Modification not found");
    const mod = mRows[0];
    if (mod.status !== "draft") throw new AppError(409, "Modification already applied/voided");

    // Determine modification accounting treatment.
    const decisionInputs = {
      addsDistinctGoodsServices: payload?.adds_distinct_goods_services ?? mod.adds_distinct_goods_services,
      priceIncreaseCommensurateWithSSP:
        payload?.price_increase_commensurate_with_ssp ?? mod.price_increase_commensurate_with_ssp,
      remainingGoodsServicesDistinct: payload?.remaining_goods_services_distinct ?? mod.remaining_goods_services_distinct,
    };

    const decision = decideModificationOutcome(decisionInputs);

    // Persist decision outcome for auditability.
    await client.query(
      `UPDATE ifrs15_contract_modifications
       SET decision_outcome=$1, decision_basis=$2
       WHERE organization_id=$3 AND id=$4`,
      [decision.outcome, decision.basis, orgId, modificationId]
    );

    // Outcome 1: Separate contract (IFRS 15.20)
    if (decision.outcome === "SEPARATE_CONTRACT") {
      // Create a child contract representing the added distinct goods/services.
      // This keeps the original contract intact and avoids reallocation/catch-up.
      const parentBase = new Decimal(contract.base_transaction_price ?? contract.transaction_price ?? 0);
      if (mod.new_base_transaction_price == null) {
        throw new AppError(
          409,
          "Separate-contract classification requires new_base_transaction_price to derive the incremental transaction price"
        );
      }
      const newBase = new Decimal(mod.new_base_transaction_price);
      const delta = newBase.minus(parentBase);
      if (delta.lte(0)) {
        throw new AppError(409, "Separate-contract requires an increase in transaction price (delta > 0)");
      }

      const childCode = `${contract.code}-MOD-${String(modificationId).slice(0, 6)}`;

      const { rows: cRows } = await client.query(
        `INSERT INTO ifrs15_contracts(
           organization_id, business_partner_id, code, contract_date, currency_code, transaction_price,
           billing_policy, billing_account_id, status, start_date, end_date, created_by,
           base_transaction_price, parent_contract_id, source_modification_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$12,$13,$14)
         RETURNING id, code, status`,
        [
          orgId,
          contract.business_partner_id || null,
          childCode,
          asDateOnly(mod.modification_date),
          contract.currency_code || null,
          delta.toFixed(6),
          contract.billing_policy,
          contract.billing_account_id || null,
          asDateOnly(mod.modification_date),
          contract.end_date || null,
          actorUserId,
          delta.toFixed(6),
          contractId,
          modificationId,
        ]
      );

      const childId = cRows[0].id;

      await client.query(
        `UPDATE ifrs15_contract_modifications
         SET status='applied', applied_by=$1, applied_at=NOW(), separate_contract_id=$2
         WHERE organization_id=$3 AND id=$4`,
        [actorUserId, childId, orgId, modificationId]
      );

      await recordEvent(client, {
        orgId,
        contractId,
        actorUserId,
        eventType: "MODIFICATION_APPLIED",
        meta: {
          modification_id: modificationId,
          modification_date: asDateOnly(mod.modification_date),
          decision_outcome: decision.outcome,
          decision_basis: decision.basis,
          separate_contract_id: childId,
        },
      });

      await client.query("COMMIT");
      return { ok: true, modification_id: modificationId, decision: decision, separate_contract_id: childId };
    }

    // For NOT-separate outcomes, update the parent contract base transaction price if provided.
    if (mod.new_base_transaction_price != null) {
      await client.query(
        `UPDATE ifrs15_contracts SET base_transaction_price=$1, updated_at=NOW() WHERE organization_id=$2 AND id=$3`,
        [new Decimal(mod.new_base_transaction_price).toFixed(6), orgId, contractId]
      );
    }

    // Reallocation is required for prospective and cumulative outcomes.
    await reallocateAllocations(client, {
      orgId,
      contractId,
      actorUserId,
      sourceEvent: "MODIFICATION",
      sourceId: modificationId,
      effectiveDate: mod.modification_date,
    });

    // Outcome 2: Prospective modification (IFRS 15.21(a))
    // Reallocation + rebuild of UNPOSTED schedules is sufficient;no cumulative catch-up.
    if (decision.outcome === "PROSPECTIVE") {
      await client.query(
        `UPDATE ifrs15_contract_modifications
         SET status='applied', applied_by=$1, applied_at=NOW()
         WHERE organization_id=$2 AND id=$3`,
        [actorUserId, orgId, modificationId]
      );

      await recordEvent(client, {
        orgId,
        contractId,
        actorUserId,
        eventType: "MODIFICATION_APPLIED",
        meta: {
          modification_id: modificationId,
          modification_date: asDateOnly(mod.modification_date),
          decision_outcome: decision.outcome,
          decision_basis: decision.basis,
        },
      });

      await client.query("COMMIT");
      return { ok: true, modification_id: modificationId, decision: decision };
    }

    // Outcome 3: Cumulative catch-up (IFRS 15.21(b))
    const entryDate = payload?.entry_date ? asDateOnly(payload.entry_date) : asDateOnly(mod.modification_date);
    const memo = payload?.memo || `IFRS15 modification catch-up for contract ${contract.code}`;
    const idempotencyKey = `IFRS15:CONTRACT:${contractId}:MOD:${modificationId}:CATCHUP`;

    const obligations = await listObligations(client, orgId, contractId);
    const effDate = asDateOnly(mod.modification_date);

    const { rows: recognizedRows } = await client.query(
      `SELECT o.id AS obligation_id,
              SUM(l.recognized_amount) AS recognized_to_date
       FROM ifrs15_performance_obligations o
       JOIN ifrs15_recognition_schedule_lines l ON l.obligation_id=o.id
       WHERE l.organization_id=$1 AND l.contract_id=$2
         AND l.status='posted'
         AND l.recognition_date < $3
       GROUP BY o.id`,
      [orgId, contractId, effDate]
    );

    const recognizedMap = new Map(recognizedRows.map((r) => [r.obligation_id, new Decimal(r.recognized_to_date || 0)]));

    let catchup = new Decimal(0);
    for (const o of obligations) {
      const recognized = recognizedMap.get(o.id) || new Decimal(0);
      let shouldBe = new Decimal(0);

      if (o.obligation_type === "POINT_IN_TIME") {
        if (o.satisfaction_date && asDateOnly(o.satisfaction_date) < effDate) {
          shouldBe = new Decimal(o.allocated_amount || 0);
        }
      } else {
        // OVER_TIME
        if (o.satisfaction_method === "TIME" && o.start_date && o.end_date) {
          const start = asDateOnly(o.start_date);
          const end = asDateOnly(o.end_date);
          const total = new Decimal(daysBetweenInclusive(start, end));
          if (total.gt(0)) {
            // portion elapsed up to the day before effective date
            const cutoff = asDateOnly(new Date(new Date(effDate + "T00:00:00Z").getTime() - 86400000));
            const elapsed = new Decimal(overlapDays(start, end, start, cutoff));
            const pct = Decimal.min(new Decimal(1), Decimal.max(new Decimal(0), elapsed.div(total)));
            shouldBe = new Decimal(o.allocated_amount || 0).mul(pct).toDecimalPlaces(6);
          }
        }
        // OUTPUT/INPUT methods require progress measurement inputs;Stage 2 expects those,
        // but for now we keep catch-up conservative (0) unless already fully elapsed.
        if (shouldBe.isZero() && o.end_date && asDateOnly(o.end_date) < effDate) {
          shouldBe = new Decimal(o.allocated_amount || 0);
        }
      }

      catchup = catchup.plus(shouldBe.minus(recognized));
    }

    if (!catchup.isZero()) {
      const settings = await getSettingsOrThrow(client, orgId);
      const period = await findPeriodForDateOrThrow(client, orgId, entryDate);

      // Debit side depends on billing policy
      const offsetAccount = contract.billing_policy === "UPFRONT" ? settings.contract_liability_account_id : settings.contract_asset_account_id;

      const amount2dp = catchup.abs().toFixed(2);
      const isIncrease = catchup.greaterThan(0);
      const lines = isIncrease
        ? [
            { accountId: offsetAccount, debit: amount2dp, credit: 0, description: "Contract balance adjustment" },
            { accountId: settings.revenue_account_id, debit: 0, credit: amount2dp, description: "Revenue catch-up" },
          ]
        : [
            { accountId: settings.revenue_account_id, debit: amount2dp, credit: 0, description: "Revenue reversal" },
            { accountId: offsetAccount, debit: 0, credit: amount2dp, description: "Contract balance adjustment" },
          ];

      const j = await journalPosting.postJournal({
        orgId,
        actorUserId,
        payload: { typeCode: "GENERAL", periodId: period.id, entryDate, memo, idempotencyKey, lines },
      });
      const journalId = j.journalId || j.journal_id || null;

      await client.query(
        `INSERT INTO ifrs15_posting_ledger(organization_id, contract_id, period_id, event_type, idempotency_key, journal_id, actor_user_id, meta)
         VALUES ($1,$2,$3,'MODIFICATION_CATCHUP',$4,$5,$6,$7)
         ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        [orgId, contractId, period.id, idempotencyKey, journalId, actorUserId, JSON.stringify({ amount: catchup.toFixed(6) })]
      );
    }

    await client.query(
      `UPDATE ifrs15_contract_modifications
       SET status='applied', applied_by=$1, applied_at=NOW()
       WHERE organization_id=$2 AND id=$3`,
      [actorUserId, orgId, modificationId]
    );

    await recordEvent(client, {
      orgId,
      contractId,
      actorUserId,
      eventType: "MODIFICATION_APPLIED",
      meta: {
        modification_id: modificationId,
        modification_date: asDateOnly(mod.modification_date),
        decision_outcome: decision.outcome,
        decision_basis: decision.basis,
        catchup_amount: catchup.toFixed(6),
      },
    });

    await client.query("COMMIT");
    return { ok: true, modification_id: modificationId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// -------------------------
// Stage 2: Variable consideration
// -------------------------

// -------------------------
// Stage 2B: Variable consideration governance (IFRS 15 constraint)
// -------------------------

async function getVariableConsiderationOrThrow(client, orgId, contractId, vcId) {
  const { rows } = await client.query(
    `SELECT * FROM ifrs15_variable_consideration
     WHERE organization_id=$1 AND contract_id=$2 AND id=$3`,
    [orgId, contractId, vcId]
  );
  if (!rows.length) throw new AppError(404, "Variable consideration entry not found");
  return rows[0];
}

async function createVariableConsideration({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active");

    const effDate = asDateOnly(payload.effective_date);
    const estimate = new Decimal(payload.estimate_amount).toFixed(6);

    const { rows } = await client.query(
      `INSERT INTO ifrs15_variable_consideration(
         organization_id, contract_id, effective_date,
         method, estimate_amount,
         status, highly_probable_no_reversal, constraint_basis, rationale,
         include_in_transaction_price, included_amount,
         created_by
       )
       VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,FALSE,0,$9)
       RETURNING *`,
      [
        orgId,
        contractId,
        effDate,
        payload.method,
        estimate,
        !!payload.highly_probable_no_reversal,
        payload.constraint_basis || null,
        payload.rationale || null,
        actorUserId,
      ]
    );

    await recordEvent(client, {
      orgId,
      contractId,
      actorUserId,
      eventType: "VARIABLE_CONSIDERATION_CREATED",
      meta: { vc_id: rows[0].id, effective_date: effDate, method: payload.method, estimate_amount: estimate },
    });

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function reviewVariableConsideration({ orgId, actorUserId, contractId, variableConsiderationId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await getContractOrThrow(client, orgId, contractId);

    const vc = await getVariableConsiderationOrThrow(client, orgId, contractId, variableConsiderationId);
    if (vc.status === "APPROVED") throw new AppError(409, "Cannot review an approved entry");

    const { rows } = await client.query(
      `UPDATE ifrs15_variable_consideration
       SET status='REVIEWED', reviewed_by=$1, reviewed_at=NOW(), notes=$2
       WHERE organization_id=$3 AND contract_id=$4 AND id=$5
       RETURNING *`,
      [actorUserId, payload?.notes || null, orgId, contractId, variableConsiderationId]
    );

    await recordEvent(client, {
      orgId,
      contractId,
      actorUserId,
      eventType: "VARIABLE_CONSIDERATION_REVIEWED",
      meta: { vc_id: variableConsiderationId },
    });

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function approveVariableConsideration({ orgId, actorUserId, contractId, variableConsiderationId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await getContractOrThrow(client, orgId, contractId);

    const vc = await getVariableConsiderationOrThrow(client, orgId, contractId, variableConsiderationId);
    if (vc.status === "APPROVED") throw new AppError(409, "Already approved");

    // IFRS 15 constraint governance gate.
    if (!vc.highly_probable_no_reversal) {
      throw new AppError(409, "Cannot approve variable consideration without 'highly probable no reversal' assessment");
    }

    const include = !!payload.include_in_transaction_price;
    const includedAmount = include
      ? new Decimal(payload.included_amount ?? vc.estimate_amount ?? 0).toFixed(6)
      : new Decimal(0).toFixed(6);

    const { rows } = await client.query(
      `UPDATE ifrs15_variable_consideration
       SET status='APPROVED', approved_by=$1, approved_at=NOW(),
           include_in_transaction_price=$2,
           included_amount=$3,
           notes=COALESCE($4, notes)
       WHERE organization_id=$5 AND contract_id=$6 AND id=$7
       RETURNING *`,
      [actorUserId, include, includedAmount, payload?.notes || null, orgId, contractId, variableConsiderationId]
    );

    await recordEvent(client, {
      orgId,
      contractId,
      actorUserId,
      eventType: "VARIABLE_CONSIDERATION_APPROVED",
      meta: { vc_id: variableConsiderationId, include_in_transaction_price: include, included_amount: includedAmount },
    });

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function applyVariableConsideration({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active");

    const effDate = payload?.effective_date ? asDateOnly(payload.effective_date) : asDateOnly(new Date());

    const { rows } = await client.query(
      `SELECT *
       FROM ifrs15_variable_consideration
       WHERE organization_id=$1 AND contract_id=$2
         AND status='APPROVED'
         AND effective_date <= $3
       ORDER BY effective_date DESC, created_at DESC
       LIMIT 1`,
      [orgId, contractId, effDate]
    );
    if (!rows.length) throw new AppError(409, "No approved variable consideration entry is effective as of the requested date");

    const vc = rows[0];
    const include = !!vc.include_in_transaction_price;
    const includedAmount = include ? new Decimal(vc.included_amount || 0) : new Decimal(0);

    await client.query(
      `UPDATE ifrs15_contracts
       SET variable_consideration_estimate=$1,
           variable_consideration_method=$2,
           variable_consideration_included=$3,
           variable_consideration_included_amount=$4,
           updated_at=NOW()
       WHERE organization_id=$5 AND id=$6`,
      [
        new Decimal(vc.estimate_amount || 0).toFixed(6),
        vc.method,
        include,
        includedAmount.toFixed(6),
        orgId,
        contractId,
      ]
    );

    await recordEvent(client, {
      orgId,
      contractId,
      actorUserId,
      eventType: "VARIABLE_CONSIDERATION_APPLIED",
      meta: { vc_id: vc.id, effective_date: effDate, include_in_transaction_price: include, included_amount: includedAmount.toFixed(6) },
    });

    await reallocateAllocations(client, {
      orgId,
      contractId,
      actorUserId,
      sourceEvent: "VARIABLE_CONSIDERATION",
      sourceId: vc.id,
      effectiveDate: effDate,
    });

    await client.query("COMMIT");
    return { ok: true, applied_vc_id: vc.id };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// -------------------------
// Stage 2: Financing component
// -------------------------

async function setFinancingTerms({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active");

    const from = asDateOnly(payload.effective_from);
    const to = payload.effective_to ? asDateOnly(payload.effective_to) : null;
    const rate = new Decimal(payload.annual_rate).toFixed(6);

    await client.query(
      `INSERT INTO ifrs15_financing_terms(organization_id, contract_id, annual_rate, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (contract_id, effective_from) DO UPDATE SET
         annual_rate=EXCLUDED.annual_rate,
         effective_to=EXCLUDED.effective_to`,
      [orgId, contractId, rate, from, to, actorUserId]
    );

    await client.query(
      `UPDATE ifrs15_contracts
       SET financing_enabled=TRUE,
           financing_annual_rate=$1,
           financing_effective_from=$2,
           financing_effective_to=$3,
           updated_at=NOW()
       WHERE organization_id=$4 AND id=$5`,
      [rate, from, to, orgId, contractId]
    );

    await recordEvent(client, { orgId, contractId, actorUserId, eventType: "FINANCING_TERMS_SET", meta: { annual_rate: rate, effective_from: from, effective_to: to } });

    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function postFinancingForPeriod({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const settings = await getSettingsOrThrow(client, orgId);
    if (!settings.financing_interest_income_account_id || !settings.financing_interest_expense_account_id) {
      throw new AppError(409, "IFRS15 settings missing financing interest accounts");
    }

    const contract = await getContractOrThrow(client, orgId, contractId);
    if (!contract.financing_enabled) throw new AppError(409, "Financing terms not enabled for this contract");

    const { rows: pRows } = await client.query(
      `SELECT id, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.period_id]
    );
    if (!pRows.length) throw new AppError(400, "Invalid period_id");
    const period = pRows[0];

    // Compute contract balances at period start
    const start = period.start_date;
    const end = period.end_date;

    const { rows: rRows } = await client.query(
      `SELECT COALESCE(SUM(recognized_amount),0) AS recognized
       FROM ifrs15_recognition_schedule_lines
       WHERE organization_id=$1 AND contract_id=$2 AND status='posted' AND recognition_date < $3`,
      [orgId, contractId, start]
    );
    const recognizedToStart = new Decimal(rRows[0].recognized || 0);

    // Billing assumption for Stage 2: UPFRONT billed at activation, others assumed unbilled
    let billedToStart = new Decimal(0);
    if (contract.billing_policy === "UPFRONT") {
      const { rows: bRows } = await client.query(
        `SELECT COUNT(1) AS c
         FROM ifrs15_posting_ledger
         WHERE organization_id=$1 AND contract_id=$2 AND event_type='UPFRONT_BILLING' AND posted_at < $3`,
        [orgId, contractId, `${start}T00:00:00Z`]
      );
      if (Number(bRows[0].c || 0) > 0) billedToStart = new Decimal(contract.transaction_price || 0);
    }

    const contractLiability = Decimal.max(billedToStart.minus(recognizedToStart), new Decimal(0));
    const contractAsset = Decimal.max(recognizedToStart.minus(billedToStart), new Decimal(0));
    const net = contractAsset.minus(contractLiability);// + => asset (interest income), - => liability (interest expense)

    const annualRate = new Decimal(contract.financing_annual_rate || 0);
    const days = new Decimal(daysBetweenInclusive(start, end));
    const interest = net.abs().mul(annualRate).mul(days).div(365).toDecimalPlaces(6);
    if (interest.lte(0)) throw new AppError(409, "Nothing to post");

    const entryDate = payload.entry_date ? asDateOnly(payload.entry_date) : end;
    const memo = payload.memo || `IFRS15 financing component interest for contract ${contract.code}`;
    const idempotencyKey = `IFRS15:CONTRACT:${contractId}:PERIOD:${period.id}:FIN`;

    let lines;
    if (net.greaterThan(0)) {
      // Interest income on contract asset
      lines = [
        { accountId: settings.contract_asset_account_id, debit: interest.toFixed(2), credit: 0, description: "Interest accretion" },
        { accountId: settings.financing_interest_income_account_id, debit: 0, credit: interest.toFixed(2), description: "Interest income" },
      ];
    } else {
      // Interest expense on contract liability
      lines = [
        { accountId: settings.financing_interest_expense_account_id, debit: interest.toFixed(2), credit: 0, description: "Interest expense" },
        { accountId: settings.contract_liability_account_id, debit: 0, credit: interest.toFixed(2), description: "Interest accretion" },
      ];
    }

    const j = await journalPosting.postJournal({
      orgId,
      actorUserId,
      payload: { typeCode: "GENERAL", periodId: period.id, entryDate, memo, idempotencyKey, lines },
    });
    const journalId = j.journalId || j.journal_id || null;

    await client.query(
      `INSERT INTO ifrs15_posting_ledger(organization_id, contract_id, period_id, event_type, idempotency_key, journal_id, actor_user_id, meta)
       VALUES ($1,$2,$3,'FINANCING_INTEREST',$4,$5,$6,$7)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
      [orgId, contractId, period.id, idempotencyKey, journalId, actorUserId, JSON.stringify({ interest: interest.toFixed(6), net_balance: net.toFixed(6) })]
    );

    await recordEvent(client, { orgId, contractId, actorUserId, eventType: "FINANCING_POSTED", meta: { period_id: period.id, interest: interest.toFixed(6), journal_id: journalId } });

    await client.query("COMMIT");
    return { ok: true, interest_amount: interest.toFixed(6), journal_id: journalId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// -------------------------
// Stage 2: Capitalised contract costs
// -------------------------

async function createCost({ orgId, actorUserId, contractId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const settings = await getSettingsOrThrow(client, orgId);
    const contract = await getContractOrThrow(client, orgId, contractId);
    if (contract.status !== "active") throw new AppError(409, "Contract must be active");

    const assetAccount = payload.asset_account_id || settings.default_cost_asset_account_id;
    const amortExpAccount = payload.amort_expense_account_id || settings.default_cost_amort_expense_account_id;
    if (!assetAccount || !amortExpAccount) throw new AppError(409, "Missing cost asset/amort expense account mapping");

    const { rows } = await client.query(
      `INSERT INTO ifrs15_capitalised_costs(
         organization_id, contract_id, cost_type, description, amount,
         asset_account_id, amort_expense_account_id,
         amort_start_date, amort_end_date, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        orgId,
        contractId,
        payload.cost_type,
        payload.description || null,
        new Decimal(payload.amount).toFixed(6),
        assetAccount,
        amortExpAccount,
        asDateOnly(payload.amort_start_date),
        asDateOnly(payload.amort_end_date),
        actorUserId,
      ]
    );

    await recordEvent(client, { orgId, contractId, actorUserId, eventType: "COST_CREATED", meta: { cost_id: rows[0].id, amount: rows[0].amount } });

    await client.query("COMMIT");
    return rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listCosts({ orgId, contractId }) {
  const { rows } = await pool.query(
    `SELECT id, cost_type, description, amount, asset_account_id, amort_expense_account_id,
            amort_start_date, amort_end_date, status, created_at
     FROM ifrs15_capitalised_costs
     WHERE organization_id=$1 AND contract_id=$2
     ORDER BY created_at ASC`,
    [orgId, contractId]
  );
  return { costs: rows };
}

async function generateCostSchedule({ orgId, actorUserId, contractId, costId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: cRows } = await client.query(
      `SELECT * FROM ifrs15_capitalised_costs WHERE organization_id=$1 AND contract_id=$2 AND id=$3`,
      [orgId, contractId, costId]
    );
    if (!cRows.length) throw new AppError(404, "Cost not found");
    const cost = cRows[0];

    if (payload.replace) {
      await client.query(
        `DELETE FROM ifrs15_cost_amort_schedule_lines WHERE organization_id=$1 AND cost_id=$2`,
        [orgId, costId]
      );
    }

    const start = cost.amort_start_date;
    const end = cost.amort_end_date;
    const periodsAll = await listPeriodsOverlappingRange(client, orgId, start, end);
    const periods = periodsAll.filter((p) => overlapDays(start, end, p.start_date, p.end_date) > 0);
    const totalDays = daysBetweenInclusive(start, end);
    if (totalDays <= 0) throw new AppError(409, "Invalid amortisation date range");

    const total = new Decimal(cost.amount || 0);
    let allocated = new Decimal(0);
    let linesCreated = 0;
    for (let i = 0;i < periods.length;i++) {
      const p = periods[i];
      const ov = overlapDays(start, end, p.start_date, p.end_date);
      let amt;
      if (i === periods.length - 1) {
        amt = total.minus(allocated);
      } else {
        amt = total.mul(new Decimal(ov).div(totalDays)).toDecimalPlaces(6);
        allocated = allocated.plus(amt);
      }
      await client.query(
        `INSERT INTO ifrs15_cost_amort_schedule_lines(
           organization_id, cost_id, contract_id, period_id, recognition_date, scheduled_amount, status
         ) VALUES ($1,$2,$3,$4,$5,$6,'scheduled')
         ON CONFLICT DO NOTHING`,
        [orgId, costId, contractId, p.id, p.end_date, amt.toFixed(6)]
      );
      linesCreated += 1;
    }

    await recordEvent(client, { orgId, contractId, actorUserId, eventType: "COST_SCHEDULE_GENERATED", meta: { cost_id: costId, linesCreated } });
    await client.query("COMMIT");
    return { ok: true, lines_created: linesCreated };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function postCostAmortForPeriod({ orgId, actorUserId, contractId, costId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: cRows } = await client.query(
      `SELECT * FROM ifrs15_capitalised_costs WHERE organization_id=$1 AND contract_id=$2 AND id=$3`,
      [orgId, contractId, costId]
    );
    if (!cRows.length) throw new AppError(404, "Cost not found");
    const cost = cRows[0];

    const { rows: pRows } = await client.query(
      `SELECT id, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
      [orgId, payload.period_id]
    );
    if (!pRows.length) throw new AppError(400, "Invalid period_id");
    const period = pRows[0];

    const { rows: lRows } = await client.query(
      `SELECT * FROM ifrs15_cost_amort_schedule_lines
       WHERE organization_id=$1 AND cost_id=$2 AND period_id=$3 AND status IN ('scheduled','open')`,
      [orgId, costId, period.id]
    );
    if (!lRows.length) throw new AppError(409, "No amortisation lines to post for this period");

    const amount = lRows.reduce((s, l) => s.plus(new Decimal(l.scheduled_amount || 0)), new Decimal(0));
    if (amount.lte(0)) throw new AppError(409, "Nothing to post");

    const entryDate = payload.entry_date ? asDateOnly(payload.entry_date) : period.end_date;
    const memo = payload.memo || `IFRS15 cost amortisation for contract ${contractId}`;
    const idempotencyKey = `IFRS15:COST:${costId}:PERIOD:${period.id}:AMORT`;

    const j = await journalPosting.postJournal({
      orgId,
      actorUserId,
      payload: {
        typeCode: "GENERAL",
        periodId: period.id,
        entryDate,
        memo,
        idempotencyKey,
        lines: [
          { accountId: cost.amort_expense_account_id, debit: amount.toFixed(2), credit: 0, description: "Amortisation expense" },
          { accountId: cost.asset_account_id, debit: 0, credit: amount.toFixed(2), description: "Contract cost amortisation" },
        ],
      },
    });
    const journalId = j.journalId || j.journal_id || null;

    await client.query(
      `UPDATE ifrs15_cost_amort_schedule_lines
       SET status='posted', posted_journal_id=$4, posted_at=NOW()
       WHERE organization_id=$1 AND cost_id=$2 AND period_id=$3 AND status IN ('scheduled','open')`,
      [orgId, costId, period.id, journalId]
    );

    await client.query("COMMIT");
    return { ok: true, journal_id: journalId, amort_amount: amount.toFixed(6) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// -------------------------
// Stage 2: Disclosure report
// -------------------------

async function contractRollforwardReport({ orgId, periodId }) {
  const { rows: pRows } = await pool.query(
    `SELECT id, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, periodId]
  );
  if (!pRows.length) throw new AppError(400, "Invalid period_id");
  const period = pRows[0];

  const { rows: contracts } = await pool.query(
    `SELECT id, code, billing_policy, transaction_price
     FROM ifrs15_contracts
     WHERE organization_id=$1 AND status IN ('active','completed')
     ORDER BY code ASC`,
    [orgId]
  );

  const out = [];
  for (const c of contracts) {
    const { rows: recPrev } = await pool.query(
      `SELECT COALESCE(SUM(recognized_amount),0) AS amt
       FROM ifrs15_recognition_schedule_lines
       WHERE organization_id=$1 AND contract_id=$2 AND status='posted' AND recognition_date < $3`,
      [orgId, c.id, period.start_date]
    );
    const { rows: recThis } = await pool.query(
      `SELECT COALESCE(SUM(recognized_amount),0) AS amt
       FROM ifrs15_recognition_schedule_lines
       WHERE organization_id=$1 AND contract_id=$2 AND status='posted' AND recognition_date >= $3 AND recognition_date <= $4`,
      [orgId, c.id, period.start_date, period.end_date]
    );

    const recognizedToStart = new Decimal(recPrev[0].amt || 0);
    const recognizedInPeriod = new Decimal(recThis[0].amt || 0);
    let billedToStart = new Decimal(0);
    let billedInPeriod = new Decimal(0);

    if (c.billing_policy === "UPFRONT") {
      // if activation billing posted, treat full transaction price as billed
      const { rows: bPrev } = await pool.query(
        `SELECT COUNT(1) AS c
         FROM ifrs15_posting_ledger
         WHERE organization_id=$1 AND contract_id=$2 AND event_type='UPFRONT_BILLING' AND posted_at < $3`,
        [orgId, c.id, `${period.start_date}T00:00:00Z`]
      );
      const { rows: bThis } = await pool.query(
        `SELECT COUNT(1) AS c
         FROM ifrs15_posting_ledger
         WHERE organization_id=$1 AND contract_id=$2 AND event_type='UPFRONT_BILLING' AND posted_at >= $3 AND posted_at <= $4`,
        [orgId, c.id, `${period.start_date}T00:00:00Z`, `${period.end_date}T23:59:59Z`]
      );
      if (Number(bPrev[0].c || 0) > 0) billedToStart = new Decimal(c.transaction_price || 0);
      if (Number(bThis[0].c || 0) > 0) billedInPeriod = new Decimal(c.transaction_price || 0);
    }

    const openLiability = Decimal.max(billedToStart.minus(recognizedToStart), new Decimal(0));
    const openAsset = Decimal.max(recognizedToStart.minus(billedToStart), new Decimal(0));
    const closeRecognized = recognizedToStart.plus(recognizedInPeriod);
    const closeBilled = billedToStart.plus(billedInPeriod);
    const closeLiability = Decimal.max(closeBilled.minus(closeRecognized), new Decimal(0));
    const closeAsset = Decimal.max(closeRecognized.minus(closeBilled), new Decimal(0));

    out.push({
      contract_id: c.id,
      code: c.code,
      opening_contract_liability: openLiability.toFixed(6),
      opening_contract_asset: openAsset.toFixed(6),
      billings_in_period: billedInPeriod.toFixed(6),
      revenue_recognised_in_period: recognizedInPeriod.toFixed(6),
      closing_contract_liability: closeLiability.toFixed(6),
      closing_contract_asset: closeAsset.toFixed(6),
    });
  }

  return { period_id: period.id, start_date: period.start_date, end_date: period.end_date, contracts: out };
}



// -------------------------
// Stage 2C: disclosures & reporting
// -------------------------

async function remainingPerformanceObligationsReport({ orgId, asOfPeriodId }) {
  const { rows: pRows } = await pool.query(
    `SELECT id, start_date, end_date FROM accounting_periods WHERE organization_id=$1 AND id=$2`,
    [orgId, asOfPeriodId]
  );
  if (!pRows.length) throw new AppError(404, "Period not found");
  const asOf = pRows[0];

  const { rows } = await pool.query(
    `SELECT l.period_id, p.start_date, p.end_date, SUM(l.scheduled_amount - l.recognized_amount) AS remaining_amount
     FROM ifrs15_recognition_schedule_lines l
     JOIN accounting_periods p ON p.id = l.period_id
     JOIN ifrs15_contracts c ON c.id = l.contract_id
     WHERE l.organization_id=$1
       AND p.start_date > $2
       AND c.status IN ('active','completed')
       AND l.status IN ('scheduled','open')
     GROUP BY l.period_id, p.start_date, p.end_date
     ORDER BY p.start_date ASC`,
    [orgId, asOf.end_date]
  );

  const buckets = rows.map(r => ({
    period_id: r.period_id,
    start_date: r.start_date,
    end_date: r.end_date,
    remaining_amount: new Decimal(r.remaining_amount || 0).toFixed(6),
  }));

  const totalRemaining = buckets.reduce((s, b) => s.plus(new Decimal(b.remaining_amount)), new Decimal(0));

  return {
    as_of_period_id: asOfPeriodId,
    as_of_end_date: asOf.end_date,
    total_remaining_amount: totalRemaining.toFixed(6),
    buckets,
  };
}

async function revenueDisaggregationReport({ orgId, periodId, dimension }) {
  // Uses posted schedule lines as the revenue journal basis.
  const dim = dimension || 'OBLIGATION_TYPE';

  let groupExpr;
  let joinExtra = '';
  if (dim === 'SATISFACTION_METHOD') {
    groupExpr = 'o.satisfaction_method';
  } else if (dim === 'CUSTOMER') {
    groupExpr = 'c.business_partner_id';
  } else {
    groupExpr = 'o.obligation_type';
  }

  const { rows } = await pool.query(
    `SELECT ${groupExpr} AS dimension_value,
            SUM(l.recognized_amount) AS revenue_amount
     FROM ifrs15_recognition_schedule_lines l
     JOIN ifrs15_performance_obligations o ON o.id = l.obligation_id
     JOIN ifrs15_contracts c ON c.id = l.contract_id
     WHERE l.organization_id=$1
       AND l.period_id=$2
       AND l.status='posted'
     GROUP BY ${groupExpr}
     ORDER BY ${groupExpr} ASC NULLS LAST`,
    [orgId, periodId]
  );

  return {
    period_id: periodId,
    dimension: dim,
    lines: rows.map(r => ({
      dimension_value: r.dimension_value,
      revenue_amount: new Decimal(r.revenue_amount || 0).toFixed(6),
    })),
  };
}

async function judgementsReport({ orgId, asOfDate }) {
  const d = asOfDate ? asDateOnly(asOfDate) : null;

  const { rows } = await pool.query(
    `SELECT
       c.id AS contract_id,
       c.code AS contract_code,
       c.business_partner_id,
       c.status AS contract_status,
       c.billing_policy,
       c.base_transaction_price,
       c.variable_consideration_method,
       c.variable_consideration_included,
       c.variable_consideration_included_amount,
       c.financing_enabled,
       c.financing_annual_rate,
       c.financing_effective_from,
       o.id AS obligation_id,
       o.description,
       o.obligation_type,
       o.satisfaction_method,
       o.start_date,
       o.end_date,
       o.satisfaction_date,
       o.standalone_selling_price,
       o.created_at
     FROM ifrs15_contracts c
     JOIN ifrs15_performance_obligations o ON o.contract_id = c.id
     WHERE c.organization_id=$1
       AND c.status IN ('active','completed')
       AND ($2::date IS NULL OR o.created_at::date <= $2::date)
     ORDER BY c.code ASC, o.created_at ASC`,
    [orgId, d]
  );

  return {
    as_of_date: d,
    obligations: rows.map(r => ({
      contract_id: r.contract_id,
      contract_code: r.contract_code,
      business_partner_id: r.business_partner_id,
      contract_status: r.contract_status,
      billing_policy: r.billing_policy,
      base_transaction_price: new Decimal(r.base_transaction_price || 0).toFixed(6),
      variable_consideration_method: r.variable_consideration_method,
      variable_consideration_included: !!r.variable_consideration_included,
      variable_consideration_included_amount: new Decimal(r.variable_consideration_included_amount || 0).toFixed(6),
      financing_enabled: !!r.financing_enabled,
      financing_annual_rate: r.financing_annual_rate,
      financing_effective_from: r.financing_effective_from,
      obligation_id: r.obligation_id,
      description: r.description,
      obligation_type: r.obligation_type,
      satisfaction_method: r.satisfaction_method,
      start_date: r.start_date,
      end_date: r.end_date,
      satisfaction_date: r.satisfaction_date,
      standalone_selling_price: new Decimal(r.standalone_selling_price || 0).toFixed(6),
    })),
  };
}
module.exports = {
  getSettings,
  upsertSettings,
  listContracts,
  createContract,
  getContract,
  addObligation,
  activateContract,
  generateSchedule,
  getSchedule,
  postRevenueForPeriod,
  // Stage 2
  createModification,
  applyModification,
  // Stage 2B
  createVariableConsideration,
  reviewVariableConsideration,
  approveVariableConsideration,
  applyVariableConsideration,
  // Stage 2: financing & costs
  setFinancingTerms,
  postFinancingForPeriod,
  createCost,
  listCosts,
  generateCostSchedule,
  postCostAmortForPeriod,
  // Stage 2C: disclosures
  contractRollforwardReport,
  remainingPerformanceObligationsReport,
  revenueDisaggregationReport,
  judgementsReport,
};
