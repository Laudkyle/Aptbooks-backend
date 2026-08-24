const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDecimalToBigInt, bigIntToDecimalString } = require('../shared/utils/money');
const { DEFAULT_ACCOUNTING_POLICY, assertSupportedPolicy } = require('../core/accounting/policy/accountingPolicy');
const { normalizePostingLines, reversePostingLines, postingFingerprint } = require('../core/accounting/posting/postingInvariants');

function balances(lines) {
  const out = new Map();
  for (const line of lines) {
    const delta = parseDecimalToBigInt(line.debit || '0', 2) - parseDecimalToBigInt(line.credit || '0', 2);
    out.set(line.accountId, (out.get(line.accountId) || 0n) + delta);
  }
  return Object.fromEntries([...out.entries()].map(([key, value]) => [key, bigIntToDecimalString(value, 2)]));
}

test('accounting policy defaults are explicit and supported', () => {
  assert.deepEqual(assertSupportedPolicy(DEFAULT_ACCOUNTING_POLICY), DEFAULT_ACCOUNTING_POLICY);
  assert.throws(() => assertSupportedPolicy({ ...DEFAULT_ACCOUNTING_POLICY, roundingMode: 'HALF_EVEN' }), /Unsupported accounting policy/);
});

test('golden-master postings preserve expected accounting effects', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'phase2-accounting-golden-master.json'), 'utf8'));
  for (const fixture of cases) {
    const lines = normalizePostingLines(fixture.lines, { requireBalanced: true });
    assert.deepEqual(balances(lines), fixture.balances, fixture.name);
    const reversed = reversePostingLines(lines);
    const combined = balances([...lines, ...reversed]);
    for (const value of Object.values(combined)) assert.equal(value, '0.00', `${fixture.name} reversal must net to zero`);
  }
});

test('posting fingerprint is stable across object key order and changes on financial content', () => {
  const a = postingFingerprint({ orgId: 'org', source: { type: 'invoice', id: '1' }, payload: {
    entryDate: '2026-01-01', periodId: 'p', idempotencyKey: 'k',
    lines: [{ accountId: 'a', debit: '10.00' }, { accountId: 'b', credit: '10.00' }],
  }});
  const b = postingFingerprint({ payload: {
    lines: [{ debit: '10.00', accountId: 'a' }, { credit: '10.00', accountId: 'b' }],
    idempotencyKey: 'k', periodId: 'p', entryDate: '2026-01-01',
  }, source: { id: '1', type: 'invoice' }, orgId: 'org' });
  const c = postingFingerprint({ orgId: 'org', source: { type: 'invoice', id: '1' }, payload: {
    entryDate: '2026-01-01', periodId: 'p', idempotencyKey: 'k',
    lines: [{ accountId: 'a', debit: '11.00' }, { accountId: 'b', credit: '11.00' }],
  }});
  const d = postingFingerprint({ orgId: 'org', source: { type: 'invoice', id: '1' }, payload: {
    entryDate: '2026-01-01', periodId: 'p', idempotencyKey: 'k', typeCode: 'general',
    lines: [
      { accountId: 'a', debit: 10, currencyCode: 'ghs', fxRate: 1 },
      { accountId: 'b', credit: '10.0', currencyCode: 'GHS', fxRate: '1.000000' },
    ],
  }});
  const e = postingFingerprint({ orgId: 'org', source: { type: 'invoice', id: '1' }, payload: {
    entryDate: '2026-01-01', periodId: 'p', idempotencyKey: 'k', typeCode: 'GENERAL',
    lines: [
      { accountId: 'a', debit: '10.00', currencyCode: 'GHS', fxRate: '1.000000' },
      { accountId: 'b', credit: '10.00', currencyCode: 'ghs', fxRate: 1 },
    ],
  }});
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(d, e, 'financially equivalent decimal/currency representations must share a fingerprint');
});

test('property sweep: every generated balanced posting remains balanced after normalization and reversal', () => {
  let state = 0x5eed1234;
  const next = () => { state = (1664525 * state + 1013904223) >>> 0; return state; };
  for (let i = 0; i < 2000; i += 1) {
    const centsA = BigInt((next() % 1_000_000) + 1);
    const centsB = BigInt((next() % 1_000_000) + 1);
    const total = centsA + centsB;
    const lines = [
      { accountId: 'asset-a', debit: bigIntToDecimalString(centsA, 2) },
      { accountId: 'asset-b', debit: bigIntToDecimalString(centsB, 2) },
      { accountId: 'equity', credit: bigIntToDecimalString(total, 2) },
    ];
    const normalized = normalizePostingLines(lines, { requireBalanced: true });
    const reversal = reversePostingLines(normalized);
    const combined = balances([...normalized, ...reversal]);
    assert.deepEqual(combined, { 'asset-a': '0.00', 'asset-b': '0.00', equity: '0.00' });
  }
});

test('invalid one-sided and unbalanced postings are rejected before persistence', () => {
  assert.throws(() => normalizePostingLines([{ accountId: 'a', debit: '1', credit: '1' }, { accountId: 'b', credit: '1' }]), /exactly one positive/);
  assert.throws(() => normalizePostingLines([{ accountId: 'a', debit: '10' }, { accountId: 'b', credit: '9' }]), /not balanced/);
});
