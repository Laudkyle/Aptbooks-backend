const crypto = require('crypto');
const { parseDecimalToBigInt, bigIntToDecimalString } = require('../../../shared/utils/money');

function canonicalLine(line, index = 0) {
  const accountId = line?.accountId || line?.account_id;
  if (!accountId) throw Object.assign(new Error(`Posting line ${index + 1} requires accountId`), { code: 'posting_account_required' });
  const debit = parseDecimalToBigInt(line?.debit || '0', 2);
  const credit = parseDecimalToBigInt(line?.credit || '0', 2);
  if (debit < 0n || credit < 0n) throw Object.assign(new Error(`Posting line ${index + 1} cannot be negative`), { code: 'posting_negative_amount' });
  if ((debit > 0n) === (credit > 0n)) {
    throw Object.assign(new Error(`Posting line ${index + 1} must have exactly one positive debit or credit`), { code: 'posting_one_sided_line_required' });
  }
  return {
    ...line,
    accountId,
    debit: bigIntToDecimalString(debit, 2),
    credit: bigIntToDecimalString(credit, 2),
  };
}

function normalizePostingLines(lines, { requireBalanced = true } = {}) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw Object.assign(new Error('A journal posting requires at least two lines'), { code: 'posting_minimum_lines' });
  }
  const normalized = lines.map(canonicalLine);
  if (requireBalanced) {
    let debit = 0n;
    let credit = 0n;
    for (const line of normalized) {
      debit += parseDecimalToBigInt(line.debit, 2);
      credit += parseDecimalToBigInt(line.credit, 2);
    }
    if (debit !== credit) {
      throw Object.assign(new Error('Journal is not balanced in transaction currency'), {
        code: 'journal_not_balanced', debit, credit,
      });
    }
  }
  return normalized;
}

function reversePostingLines(lines) {
  return normalizePostingLines(lines, { requireBalanced: true }).map((line) => ({
    ...line,
    debit: line.credit,
    credit: line.debit,
    description: `REV: ${line.description || ''}`.trim(),
  }));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintLine(line = {}) {
  const debit = parseDecimalToBigInt(line.debit || '0', 2);
  const credit = parseDecimalToBigInt(line.credit || '0', 2);
  if (debit < 0n || credit < 0n || (debit > 0n && credit > 0n)) {
    throw Object.assign(new Error('Invalid posting line for idempotency fingerprint'), { code: 'invalid_posting_line' });
  }
  const rawCurrency = line.currencyCode || line.currency_code || null;
  const rawFxRate = line.fxRate ?? line.fx_rate ?? null;
  let fxRate = null;
  if (rawFxRate !== null && String(rawFxRate).trim() !== '') {
    const rate = parseDecimalToBigInt(rawFxRate, 6);
    if (rate <= 0n) throw Object.assign(new Error('FX rate must be positive for idempotency fingerprint'), { code: 'invalid_posting_line' });
    fxRate = bigIntToDecimalString(rate, 6);
  }
  return {
    accountId: String(line.accountId || line.account_id || '').trim() || null,
    description: String(line.description || '').trim(),
    debit: bigIntToDecimalString(debit, 2),
    credit: bigIntToDecimalString(credit, 2),
    currencyCode: rawCurrency ? String(rawCurrency).trim().toUpperCase() : null,
    fxRate,
  };
}

function postingFingerprint({ orgId, source = {}, payload = {} }) {
  const material = {
    orgId,
    source: {
      type: source.type || source.sourceType || null,
      id: source.id || source.sourceId || null,
      action: source.action || source.sourceAction || 'post',
      reference: source.reference || source.sourceReference || null,
    },
    payload: {
      periodId: payload.periodId || null,
      entryDate: payload.entryDate || payload.journalDate || null,
      typeCode: String(payload.typeCode || 'GENERAL').trim().toUpperCase(),
      memo: payload.memo || null,
      idempotencyKey: payload.idempotencyKey || null,
      lines: (payload.lines || []).map(fingerprintLine),
    },
  };
  return crypto.createHash('sha256').update(stableStringify(material)).digest('hex');
}

module.exports = { canonicalLine, fingerprintLine, normalizePostingLines, reversePostingLines, postingFingerprint, stableStringify };
