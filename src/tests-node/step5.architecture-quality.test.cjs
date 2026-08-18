const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SRC, runArchitectureChecks, topLevelFunctionDuplicates } = require('../quality/architecture-gates.cjs');

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('repository architecture gates pass', () => {
  assert.deepEqual(runArchitectureChecks(), []);
});

test('forecast service no longer contains silent duplicate implementations', () => {
  const source = read('reporting/forecasts/forecasts.service.js');
  assert.deepEqual(topLevelFunctionDuplicates(source), []);
  assert.ok(source.split(/\r?\n/).length <= 1200);
});

test('sensitive runtime diagnostics use structured logging and report builder has no SQL executor', () => {
  const statements = read('reporting/financial-statements/financialStatements.repository.js');
  const opsDocs = read('modules/transactions/_shared/opsDocs.repository.js');
  const partners = read('modules/business/partners/partners.routes.js');
  const reportBuilder = read('reporting/report-builder/reportBuilder.service.js');
  assert.match(statements, /const logger = require\("\.\.\/\.\.\/config\/logger"\)/);
  assert.doesNotMatch(statements, /console\./);
  assert.doesNotMatch(opsDocs, /console\./);
  assert.doesNotMatch(partners, /tax profile update request with body/);
  assert.doesNotMatch(reportBuilder, /SET TRANSACTION READ ONLY|client\.query\(limited/);
});
