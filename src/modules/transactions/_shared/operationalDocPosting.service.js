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

function groupBaseAmounts(lines, requireLineAccounts = true) {
  const grouped = new Map();
  for (const line of (lines || [])) {
    const accountId = line.account_id || line.accountId || null;
    if (requireLineAccounts && !accountId) throw new AppError(400, "All posting lines must have accountId");
    if (!accountId) continue;
    const baseAmount = round2(line.taxable_amount ?? line.taxableAmount ?? Math.max(Number(line.line_total || 0) - Number(line.tax_amount || line.taxAmount || 0), 0));
    grouped.set(accountId, round2((grouped.get(accountId) || 0) + baseAmount));
  }
  return grouped;
}

function buildGroupedBaseSide({ lines, side, descriptionPrefix, requireLineAccounts = true }) {
  return Array.from(groupBaseAmounts(lines, requireLineAccounts).entries()).map(([accountId, amount]) => ({
    accountId,
    debit: side === "debit" ? amount : 0,
    credit: side === "credit" ? amount : 0,
    description: descriptionPrefix
  }));
}

function buildTaxLines({ header, lines, side, taxAccountId, descriptionPrefix, requiredAccountMessage }) {
  const totalTax = round2((lines || []).reduce((sum, line) => sum + Number(line.tax_amount || line.taxAmount || 0), 0));
  if (!totalTax) return [];
  if (!taxAccountId) {
    throw new AppError(409, requiredAccountMessage || "Tax account is not configured");
  }
  return [{
    accountId: taxAccountId,
    debit: side === "debit" ? totalTax : 0,
    credit: side === "credit" ? totalTax : 0,
    description: `${descriptionPrefix} tax ${header.document_no}`
  }];
}

async function getTaxSettings({ orgId, client }) {
  const { rows } = await client.query(`SELECT * FROM tax_settings WHERE organization_id=$1`, [orgId]);
  return rows[0] || null;
}

async function buildReturnLines({ orgId, header, lines, client }) {
  const partnerId = requireAccountId(header.counterparty_partner_id, "Return is missing partnerId");
  const partner = await partnerIF.getPartnerForOrg({ orgId, partnerId, client });
  const total = amountFromHeaderOrLines(header, lines);
  const type = header.meta?.returnType || header.meta?.return_type || null;
  const taxSettings = await getTaxSettings({ orgId, client });

  if (type === "sales_return") {
    const arAccountId = requireAccountId(partner.default_receivable_account_id, "Customer missing defaultReceivableAccountId");
    return [
      ...buildGroupedBaseSide({ lines, side: "debit", descriptionPrefix: `Sales return ${header.document_no}` }),
      ...buildTaxLines({ header, lines, side: "debit", taxAccountId: taxSettings?.output_tax_account_id, descriptionPrefix: "Sales return", requiredAccountMessage: "Output tax account is not configured (tax_settings.output_tax_account_id)" }),
      { accountId: arAccountId, debit: 0, credit: total, description: `A/R reversal for ${header.document_no}` }
    ];
  }

  if (type === "purchase_return") {
    const apAccountId = requireAccountId(partner.default_payable_account_id, "Vendor missing defaultPayableAccountId");
    return [
      { accountId: apAccountId, debit: total, credit: 0, description: `A/P reversal for ${header.document_no}` },
      ...buildGroupedBaseSide({ lines, side: "credit", descriptionPrefix: `Purchase return ${header.document_no}` }),
      ...buildTaxLines({ header, lines, side: "credit", taxAccountId: taxSettings?.input_tax_account_id, descriptionPrefix: "Purchase return", requiredAccountMessage: "Input tax account is not configured (tax_settings.input_tax_account_id)" })
    ];
  }

  throw new AppError(400, "Unsupported returnType for posting");
}

async function buildPostingLines({ orgId, header, lines, client }) {
  const moduleCode = header.module_code;
  const total = amountFromHeaderOrLines(header, lines);
  const taxSettings = await getTaxSettings({ orgId, client });

  switch (moduleCode) {
    case "expense": {
      const contraAccountId = requireAccountId(header.cash_account_id || header.primary_account_id, "Expense requires cashAccountId or primaryAccountId for posting");
      return [
        ...buildGroupedBaseSide({ lines, side: "debit", descriptionPrefix: `Expense ${header.document_no}` }),
        ...buildTaxLines({ header, lines, side: "debit", taxAccountId: taxSettings?.input_tax_account_id, descriptionPrefix: "Expense", requiredAccountMessage: "Input tax account is not configured (tax_settings.input_tax_account_id)" }),
        { accountId: contraAccountId, debit: 0, credit: total, description: `Expense offset for ${header.document_no}` }
      ];
    }
    case "petty_cash": {
      const cashAccountId = requireAccountId(header.cash_account_id, "Petty cash requires cashAccountId for posting");
      return [
        ...buildGroupedBaseSide({ lines, side: "debit", descriptionPrefix: `Petty cash ${header.document_no}` }),
        ...buildTaxLines({ header, lines, side: "debit", taxAccountId: taxSettings?.input_tax_account_id, descriptionPrefix: "Petty cash", requiredAccountMessage: "Input tax account is not configured (tax_settings.input_tax_account_id)" }),
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
        ...buildGroupedBaseSide({ lines, side: "debit", descriptionPrefix: `Goods receipt ${header.document_no}` }),
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
    journalLines = await buildPostingLines({ orgId, header, lines, client });
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

function getTableNameForModule(moduleCode) {
  const tableMap = {
    expense: "operational_documents",
    petty_cash: "operational_documents",
    advance: "operational_documents",
    refund: "operational_documents",
    goods_receipt: "operational_documents",
    return: "operational_documents"
  };
  return tableMap[moduleCode];
}

module.exports = {
  buildOperationalDocumentJournal
};
