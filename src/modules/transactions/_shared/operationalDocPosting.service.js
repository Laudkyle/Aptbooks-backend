const { AppError } = require("../../../shared/errors/AppError");
const partnerIF = require("../../../interfaces/partnerManagement.interface");
const periodIF = require("../../../interfaces/periodManagement.interface");
const journalIF = require("../../../interfaces/journalPosting.interface");

function round2(n) {
  return Number((Number(n || 0)).toFixed(2));
}

function amountFromHeaderOrLines(header, lines) {
  if (header.amount_total != null) return round2(header.amount_total);
  return round2((lines || []).reduce((sum, line) => sum + Number(line.line_total || 0), 0));
}

function requireAccountId(accountId, message) {
  if (!accountId) throw new AppError(400, message);
  return accountId;
}

function buildGroupedSide({ lines, side, descriptionPrefix, requireLineAccounts = true }) {
  const grouped = new Map();
  for (const line of (lines || [])) {
    const accountId = line.account_id || line.accountId || null;
    if (requireLineAccounts && !accountId) {
      throw new AppError(400, "All posting lines must have accountId");
    }
    if (!accountId) continue;
    grouped.set(accountId, round2((grouped.get(accountId) || 0) + Number(line.line_total || 0)));
  }

  return Array.from(grouped.entries()).map(([accountId, amount]) => ({
    accountId,
    debit: side === "debit" ? amount : 0,
    credit: side === "credit" ? amount : 0,
    description: descriptionPrefix
  }));
}

async function buildReturnLines({ orgId, header, lines, client }) {
  const partnerId = requireAccountId(header.counterparty_partner_id, "Return is missing partnerId");
  const partner = await partnerIF.getPartnerForOrg({ orgId, partnerId, client });
  const total = amountFromHeaderOrLines(header, lines);
  const type = header.meta?.returnType || header.meta?.return_type || null;

  if (type === "sales_return") {
    const arAccountId = requireAccountId(partner.default_receivable_account_id, "Customer missing defaultReceivableAccountId");
    return [
      ...buildGroupedSide({ lines, side: "debit", descriptionPrefix: `Sales return ${header.document_no}` }),
      { accountId: arAccountId, debit: 0, credit: total, description: `A/R reversal for ${header.document_no}` }
    ];
  }

  if (type === "purchase_return") {
    const apAccountId = requireAccountId(partner.default_payable_account_id, "Vendor missing defaultPayableAccountId");
    return [
      { accountId: apAccountId, debit: total, credit: 0, description: `A/P reversal for ${header.document_no}` },
      ...buildGroupedSide({ lines, side: "credit", descriptionPrefix: `Purchase return ${header.document_no}` })
    ];
  }

  throw new AppError(400, "Unsupported returnType for posting");
}

function buildPostingLines({ header, lines }) {
  const moduleCode = header.module_code;
  const total = amountFromHeaderOrLines(header, lines);

  switch (moduleCode) {
    case "expense": {
      const contraAccountId = requireAccountId(
        header.cash_account_id || header.primary_account_id,
        "Expense requires cashAccountId or primaryAccountId for posting"
      );
      return [
        ...buildGroupedSide({ lines, side: "debit", descriptionPrefix: `Expense ${header.document_no}` }),
        { accountId: contraAccountId, debit: 0, credit: total, description: `Expense offset for ${header.document_no}` }
      ];
    }
    case "petty_cash": {
      const cashAccountId = requireAccountId(header.cash_account_id, "Petty cash requires cashAccountId for posting");
      return [
        ...buildGroupedSide({ lines, side: "debit", descriptionPrefix: `Petty cash ${header.document_no}` }),
        { accountId: cashAccountId, debit: 0, credit: total, description: `Petty cash offset for ${header.document_no}` }
      ];
    }
    case "advance": {
      const advanceAccountId = requireAccountId(header.primary_account_id, "Advance requires primaryAccountId for posting");
      const cashAccountId = requireAccountId(header.cash_account_id, "Advance requires cashAccountId for posting");
      return [
        { accountId: advanceAccountId, debit: total, credit: 0, description: `Advance ${header.document_no}` },
        { accountId: cashAccountId, debit: 0, credit: total, description: `Advance cash for ${header.document_no}` }
      ];
    }
    case "refund": {
      const settlementAccountId = requireAccountId(header.primary_account_id, "Refund requires primaryAccountId for posting");
      const cashAccountId = requireAccountId(header.cash_account_id, "Refund requires cashAccountId for posting");
      return [
        { accountId: settlementAccountId, debit: total, credit: 0, description: `Refund settlement for ${header.document_no}` },
        { accountId: cashAccountId, debit: 0, credit: total, description: `Refund cash for ${header.document_no}` }
      ];
    }
    case "goods_receipt": {
      const clearingAccountId = requireAccountId(header.primary_account_id, "Goods receipt requires primaryAccountId (clearing/accrual account) for posting");
      return [
        ...buildGroupedSide({ lines, side: "debit", descriptionPrefix: `Goods receipt ${header.document_no}` }),
        { accountId: clearingAccountId, debit: 0, credit: total, description: `Goods receipt clearing for ${header.document_no}` }
      ];
    }
    default:
      throw new AppError(400, `No posting builder configured for module ${moduleCode}`);
  }
}

async function buildOperationalDocumentJournal({ orgId, actorUserId, header, lines, client }) {
  const period = await periodIF.findOpenPeriodForDate({ orgId, date: header.document_date, client });

  let journalLines;
  if (header.module_code === "return") {
    journalLines = await buildReturnLines({ orgId, header, lines, client });
  } else {
    journalLines = buildPostingLines({ header, lines });
  }

  const payload = {
    periodId: period.id,
    entryDate: header.document_date,
    typeCode: "GENERAL",
    memo: `${header.module_code.replace(/_/g, " ")} ${header.document_no}` + (header.memo ? `: ${header.memo}` : ""),
    idempotencyKey: `operational-document:${header.id}:post`,
    lines: journalLines
  };

  const draft = await journalIF.createDraftJournal({ orgId, actorUserId, payload, client });
  const posted = await journalIF.postDraftJournal({ orgId, journalId: draft.journalId, actorUserId, client });

  // Update the operational document with period_id and journal_entry_id
  const tableName = getTableNameForModule(header.module_code);
  if (tableName) {
    await client.query(
      `
      UPDATE ${tableName}
      SET period_id = $1,
          journal_entry_id = $2,
          updated_at = NOW()
      WHERE organization_id = $3 AND id = $4
      `,
      [period.id, posted.journalId || posted.id || posted.journal_id, orgId, header.id]
    );
  }

  return {
    period,
    journalId: posted.journalId || posted.id || posted.journal_id,
    payload
  };
}

// Helper function to map module codes to table names
function getTableNameForModule(moduleCode) {
  const tableMap = {
    'expenses': 'expenses',
    'petty_cash': 'petty_cash_transactions',
    'advance': 'advances',
    'refund': 'refunds',
    'goods_receipt': 'goods_receipts',
    'return': 'returns'
  };
  return tableMap[moduleCode];
}

module.exports = {
  buildOperationalDocumentJournal
};
