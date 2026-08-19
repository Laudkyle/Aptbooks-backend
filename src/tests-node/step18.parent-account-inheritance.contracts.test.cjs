const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('CoA service enforces parent/child account type compatibility and inherits parent category', () => {
  const src = read('src/core/accounting/chart-of-accounts/coa.service.js');
  assert.match(src, /getParentAccount/);
  assert.match(src, /Child account type must match the parent account type/);
  assert.match(src, /parent\?\.account_type_id/);
  assert.match(src, /parent\?\.category_id \|\| null/);
  assert.match(src, /categoryId = parent\.category_id/);
});

test('existing-account parent changes preserve cycle protection and enforce the immutable account type', () => {
  const src = read('src/core/accounting/chart-of-accounts/coa.service.js');
  assert.match(src, /Account cannot be its own parent/);
  assert.match(src, /Circular parent reference not allowed/);
  assert.match(src, /String\(parent\.account_type_id\) !== String\(existing\[0\]\.account_type_id\)/);
});
