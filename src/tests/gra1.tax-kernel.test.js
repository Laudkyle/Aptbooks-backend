const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeTaxMoney,
  computeComponentTaxBreakdown,
  applyRecoverablePercent,
} = require('../shared/tax/taxMath');
const {
  conditionsMatch,
  findMatchingRules,
  taxRuleGroup,
} = require('../shared/tax/determination');
const { resolveLineTaxes } = require('../shared/tax/multiTax');
const { summarizeLineTaxDetails } = require('../shared/tax/posting');

test('percentage-point tax rates use 15 as 15 percent, not 15x', () => {
  assert.equal(computeTaxMoney({ taxableAmount: '100.00', rate: '15.000000' }), '15.00');
  assert.equal(computeTaxMoney({ taxableAmount: '100.00', rate: '2.500000' }), '2.50');
  assert.equal(computeTaxMoney({ taxableAmount: '100.00', rate: '7.500000' }), '7.50');
});

test('tax money rounds half-up at the minor-unit boundary', () => {
  assert.equal(computeTaxMoney({ taxableAmount: '0.05', rate: '10.000000' }), '0.01');
  assert.equal(computeTaxMoney({ taxableAmount: '0.04', rate: '10.000000' }), '0.00');
});

test('Ghana standard components total 20 percent on a common base', () => {
  const result = computeComponentTaxBreakdown({
    amount: '100.00',
    components: [
      { code: 'GH_VAT_STD_15', rate: '15' },
      { code: 'GH_NHIL_2_5', rate: '2.5' },
      { code: 'GH_GETFUND_2_5', rate: '2.5' },
    ],
  });
  assert.equal(result.taxableAmount, '100.00');
  assert.equal(result.taxAmount, '20.00');
  assert.equal(result.totalAmount, '120.00');
  assert.deepEqual(result.components.map((x) => x.taxAmount), ['15.00', '2.50', '2.50']);
});

test('tax-inclusive Ghana component calculation preserves the customer-facing total', () => {
  const result = computeComponentTaxBreakdown({
    amount: '120.00',
    inclusive: true,
    components: [
      { code: 'VAT', rate: '15' },
      { code: 'NHIL', rate: '2.5' },
      { code: 'GETFUND', rate: '2.5' },
    ],
  });
  assert.equal(result.taxableAmount, '100.00');
  assert.equal(result.taxAmount, '20.00');
  assert.equal(result.totalAmount, '120.00');
});

test('recoverable input tax remains fraction-based and exact', () => {
  assert.deepEqual(applyRecoverablePercent('20.00', '1'), {
    recoverableAmount: '20.00',
    nonRecoverableAmount: '0.00',
  });
  assert.deepEqual(applyRecoverablePercent('20.00', '0.50'), {
    recoverableAmount: '10.00',
    nonRecoverableAmount: '10.00',
  });
});

test('tax rule conditions evaluate arrays, notIn, equality and ranges', () => {
  const facts = { industry: 'telecom', taxCategory: 'standard', amount: 2500, residency: 'resident' };
  assert.equal(conditionsMatch({ industry: 'telecom' }, facts), true);
  assert.equal(conditionsMatch({ taxCategory: { notIn: ['exempt', 'zero_rated'] } }, facts), true);
  assert.equal(conditionsMatch({ amount: { gte: 2000 } }, facts), true);
  assert.equal(conditionsMatch({ residency: ['resident', 'citizen'] }, facts), true);
  assert.equal(conditionsMatch({ industry: 'tourism' }, facts), false);
});

test('tax rule engine selects one rule per group and stacks distinct tax families', async () => {
  const client = {
    query: async (sql) => {
      assert.match(sql, /FROM tax_rules tr/);
      return {
        rows: [
          {
            id: 'vat-standard', code: 'VAT_STANDARD', tax_code_id: 'tax-vat', rule_group: 'VAT',
            document_type: 'invoice', partner_type: 'customer', transaction_scope: 'sales', supply_type: 'services',
            priority: 100, conditions: { taxCategory: { notIn: ['exempt', 'zero_rated'] } },
            rule_tax_type: 'VAT', rule_reporting_group: 'VAT',
          },
          {
            id: 'cst', code: 'CST_TELECOM', tax_code_id: 'tax-cst', rule_group: 'CST',
            document_type: 'invoice', partner_type: 'customer', transaction_scope: 'sales', supply_type: 'services',
            priority: 100, conditions: { industry: 'telecom' },
            rule_tax_type: 'OTHER', rule_reporting_group: 'CST',
          },
          {
            id: 'vat-fallback', code: 'VAT_FALLBACK', tax_code_id: 'tax-vat-old', rule_group: 'VAT',
            document_type: 'invoice', partner_type: 'customer', transaction_scope: 'sales', supply_type: 'services',
            priority: 200, conditions: {}, rule_tax_type: 'VAT', rule_reporting_group: 'VAT',
          },
        ],
      };
    },
  };
  const rules = await findMatchingRules({
    client,
    orgId: 'org',
    context: { documentType: 'invoice', partnerType: 'customer', transactionScope: 'sales', supplyType: 'services', industry: 'telecom' },
    line: { itemTaxCategory: 'standard' },
  });
  assert.deepEqual(rules.map((r) => r.code).sort(), ['CST_TELECOM', 'VAT_STANDARD']);
});

test('exempt VAT rule replaces standard VAT within the same rule group', async () => {
  const client = {
    query: async () => ({
      rows: [
        {
          id: 'standard', code: 'VAT_STANDARD', tax_code_id: 'tax-standard', rule_group: 'VAT',
          document_type: 'invoice', partner_type: 'customer', transaction_scope: 'sales', supply_type: 'services',
          priority: 100, conditions: { taxCategory: { notIn: ['exempt', 'zero_rated'] } }, rule_tax_type: 'VAT',
        },
        {
          id: 'exempt', code: 'VAT_EXEMPT', tax_code_id: 'tax-exempt', rule_group: 'VAT',
          document_type: 'invoice', partner_type: 'customer', transaction_scope: 'sales', supply_type: 'services',
          priority: 100, conditions: { taxCategory: 'exempt' }, rule_tax_type: 'VAT',
        },
      ],
    }),
  };
  const rules = await findMatchingRules({
    client,
    orgId: 'org',
    context: { documentType: 'invoice', partnerType: 'customer', transactionScope: 'sales', supplyType: 'services' },
    line: { taxTreatment: 'exempt' },
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].code, 'VAT_EXEMPT');
});

test('rule grouping defaults VAT and withholding into separate families', () => {
  assert.equal(taxRuleGroup({ rule_tax_type: 'VAT', rule_reporting_group: 'VAT_EXEMPT' }), 'VAT');
  assert.equal(taxRuleGroup({ rule_tax_type: 'WITHHOLDING', rule_reporting_group: 'WHT_RESIDENT' }), 'WITHHOLDING');
  assert.equal(taxRuleGroup({ rule_tax_type: 'OTHER', rule_reporting_group: 'CST' }), 'CST');
});

test('reusable BOTH tax codes resolve to output on sales and input on purchases', async () => {
  const client = {
    query: async (sql) => {
      if (/FROM tax_settings/.test(sql)) return { rows: [{}] };
      if (/SELECT id, organization_id, code, name, tax_type, rate/.test(sql)) {
        return { rows: [{
          id: 'vat', organization_id: 'org', code: 'VAT15', name: 'VAT', tax_type: 'VAT',
          rate: '15.000000', is_compound: false, direction: 'both', box_code: 'VAT', status: 'active',
          tax_scope: 'taxable', application_scope: 'both', calculation_method: 'standard', recoverable_percent: '1',
        }] };
      }
      if (/FROM tax_code_components/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query in direction test: ${sql}`);
    },
  };
  const sale = await resolveLineTaxes({
    client, orgId: 'org', line: { taxCodeId: 'vat' }, defaultTaxableAmount: '100.00',
    context: { transactionScope: 'sales' },
  });
  const purchase = await resolveLineTaxes({
    client, orgId: 'org', line: { taxCodeId: 'vat' }, defaultTaxableAmount: '100.00',
    context: { transactionScope: 'purchases' },
  });
  assert.equal(sale.components[0].direction, 'output');
  assert.equal(purchase.components[0].direction, 'input');
});

test('GRA-1 migration creates canonical catalog, ledger and POS return tax detail', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/sql/148_gra1_tax_kernel.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tax_catalog_profiles/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tax_ledger_entries/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pos_return_line_taxes/i);
  assert.match(migration, /15\.000000 means 15 percent/i);
  assert.match(migration, /GH_STANDARD_GOODS/);
  assert.match(migration, /rule_group/i);
});

test('tax reporting reads canonical ledger, includes POS and does not discard zero-tax rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '../reporting/tax/tax.service.js'), 'utf8');
  assert.match(source, /FROM tax_ledger_entries tle/);
  assert.match(source, /source_type='pos_sale'/);
  assert.match(source, /source_type='pos_return'/);
  const transactionSource = source.slice(source.indexOf('async function getTaxTransactionRows'), source.indexOf('async function vatSummary'));
  assert.doesNotMatch(transactionSource, /COALESCE\(tax_amount\s*,\s*0\)\s*<>\s*0/i);
});

test('POS uses the shared fixed-point component calculator and catalog tax profiles', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/commerce/commerce.service.js'), 'utf8');
  assert.match(source, /computeComponentTaxBreakdown/);
  assert.match(source, /tax_catalog_profiles/);
  assert.match(source, /sales_tax_code_id/);
  assert.match(source, /syncPosTaxDetailToLedger/);
  assert.match(source, /syncPosReturnTaxDetailToLedger/);
});


test('tax posting summaries aggregate exact minor units before compatibility conversion', () => {
  const summary = summarizeLineTaxDetails([
    { id: 'a', taxDetails: [
      { taxAmount: '0.10', direction: 'input', taxType: 'VAT', recoverablePercent: '0.5', postingAccountId: 'tax' },
      { taxAmount: '0.20', direction: 'input', taxType: 'VAT', recoverablePercent: '0.5', postingAccountId: 'tax' },
    ] },
  ]);
  assert.equal(summary.totalTax, 0.30);
  assert.equal(summary.recoverableInputTax, 0.15);
  assert.equal(summary.nonRecoverableInputTax, 0.15);
  assert.equal(summary.byPostingAccount.get('tax'), 0.30);
});

test('e-invoicing emits percentage-point rates without multiplying them by 100', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/integrations/einvoicing/einvoicing.service.js'), 'utf8');
  assert.match(source, /normalizeRate\(t\.rate\)/);
  assert.match(source, /normalizeRate\(firstTax\.tax_rate/);
  assert.doesNotMatch(source, /(?:tax_rate|\.rate)[^\n]{0,50}\*\s*100/);
});
