const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const service = fs.readFileSync(path.join(__dirname, '..', 'core', 'accounting', 'tax', 'tax.service.js'), 'utf8');

test('tax automation upsert writes schema-129 required code and compatibility fields', () => {
  assert.match(service, /INSERT INTO tax_automation_rules\([\s\S]*organization_id, code, name, trigger_code/);
  assert.match(service, /trigger_type, config_json/);
  assert.match(service, /const code = deriveAutomationRuleCode\(payload\)/);
});

test('Ghana workflow installer supplies stable automation codes', () => {
  assert.match(service, /code: "gh_vat_monthly_return_reminder"/);
  assert.match(service, /code: "gh_income_wht_monthly_remittance_reminder"/);
  assert.match(service, /code: "gh_whvat_monthly_return_reminder"/);
});
