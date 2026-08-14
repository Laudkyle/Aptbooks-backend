const { pool } = require("../../../db/pool");
const { AppError } = require("../../../shared/errors/AppError");
const { parseDecimalToBigInt, bigIntToDecimalString, divideAndRoundHalfUp } = require("../../../shared/utils/money");
const { enqueueEvent } = require("../../../modules/webhooks/webhooks.service");
const documentableSvc = require("../../../workflow/documents/documentable.service");

// Banking integration: record posted journals that affect bank accounts into bank_transactions
// so the cashbook/reconciliation views can include operational transactions (receipts/payments/journals)
// without waiting for statement imports.
const bankTransactionsRepo = require("../../../modules/banking/bank-transactions/bankTransactions.repository");

async function getOrgBaseCurrency(client, orgId) {
  const { rows } = await client.query(
    `SELECT base_currency_code FROM organizations WHERE id=$1`,
    [orgId]
  );
  if (!rows.length) throw new AppError(400, "Invalid organization");
  return rows[0].base_currency_code;
}

function parseRateToMicro(rate) {
  // 6dp rate precision
  return parseDecimalToBigInt(rate || 1, 6);
}

function computeBaseCents({ amountCents, rateMicro }) {
  // Explicit accounting policy: convert to base-currency minor units using
  // round-half-up. Plain BigInt division would truncate fractional cents.
  return divideAndRoundHalfUp(amountCents * rateMicro, 1000000n);
}

async function lookupFxRateMicro(client, { orgId, rateTypeCode = "SPOT", fromCurrency, toCurrency, asOfDate }) {
  if (!asOfDate) throw new AppError(400, "entryDate required for FX lookup");
  if (!fromCurrency || !toCurrency) throw new AppError(400, "currency required for FX lookup");
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();
  if (from === to) return 1000000n;

  const { rows: rt } = await client.query(
    "SELECT id FROM exchange_rate_types WHERE code=$1",
    [String(rateTypeCode).toUpperCase()]
  );
  if (!rt.length) throw new AppError(400, `Unknown FX rate type: ${rateTypeCode}`);
  const rateTypeId = rt[0].id;

  const direct = await client.query(
    `SELECT rate
     FROM exchange_rates
     WHERE organization_id=$1
       AND rate_type_id=$2
       AND from_currency=$3
       AND to_currency=$4
       AND effective_date <= $5
     ORDER BY effective_date DESC
     LIMIT 1`,
    [orgId, rateTypeId, from, to, asOfDate]
  );
  if (direct.rows.length) return parseRateToMicro(direct.rows[0].rate);

  const inv = await client.query(
    `SELECT rate
     FROM exchange_rates
     WHERE organization_id=$1
       AND rate_type_id=$2
       AND from_currency=$3
       AND to_currency=$4
       AND effective_date <= $5
     ORDER BY effective_date DESC
     LIMIT 1`,
    [orgId, rateTypeId, to, from, asOfDate]
  );
  if (inv.rows.length) {
    const baseMicro = parseRateToMicro(inv.rows[0].rate);
    if (baseMicro <= 0n) throw new AppError(400, "Invalid stored FX rate");
    // Invert using the same explicit half-up policy at 6dp precision.
    return divideAndRoundHalfUp(1000000n * 1000000n, baseMicro);
  }

  throw new AppError(404, `No FX rate found for ${from}/${to} as of ${asOfDate}`);
}

function sumBaseCents(lines) {
  return lines.reduce(
    (acc, l) => {
      const debitCents = parseDecimalToBigInt(l.debit || 0, 2);
      const creditCents = parseDecimalToBigInt(l.credit || 0, 2);
      const baseCents = parseDecimalToBigInt(l.amount_base || 0, 2);
      if (debitCents > 0n) acc.debit += baseCents;
      if (creditCents > 0n) acc.credit += baseCents;
      return acc;
    },
    { debit: 0n, credit: 0n }
  );
}

function sum2(lines) {
  // Sums using amount_base when available (base currency equivalent).
  return lines.reduce((acc, l) => {
    const debitC = parseDecimalToBigInt(l.debit || 0, 2);
    const creditC = parseDecimalToBigInt(l.credit || 0, 2);
    const base =
      ("amount_base" in l && l.amount_base != null)
        ? parseDecimalToBigInt(l.amount_base || 0, 2)
        : (debitC > 0n ? debitC : creditC);

    if (debitC > 0n) acc.debit += base;
    if (creditC > 0n) acc.credit += base;
    return acc;
  }, { debit: 0n, credit: 0n });
}

async function getPeriodForUpdate(client, orgId, periodId) {
  const { rows } = await client.query(
    `SELECT id, status, start_date, end_date
     FROM accounting_periods
     WHERE organization_id=$1 AND id=$2
     FOR SHARE`,
    [orgId, periodId]
  );
  if (!rows.length) throw new AppError(400, "Invalid period");
  return rows[0];
}

function assertEntryDateWithinPeriod(entryDate, period) {
  const d = new Date(entryDate + "T00:00:00Z").getTime();
  const s = new Date(period.start_date + "T00:00:00Z").getTime();
  const e = new Date(period.end_date + "T00:00:00Z").getTime();
  if (d < s || d > e) throw new AppError(409, "entryDate must be within the selected period");
}

// -----------------------------------------------------------------------------
// Workflow settings helpers
// -----------------------------------------------------------------------------

async function getWorkflowSettings(client, { orgId }) {
  const { rows } = await client.query(
    `
    SELECT
      creator_can_approve,
      creator_can_post,
      allow_self_approval,
      require_comment_on_rejection,
      notify_creator_on_approval,
      notify_creator_on_rejection
    FROM document_workflow_statics
    WHERE organization_id = $1
      AND (entity_type = 'journal_entry' OR entity_type IS NULL)
    ORDER BY
      CASE WHEN entity_type = 'journal_entry' THEN 0 ELSE 1 END,
      CASE WHEN document_type_id IS NOT NULL THEN 0 ELSE 1 END,
      updated_at DESC,
      created_at DESC
    LIMIT 1
    `,
    [orgId]
  );

  return rows[0] || {
    creator_can_approve: false,
    creator_can_post: false,
    allow_self_approval: false,
    require_comment_on_rejection: true,
    notify_creator_on_approval: true,
    notify_creator_on_rejection: true,
  };
}

function isSameUser(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

function assertCanApprove({ settings, creatorUserId, actorUserId }) {
  const isCreator = isSameUser(creatorUserId, actorUserId);
  if (!isCreator) return;

  if (settings.allow_self_approval || settings.creator_can_approve) return;

  throw new AppError(403, "Workflow settings do not allow the creator to approve this journal");
}

function assertCanReject({ settings, creatorUserId, actorUserId }) {
  const isCreator = isSameUser(creatorUserId, actorUserId);
  if (!isCreator) return;

  if (settings.allow_self_approval || settings.creator_can_approve) return;

  throw new AppError(403, "Workflow settings do not allow the creator to reject this journal");
}

function assertCanPost({ settings, creatorUserId, actorUserId }) {
  const isCreator = isSameUser(creatorUserId, actorUserId);
  if (!isCreator) return;

  if (settings.creator_can_post) return;

  throw new AppError(403, "Workflow settings do not allow the creator to post this journal");
}

function assertRejectionCommentRequired({ settings, reason }) {
  if (settings.require_comment_on_rejection && !String(reason || "").trim()) {
    throw new AppError(400, "Rejection comment is required by workflow settings");
  }
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

async function validateAccountIsUsable(client, { orgId, accountId }) {
  const { rows } = await client.query(
    `SELECT is_postable, status
     FROM chart_of_accounts
     WHERE organization_id=$1 AND id=$2`,
    [orgId, accountId]
  );
  if (!rows.length) throw new AppError(400, "Invalid accountId");
  if (!rows[0].is_postable) throw new AppError(400, "Non-postable account used");
  if (rows[0].status !== "active") throw new AppError(400, "Inactive account used");
}

async function prepareDraftLines(client, { orgId, entryDate, lines, baseCurrency, payloadRateTypeCode = "SPOT", requireBalanced = true }) {
  const preparedLines = [];

  for (const l of lines || []) {
    await validateAccountIsUsable(client, { orgId, accountId: l.accountId });

    const currencyCode = String(l.currencyCode || l.currency_code || baseCurrency).toUpperCase();
    const debitCents = parseDecimalToBigInt(l.debit || 0, 2);
    const creditCents = parseDecimalToBigInt(l.credit || 0, 2);

    if ((debitCents > 0n && creditCents > 0n) || (debitCents === 0n && creditCents === 0n)) {
      throw new AppError(400, "Each journal line must have either debit or credit");
    }

    const amountCents = debitCents > 0n ? debitCents : creditCents;

    let rateMicro = 1000000n;
    if (currencyCode !== baseCurrency) {
      if (l.fxRate != null) {
        rateMicro = parseRateToMicro(l.fxRate);
      } else {
        rateMicro = await lookupFxRateMicro(client, {
          orgId,
          rateTypeCode: l.rateTypeCode || payloadRateTypeCode || "SPOT",
          fromCurrency: currencyCode,
          toCurrency: baseCurrency,
          asOfDate: entryDate,
        });
      }
    }

    const amountBaseCents =
      currencyCode === baseCurrency
        ? amountCents
        : computeBaseCents({ amountCents, rateMicro });

    preparedLines.push({
      ...l,
      currencyCode,
      fxRateMicro: rateMicro,
      amountBaseCents,
    });
  }

  const totals = preparedLines.reduce(
    (acc, l) => {
      const debit = parseDecimalToBigInt(l.debit || 0, 2);
      const credit = parseDecimalToBigInt(l.credit || 0, 2);
      if (debit > 0n) acc.debit += l.amountBaseCents;
      if (credit > 0n) acc.credit += l.amountBaseCents;
      return acc;
    },
    { debit: 0n, credit: 0n }
  );

  if (requireBalanced && totals.debit !== totals.credit) {
    throw new AppError(400, "Journal not balanced in base currency");
  }

  return preparedLines;
}

async function createDraftJournal({ orgId, actorUserId, payload, client: existingClient = null }) {
  const client = existingClient || (await pool.connect());
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query("BEGIN");

    const baseCurrency = await getOrgBaseCurrency(client, orgId);

    // idempotency
    if (payload.idempotencyKey) {
      const { rows: existing } = await client.query(
        `SELECT id, status
         FROM journal_entries
         WHERE organization_id=$1 AND idempotency_key=$2`,
        [orgId, payload.idempotencyKey]
      );
      if (existing.length) {
        if (managesTx) await client.query("COMMIT");
        return { journalId: existing[0].id, status: existing[0].status, idempotent: true };
      }
    }

    const period = await getPeriodForUpdate(client, orgId, payload.periodId);
    if (period.status !== "open") throw new AppError(409, "Period not open");
    assertEntryDateWithinPeriod(payload.entryDate, period);

    const { rows: tRows } = await client.query(
      `SELECT id FROM journal_entry_types WHERE code=$1`,
      [payload.typeCode || "GENERAL"]
    );
    if (!tRows.length) throw new AppError(400, "Invalid journal entry type");
    const typeId = tRows[0].id;

    const preparedLines = await prepareDraftLines(client, {
      orgId,
      entryDate: payload.entryDate,
      lines: payload.lines || [],
      baseCurrency,
      payloadRateTypeCode: payload.rateTypeCode || "SPOT",
    });

    const { rows: jRows } = await client.query(
      `
      INSERT INTO journal_entries
        (organization_id, journal_entry_type_id, period_id, entry_date, memo, status, idempotency_key, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$7)
      ON CONFLICT (organization_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id, status
      `,
      [
        orgId,
        typeId,
        payload.periodId,
        payload.entryDate,
        payload.memo || null,
        payload.idempotencyKey || null,
        actorUserId
      ]
    );

    // Concurrent callers can both pass the initial lookup. The unique partial
    // index serializes the insert; the loser resolves to the committed journal
    // instead of surfacing a unique-violation/500 to the client.
    if (!jRows.length && payload.idempotencyKey) {
      const { rows: raced } = await client.query(
        `SELECT id, status FROM journal_entries WHERE organization_id=$1 AND idempotency_key=$2`,
        [orgId, payload.idempotencyKey]
      );
      if (!raced.length) throw new AppError(409, "Idempotent journal creation conflicted; retry request");
      if (managesTx) await client.query("COMMIT");
      return { journalId: raced[0].id, status: raced[0].status, idempotent: true };
    }

    const journalId = jRows[0].id;

    for (let i = 0; i < preparedLines.length; i++) {
      const l = preparedLines[i];
      const debitBI = parseDecimalToBigInt(l.debit || 0, 2);
      const creditBI = parseDecimalToBigInt(l.credit || 0, 2);

      await client.query(
        `
        INSERT INTO journal_entry_lines
          (journal_entry_id, line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          journalId,
          i + 1,
          l.accountId,
          l.description || null,
          bigIntToDecimalString(debitBI, 2),
          bigIntToDecimalString(creditBI, 2),
          l.currencyCode,
          bigIntToDecimalString(l.fxRateMicro, 6),
          bigIntToDecimalString(l.amountBaseCents, 2)
        ]
      );
    }

    if (managesTx) await client.query("COMMIT");
    return { journalId, status: "draft" };
  } catch (e) {
    if (managesTx) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    throw e;
  } finally {
    if (managesTx) client.release();
  }
}

async function postDraftJournal({ orgId, journalId, actorUserId, client: existingClient = null, sourceApproval = null }) {
  const client = existingClient || (await pool.connect());
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query("BEGIN");

    const baseCurrency = await getOrgBaseCurrency(client, orgId);
    const settings = await getWorkflowSettings(client, { orgId });

    const { rows: jRows } = await client.query(
      `
      SELECT id, status, period_id, entry_date, created_by, workflow_document_id
      FROM journal_entries
      WHERE organization_id=$1 AND id=$2
      FOR UPDATE
      `,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const journal = jRows[0];

    if (!["draft", "approved"].includes(journal.status)) {
      throw new AppError(409, "Journal must be in draft or approved status to post");
    }

    if (sourceApproval?.entityType) {
      await documentableSvc.assertEntityApprovedForAction({
        orgId,
        entityType: sourceApproval.entityType,
        workflowDocumentId: sourceApproval.workflowDocumentId,
        client,
        actionLabel: "post generated journal"
      });
    } else {
      await assertJournalApprovalStateAllowsPost({ orgId, journal, client });
    }

    assertCanPost({
      settings,
      creatorUserId: journal.created_by,
      actorUserId,
    });

    const period = await getPeriodForUpdate(client, orgId, journal.period_id);
    if (period.status !== "open") throw new AppError(409, "Period not open");
    assertEntryDateWithinPeriod(journal.entry_date, period);

    const { rows: lines } = await client.query(
      `
      SELECT
        jel.id AS line_id,
        jel.line_no,
        jel.account_id,
        jel.description,
        jel.debit,
        jel.credit,
        jel.currency_code,
        jel.fx_rate,
        jel.amount_base,
        coa.is_postable,
        coa.status AS account_status
      FROM journal_entry_lines jel
      JOIN chart_of_accounts coa
        ON coa.id = jel.account_id AND coa.organization_id = $1
      WHERE jel.journal_entry_id = $2
      ORDER BY jel.line_no
      `,
      [orgId, journalId]
    );
    if (lines.length < 2) throw new AppError(400, "Journal must contain at least two lines before posting");

    // Validate accounts and ensure amount_base/fx_rate are present and correct.
    for (const l of lines) {
      if (!l.is_postable) throw new AppError(400, "Non-postable account used");
      if (l.account_status !== "active") throw new AppError(400, "Inactive account used");

      const currencyCode = String(l.currency_code || baseCurrency).toUpperCase();
      const debitCents = parseDecimalToBigInt(l.debit || 0, 2);
      const creditCents = parseDecimalToBigInt(l.credit || 0, 2);
      const amountCents = debitCents > 0n ? debitCents : creditCents;

      let rateMicro = 1000000n;
      if (currencyCode !== baseCurrency) {
        if (l.fx_rate != null && String(l.fx_rate).trim() !== "") {
          rateMicro = parseRateToMicro(l.fx_rate);
        } else {
          rateMicro = await lookupFxRateMicro(client, {
            orgId,
            rateTypeCode: "SPOT",
            fromCurrency: currencyCode,
            toCurrency: baseCurrency,
            asOfDate: journal.entry_date,
          });
        }
      }

      const computedBaseCents =
        currencyCode === baseCurrency
          ? amountCents
          : computeBaseCents({ amountCents, rateMicro });

      const storedBaseCents = parseDecimalToBigInt(l.amount_base || 0, 2);

      // If missing/incorrect, update line.
      if (storedBaseCents !== computedBaseCents || String(l.fx_rate || "").trim() === "") {
        await client.query(
          `
          UPDATE journal_entry_lines
          SET currency_code=$2, fx_rate=$3, amount_base=$4
          WHERE id=$1
          `,
          [
            l.line_id,
            currencyCode,
            bigIntToDecimalString(rateMicro, 6),
            bigIntToDecimalString(computedBaseCents, 2)
          ]
        );

        l.currency_code = currencyCode;
        l.fx_rate = bigIntToDecimalString(rateMicro, 6);
        l.amount_base = bigIntToDecimalString(computedBaseCents, 2);
      }
    }

    const totals = sum2(lines);
    if (totals.debit !== totals.credit) throw new AppError(400, "Journal not balanced in base currency");

    for (const l of lines) {
      const isDebit = parseDecimalToBigInt(l.debit || 0, 2) > 0n;
      const isCredit = parseDecimalToBigInt(l.credit || 0, 2) > 0n;
      const baseAmt = l.amount_base || "0";

      await client.query(
        `
        INSERT INTO general_ledger_balances
          (organization_id, period_id, account_id, debit_total, credit_total)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id, period_id, account_id)
        DO UPDATE SET
          debit_total = general_ledger_balances.debit_total + EXCLUDED.debit_total,
          credit_total = general_ledger_balances.credit_total + EXCLUDED.credit_total
        `,
        [orgId, journal.period_id, l.account_id, isDebit ? baseAmt : "0", isCredit ? baseAmt : "0"]
      );
    }

    await client.query(
      `
      UPDATE journal_entries
      SET status='posted', posted_at=NOW(), posted_by=$3, updated_at=NOW(), updated_by=$3
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, journalId, actorUserId]
    );

    // Feed bank_transactions ledger for any bank accounts hit by this journal.
    // Keep this best-effort work behind a savepoint: a SQL failure would otherwise
    // abort the entire PostgreSQL transaction even if JavaScript catches it.
    await client.query("SAVEPOINT bank_enrichment");
    try {
      await bankTransactionsRepo.upsertFromPostedJournal(client, {
        orgId,
        journalId,
        entryDate: journal.entry_date,
        actorUserId,
      });
      await client.query("RELEASE SAVEPOINT bank_enrichment");
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT bank_enrichment");
      await client.query("RELEASE SAVEPOINT bank_enrichment");
      await enqueueEvent({
        client,
        orgId,
        eventType: "banking.bank_transactions.enrichment_failed",
        payload: { journalId, error: String(e && e.message ? e.message : e) },
      });
    }

    await enqueueEvent({
      client,
      orgId,
      eventType: "accounting.journal.posted",
      payload: { journalId, periodId: journal.period_id, entryDate: journal.entry_date }
    });

    if (managesTx) await client.query("COMMIT");
    return { journalId, status: "posted" };
  } catch (e) {
    if (managesTx) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    throw e;
  } finally {
    if (managesTx) client.release();
  }
}

/**
 * Accounting-correct void: create and post a reversal journal.
 * - Requires original journal is POSTED and not already voided.
 * - Reversal journal is posted immediately in the SAME period.
 * - Original journal is marked voided with link via memo and void_reason.
 */
async function voidByReversal({ orgId, journalId, actorUserId, reason, client: existingClient = null }) {
  const client = existingClient || (await pool.connect());
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query("BEGIN");

    const { rows: jRows } = await client.query(
      `
      SELECT id, status, period_id, entry_date, memo, journal_entry_type_id
      FROM journal_entries
      WHERE organization_id=$1 AND id=$2
      FOR UPDATE
      `,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const orig = jRows[0];
    if (orig.status !== "posted") throw new AppError(409, "Only posted journals can be voided");

    const period = await getPeriodForUpdate(client, orgId, orig.period_id);
    if (period.status !== "open") {
      throw new AppError(409, "Period not open; cannot create reversal in this period");
    }

    const { rows: lines } = await client.query(
      `
      SELECT line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      ORDER BY line_no
      `,
      [journalId]
    );
    if (!lines.length) throw new AppError(400, "Journal has no lines");

    // Create reversal journal (draft)
    const reversalMemo = `Reversal of JE ${journalId}. Reason: ${reason}`;
    const { rows: revRows } = await client.query(
      `
      INSERT INTO journal_entries
        (organization_id, journal_entry_type_id, period_id, entry_date, memo, status)
      VALUES ($1,$2,$3,$4,$5,'draft')
      RETURNING id
      `,
      [orgId, orig.journal_entry_type_id, orig.period_id, orig.entry_date, reversalMemo]
    );
    const reversalId = revRows[0].id;

    // Reverse lines: swap debit/credit
    for (const l of lines) {
      const debitBI = parseDecimalToBigInt(l.debit || 0, 2);
      const creditBI = parseDecimalToBigInt(l.credit || 0, 2);
      const newDebitBI = creditBI;
      const newCreditBI = debitBI;
      const amountBaseBI = newDebitBI > 0n ? newDebitBI : newCreditBI;

      await client.query(
        `
        INSERT INTO journal_entry_lines
          (journal_entry_id, line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          reversalId,
          l.line_no,
          l.account_id,
          `REV: ${l.description || ""}`.trim(),
          bigIntToDecimalString(newDebitBI, 2),
          bigIntToDecimalString(newCreditBI, 2),
          l.currency_code,
          l.fx_rate || "1",
          l.amount_base || bigIntToDecimalString(amountBaseBI, 2)
        ]
      );
    }

    // Post reversal (update GL)
    const { rows: revLines } = await client.query(
      `
      SELECT account_id, debit, credit, amount_base
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      ORDER BY line_no
      `,
      [reversalId]
    );

    const totals = sum2(revLines);
    if (totals.debit !== totals.credit) throw new AppError(500, "Reversal journal not balanced (unexpected)");

    for (const l of revLines) {
      await client.query(
        `
        INSERT INTO general_ledger_balances
          (organization_id, period_id, account_id, debit_total, credit_total)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id, period_id, account_id)
        DO UPDATE SET
          debit_total = general_ledger_balances.debit_total + EXCLUDED.debit_total,
          credit_total = general_ledger_balances.credit_total + EXCLUDED.credit_total
        `,
        [
          orgId,
          orig.period_id,
          l.account_id,
          (parseDecimalToBigInt(l.debit || 0, 2) > 0n ? l.amount_base : "0"),
          (parseDecimalToBigInt(l.credit || 0, 2) > 0n ? l.amount_base : "0")
        ]
      );
    }

    await client.query(
      `
      UPDATE journal_entries
      SET status='posted', posted_at=NOW(), posted_by=$2
      WHERE organization_id=$1 AND id=$3
      `,
      [orgId, actorUserId, reversalId]
    );

    // IMPORTANT: Do NOT modify memo or any other non-void field (immutability trigger)
    await client.query(
      `
      UPDATE journal_entries
      SET status='voided',
          voided_at=NOW(),
          voided_by=$3,
          void_reason=$4,
          updated_at=NOW()
      WHERE organization_id=$1
        AND id=$2
        AND status='posted'
      `,
      [orgId, journalId, actorUserId, `Reversed by JE ${reversalId}. Reason: ${reason}`]
    );

    await enqueueEvent({
      client,
      orgId,
      eventType: "accounting.journal.voided",
      payload: { journalId, reversalJournalId: reversalId, periodId: orig.period_id }
    });

    if (managesTx) await client.query("COMMIT");
    return { journalId, status: "voided", reversalJournalId: reversalId };
  } catch (e) {
    if (managesTx) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    throw e;
  } finally {
    if (managesTx) client.release();
  }
}

async function reversePostedJournal({
  orgId,
  journalId,
  actorUserId,
  targetPeriodId,
  entryDate,
  reason,
  idempotencyKey,
  client: existingClient = null,
}) {
  const client = existingClient || (await pool.connect());
  const managesTx = !existingClient;
  try {
    if (managesTx) await client.query("BEGIN");

    // 1) Load original (lock)
    const { rows: jRows } = await client.query(
      `
      SELECT id, status, period_id, entry_date, memo, journal_entry_type_id
      FROM journal_entries
      WHERE organization_id=$1 AND id=$2
      FOR UPDATE
      `,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const orig = jRows[0];
    if (orig.status !== "posted") throw new AppError(409, "Only posted journals can be reversed");

    // 2) Target period must be open (reversal posts there)
    const targetPeriod = await getPeriodForUpdate(client, orgId, targetPeriodId);
    if (targetPeriod.status !== "open") {
      throw new AppError(409, "Target period not open; cannot post reversal");
    }
    assertEntryDateWithinPeriod(entryDate, targetPeriod);

    // 3) Idempotency: if reversal already exists, return it
    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        `
        SELECT id
        FROM journal_entries
        WHERE organization_id=$1 AND idempotency_key=$2
        LIMIT 1
        `,
        [orgId, idempotencyKey]
      );
      if (existing.length) {
        if (managesTx) await client.query("COMMIT");
        return { reversalJournalId: existing[0].id, alreadyExisted: true };
      }
    }

    // 4) Load original lines
    const { rows: lines } = await client.query(
      `
      SELECT line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      ORDER BY line_no
      `,
      [journalId]
    );
    if (!lines.length) throw new AppError(400, "Journal has no lines");

    // 5) Create reversal journal in TARGET period/date
    const reversalMemo = `Reversal of JE ${journalId}. Reason: ${reason || "n/a"}`;
    const { rows: revRows } = await client.query(
      `
      INSERT INTO journal_entries
        (organization_id, journal_entry_type_id, period_id, entry_date, memo, status, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,'draft',$6)
      RETURNING id
      `,
      [orgId, orig.journal_entry_type_id, targetPeriodId, entryDate, reversalMemo, idempotencyKey || null]
    );
    const reversalId = revRows[0].id;

    // 6) Insert reversed lines
    for (const l of lines) {
      const debitBI = parseDecimalToBigInt(l.debit || 0, 2);
      const creditBI = parseDecimalToBigInt(l.credit || 0, 2);
      const newDebitBI = creditBI;
      const newCreditBI = debitBI;
      const amountBaseBI = newDebitBI > 0n ? newDebitBI : newCreditBI;

      await client.query(
        `
        INSERT INTO journal_entry_lines
          (journal_entry_id, line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          reversalId,
          l.line_no,
          l.account_id,
          `REV: ${l.description || ""}`.trim(),
          bigIntToDecimalString(newDebitBI, 2),
          bigIntToDecimalString(newCreditBI, 2),
          l.currency_code,
          l.fx_rate || "1",
          l.amount_base || bigIntToDecimalString(amountBaseBI, 2)
        ]
      );
    }

    // 7) Post reversal into GL balances for TARGET period
    const { rows: revLines } = await client.query(
      `SELECT account_id, debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1 ORDER BY line_no`,
      [reversalId]
    );
    const totals = sum2(revLines);
    if (totals.debit !== totals.credit) throw new AppError(500, "Reversal journal not balanced (unexpected)");

    for (const l of revLines) {
      await client.query(
        `
        INSERT INTO general_ledger_balances
          (organization_id, period_id, account_id, debit_total, credit_total)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id, period_id, account_id)
        DO UPDATE SET
          debit_total = general_ledger_balances.debit_total + EXCLUDED.debit_total,
          credit_total = general_ledger_balances.credit_total + EXCLUDED.credit_total
        `,
        [orgId, targetPeriodId, l.account_id, l.debit || "0", l.credit || "0"]
      );
    }

    await client.query(
      `
      UPDATE journal_entries
      SET status='posted', posted_at=NOW(), posted_by=$2
      WHERE organization_id=$1 AND id=$3
      `,
      [orgId, actorUserId, reversalId]
    );

    // 8) IMPORTANT: Do NOT modify original journal status
    await enqueueEvent({
      client,
      orgId,
      eventType: "accounting.journal.reversed",
      payload: { originalJournalId: journalId, reversalJournalId: reversalId, periodId: targetPeriodId, entryDate }
    });

    if (managesTx) await client.query("COMMIT");
    return { reversalJournalId: reversalId, alreadyExisted: false };
  } catch (e) {
    if (managesTx) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    throw e;
  } finally {
    if (managesTx) client.release();
  }
}

// ---------------------------------
// Stage 2: Draft editing + lifecycle
// ---------------------------------



async function buildJournalWorkflowSnapshot(client, { orgId, journalId }) {
  const { rows: journals } = await client.query(
    `SELECT * FROM journal_entries WHERE organization_id=$1 AND id=$2`,
    [orgId, journalId]
  );
  if (!journals.length) throw new AppError(404, "Journal not found");
  const journal = journals[0];
  const { rows: lines } = await client.query(
    `SELECT * FROM journal_entry_lines WHERE journal_entry_id=$1 ORDER BY line_no`,
    [journalId]
  );
  return {
    journal,
    snapshot: {
      header: journal,
      lines,
      totals: {
        debit_base: bigIntToDecimalString(sum2(lines).debit, 2),
        credit_base: bigIntToDecimalString(sum2(lines).credit, 2),
      },
      meta: {
        status: journal.status,
        period_id: journal.period_id,
        entry_date: journal.entry_date,
      }
    }
  };
}

async function assertJournalApprovalStateAllowsPost({ orgId, journal, client }) {
  return documentableSvc.assertEntityApprovedForAction({
    orgId,
    entityType: "journal_entry",
    workflowDocumentId: journal.workflow_document_id,
    client,
    actionLabel: "post"
  });
}
async function getJournalWithLines({ orgId, journalId }) {
  const { rows: j } = await pool.query(
    `SELECT je.*, o.base_currency_code
       FROM journal_entries je
       JOIN organizations o ON o.id=je.organization_id
      WHERE je.organization_id=$1 AND je.id=$2`,
    [orgId, journalId]
  );
  if (!j.length) throw new AppError(404, "Journal not found");

  const { rows: lines } = await pool.query(
    `SELECT jel.*, coa.code AS account_code, coa.name AS account_name
       FROM journal_entry_lines jel
       JOIN chart_of_accounts coa
         ON coa.id=jel.account_id AND coa.organization_id=$1
      WHERE jel.journal_entry_id=$2
      ORDER BY jel.line_no`,
    [orgId, journalId]
  );

  const approvalContext = await documentableSvc.getApprovalContext({
    orgId,
    entityType: "journal_entry",
    client: null
  });
  const rules = approvalContext.rules || {};

  return {
    journal: j[0],
    lines,
    workflow: {
      approvalRequired: Boolean(approvalContext.approvalRequired),
      creatorCanApprove: Boolean(rules.creator_can_approve || rules.allow_self_approval),
      creatorCanPost: Boolean(rules.creator_can_post),
      requireCommentOnRejection: rules.require_comment_on_rejection !== false
    }
  };
}

async function assertEditableJournal(client, { orgId, journalId }) {
  const { rows: jRows } = await client.query(
    `SELECT id, status, period_id, entry_date, created_by
     FROM journal_entries
     WHERE organization_id=$1 AND id=$2
     FOR UPDATE`,
    [orgId, journalId]
  );
  if (!jRows.length) throw new AppError(404, "Journal not found");

  const j = jRows[0];
  if (!["draft", "rejected"].includes(j.status)) {
    throw new AppError(409, "Only draft/rejected journals can be edited");
  }

  const period = await getPeriodForUpdate(client, orgId, j.period_id);
  if (period.status !== "open") throw new AppError(409, "Period not open");
  return { journal: j, period };
}

async function updateDraftHeader({ orgId, journalId, actorUserId, payload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { journal } = await assertEditableJournal(client, { orgId, journalId });
    if (journal.created_by && String(journal.created_by) !== String(actorUserId)) {
      // Allow only creator to edit draft by default
      throw new AppError(403, "Only the creator can edit this draft journal");
    }

    // Resolve type id if typeCode provided
    let typeId = null;
    if (payload.typeCode) {
      const { rows: tRows } = await client.query(
        `SELECT id FROM journal_entry_types WHERE code=$1`,
        [payload.typeCode]
      );
      if (!tRows.length) throw new AppError(400, "Invalid journal entry type");
      typeId = tRows[0].id;
    }

    let periodId = payload.periodId || journal.period_id;
    if (payload.periodId) {
      const p = await getPeriodForUpdate(client, orgId, payload.periodId);
      if (p.status !== "open") throw new AppError(409, "Target period not open");
      periodId = p.id;
      if (payload.entryDate) assertEntryDateWithinPeriod(payload.entryDate, p);
    }

    if (payload.entryDate && !payload.periodId) {
      const p = await getPeriodForUpdate(client, orgId, journal.period_id);
      assertEntryDateWithinPeriod(payload.entryDate, p);
    }

    await client.query(
      `
      UPDATE journal_entries
      SET period_id = COALESCE($3, period_id),
          entry_date = COALESCE($4, entry_date),
          memo = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE memo END,
          journal_entry_type_id = COALESCE($6, journal_entry_type_id),
          status='draft',
          rejected_at=NULL,
          rejected_by=NULL,
          rejection_reason=NULL,
          updated_at=NOW(),
          updated_by=$7
      WHERE organization_id=$1 AND id=$2
      `,
      [
        orgId,
        journalId,
        periodId,
        payload.entryDate || null,
        payload.memo === undefined ? null : payload.memo,
        typeId,
        actorUserId
      ]
    );

    await client.query("COMMIT");
    return { journalId, status: "draft" };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function replaceDraftLines({ orgId, journalId, actorUserId, lines, requireBalanced = true }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { journal } = await assertEditableJournal(client, { orgId, journalId });
    if (journal.created_by && String(journal.created_by) !== String(actorUserId)) {
      throw new AppError(403, "Only the creator can edit this draft journal");
    }

    const baseCurrency = await getOrgBaseCurrency(client, orgId);

    const preparedLines = await prepareDraftLines(client, {
      orgId,
      entryDate: journal.entry_date,
      lines,
      baseCurrency,
      payloadRateTypeCode: "SPOT",
      requireBalanced,
    });

    const { rows: existingLines } = await client.query(
      `SELECT COUNT(*) as count
       FROM journal_entry_lines
       WHERE journal_entry_id = $1`,
      [journalId]
    );

    if (parseInt(existingLines[0].count, 10) > 0) {
      await client.query(
        `DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`,
        [journalId]
      );
    }

    for (let i = 0; i < preparedLines.length; i++) {
      const l = preparedLines[i];
      const debitBI = parseDecimalToBigInt(l.debit || 0, 2);
      const creditBI = parseDecimalToBigInt(l.credit || 0, 2);

      await client.query(
        `
        INSERT INTO journal_entry_lines
          (journal_entry_id, line_no, account_id, description, debit, credit, currency_code, fx_rate, amount_base)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          journalId,
          i + 1,
          l.accountId,
          l.description || null,
          bigIntToDecimalString(debitBI, 2),
          bigIntToDecimalString(creditBI, 2),
          l.currencyCode,
          bigIntToDecimalString(l.fxRateMicro, 6),
          bigIntToDecimalString(l.amountBaseCents, 2)
        ]
      );
    }

    // If journal was rejected, revert back to draft
    await client.query(
      `
      UPDATE journal_entries
      SET status = 'draft',
          rejected_at = NULL,
          rejected_by = NULL,
          rejection_reason = NULL,
          updated_at = NOW(),
          updated_by = $3
      WHERE organization_id = $1 AND id = $2
      `,
      [orgId, journalId, actorUserId]
    );

    await client.query("COMMIT");
    return { journalId, status: "draft" };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function submitDraftJournal({ orgId, journalId, actorUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { journal, snapshot } = await buildJournalWorkflowSnapshot(client, { orgId, journalId });
    const j = journal;

    if (j.status !== "draft") throw new AppError(409, "Only draft journals can be submitted");
    if (j.created_by && String(j.created_by) !== String(actorUserId)) {
      throw new AppError(403, "Only the creator can submit this journal");
    }

    const period = await getPeriodForUpdate(client, orgId, j.period_id);
    if (period.status !== "open") throw new AppError(409, "Period not open");
    assertEntryDateWithinPeriod(j.entry_date, period);

    const totals = sum2(snapshot.lines);
    if (snapshot.lines.length < 2) throw new AppError(400, "Journal must contain at least two lines before submission");
    if (totals.debit !== totals.credit) throw new AppError(400, "Journal not balanced");

    await documentableSvc.submitEntityForApproval({
      orgId,
      actorUserId,
      entityType: "journal_entry",
      entity: j,
      workflowDocumentId: j.workflow_document_id,
      snapshot,
      client,
      persistWorkflowDocumentId: async (workflowDocumentId) => {
        await client.query(`UPDATE journal_entries SET workflow_document_id=$3, updated_at=NOW(), updated_by=$4 WHERE organization_id=$1 AND id=$2`, [orgId, journalId, workflowDocumentId, actorUserId]);
      }
    });

    await client.query(
      `
      UPDATE journal_entries
      SET status='submitted',
          submitted_at=NOW(),
          submitted_by=$3,
          approved_at=NULL,
          approved_by=NULL,
          rejected_at=NULL,
          rejected_by=NULL,
          rejection_reason=NULL,
          updated_at=NOW(),
          updated_by=$3
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, journalId, actorUserId]
    );

    await client.query("COMMIT");
    return { journalId, status: "submitted" };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function approveSubmittedJournal({ orgId, journalId, actorUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: jRows } = await client.query(
      `SELECT id, status, created_by, workflow_document_id
       FROM journal_entries
       WHERE organization_id=$1 AND id=$2
       FOR UPDATE`,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const j = jRows[0];

    if (j.status !== "submitted") {
      throw new AppError(409, "Only submitted journals can be approved");
    }
    if (!j.workflow_document_id) throw new AppError(409, "Journal has no workflow document");

    const approvalResult = await documentableSvc.approveEntityDocument({
      orgId,
      actorUserId,
      entityType: "journal_entry",
      workflowDocumentId: j.workflow_document_id,
      creatorUserId: j.created_by,
      comment: null,
      client
    });

    const settings = await getWorkflowSettings(client, { orgId });
    const isFinalApproval = !approvalResult?.next;
    if (isFinalApproval) {
      await client.query(
        `
        UPDATE journal_entries
        SET status='approved',
            approved_at=NOW(),
            approved_by=$3,
            updated_at=NOW(),
            updated_by=$3
        WHERE organization_id=$1 AND id=$2
        `,
        [orgId, journalId, actorUserId]
      );
    } else {
      await client.query(
        `
        UPDATE journal_entries
        SET updated_at=NOW(),
            updated_by=$3
        WHERE organization_id=$1 AND id=$2
        `,
        [orgId, journalId, actorUserId]
      );
    }

    if (isFinalApproval && settings.notify_creator_on_approval && j.created_by) {
      await enqueueEvent({
        client,
        orgId,
        eventType: "accounting.journal.approved",
        payload: {
          journalId,
          approvedBy: actorUserId,
          creatorUserId: j.created_by,
        },
      });
    }

    await client.query("COMMIT");
    return { journalId, status: isFinalApproval ? "approved" : "submitted", workflowStepCompleted: true, finalApproval: isFinalApproval };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function rejectSubmittedJournal({ orgId, journalId, actorUserId, reason }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const settings = await getWorkflowSettings(client, { orgId });

    const { rows: jRows } = await client.query(
      `SELECT id, status, created_by, workflow_document_id
       FROM journal_entries
       WHERE organization_id=$1 AND id=$2
       FOR UPDATE`,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const j = jRows[0];

    if (j.status !== "submitted") {
      throw new AppError(409, "Only submitted journals can be rejected");
    }
    if (!j.workflow_document_id) throw new AppError(409, "Journal has no workflow document");

    await documentableSvc.rejectEntityDocument({
      orgId,
      actorUserId,
      entityType: "journal_entry",
      workflowDocumentId: j.workflow_document_id,
      creatorUserId: j.created_by,
      comment: reason,
      client
    });

    await client.query(
      `
      UPDATE journal_entries
      SET status='rejected',
          rejected_at=NOW(),
          rejected_by=$3,
          rejection_reason=$4,
          updated_at=NOW(),
          updated_by=$3
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, journalId, actorUserId, reason || null]
    );

    if (settings.notify_creator_on_rejection && j.created_by) {
      await enqueueEvent({
        client,
        orgId,
        eventType: "accounting.journal.rejected",
        payload: {
          journalId,
          rejectedBy: actorUserId,
          creatorUserId: j.created_by,
          reason: reason || null,
        },
      });
    }

    await client.query("COMMIT");
    return { journalId, status: "rejected" };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function cancelDraftJournal({ orgId, journalId, actorUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: jRows } = await client.query(
      `SELECT id, status, created_by
       FROM journal_entries
       WHERE organization_id=$1 AND id=$2
       FOR UPDATE`,
      [orgId, journalId]
    );
    if (!jRows.length) throw new AppError(404, "Journal not found");
    const j = jRows[0];

    if (j.status !== "draft" && j.status !== "rejected") {
      throw new AppError(409, "Only draft/rejected journals can be canceled");
    }
    if (j.created_by && String(j.created_by) !== String(actorUserId)) {
      throw new AppError(403, "Only the creator can cancel this journal");
    }

    await client.query(
      `
      UPDATE journal_entries
      SET status='canceled',
          canceled_at=NOW(),
          canceled_by=$3,
          updated_at=NOW(),
          updated_by=$3
      WHERE organization_id=$1 AND id=$2
      `,
      [orgId, journalId, actorUserId]
    );

    await client.query("COMMIT");
    return { journalId, status: "canceled" };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function batchPostJournals({ orgId, actorUserId, journalIds, client: existingClient = null }) {
  // Best-effort batch: posts sequentially; each post is transactional.
  const results = [];
  for (const id of journalIds) {
    const r = await postDraftJournal({ orgId, journalId: id, actorUserId, client: existingClient });
    results.push(r);
  }
  return { count: results.length, results };
}

async function listJournals({ orgId, filters = {}, limit = 100, offset = 0 }) {
  const where = ["organization_id=$1"];
  const params = [orgId];
  let i = 2;

  if (filters.periodId) {
    where.push(`period_id=$${i++}`);
    params.push(filters.periodId);
  }
  if (filters.status) {
    where.push(`status=$${i++}`);
    params.push(filters.status);
  }
  if (filters.from) {
    where.push(`entry_date >= $${i++}::date`);
    params.push(filters.from);
  }
  if (filters.to) {
    where.push(`entry_date <= $${i++}::date`);
    params.push(filters.to);
  }

  params.push(limit);
  params.push(offset);

  const { rows } = await pool.query(
    `
    SELECT id, entry_no, journal_entry_type_id,
           (SELECT code FROM journal_entry_types jet WHERE jet.id=journal_entries.journal_entry_type_id) AS journal_entry_type,
           period_id, entry_date, memo, status,
           created_by, submitted_at, submitted_by, approved_at, approved_by,
           rejected_at, rejected_by, rejection_reason,
           canceled_at, canceled_by,
           created_at, updated_at, updated_by
    FROM journal_entries
    WHERE ${where.join(" AND ")}
    ORDER BY entry_date DESC, created_at DESC
    LIMIT $${i++} OFFSET $${i++}
    `,
    params
  );
  return rows;
}

module.exports = {
  createDraftJournal,
  postDraftJournal,
  voidByReversal,
  reversePostedJournal,
  listJournals,
  getJournalWithLines,
  updateDraftHeader,
  replaceDraftLines,
  submitDraftJournal,
  approveSubmittedJournal,
  rejectSubmittedJournal,
  cancelDraftJournal,
  batchPostJournals,
  assertJournalApprovalStateAllowsPost,

  // exported helpers in case other modules need them
  getWorkflowSettings,
  assertCanApprove,
  assertCanReject,
  assertCanPost,
  assertRejectionCommentRequired,
};