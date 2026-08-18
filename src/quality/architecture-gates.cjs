const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function rel(file) { return path.relative(SRC, file).replaceAll('\\', '/'); }
function read(relative) { return fs.readFileSync(path.join(SRC, relative), 'utf8'); }

function runtimeJsFiles() {
  return walk(SRC).filter((file) => {
    const r = rel(file);
    if (!/\.(?:js|cjs)$/.test(r)) return false;
    if (r.startsWith('tests/') || r.startsWith('tests-node/') || r.startsWith('quality/')) return false;
    if (r.startsWith('db/seeds/') || r === 'db/migrate.js') return false;
    return true;
  });
}

function topLevelFunctionDuplicates(source) {
  const names = [];
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (m) names.push(m[1]);
  }
  const seen = new Set();
  return [...new Set(names.filter((name) => seen.has(name) || !seen.add(name)))];
}

function runArchitectureChecks() {
  const errors = [];
  const runtime = runtimeJsFiles();

  for (const file of runtime) {
    const r = rel(file);
    const source = fs.readFileSync(file, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('//') && /\bconsole\.(?:log|warn|error|debug)\s*\(/.test(line)) {
        errors.push(`${r}:${index + 1}: use config/logger instead of raw console output`);
      }
    });
    if (/child_process["']?\)?\.exec\s*\(|\bexec\s*\(\s*fullCmd/.test(source)) {
      errors.push(`${r}: shell-based child_process.exec is forbidden in runtime code`);
    }
  }

  for (const file of runtime.filter((f) => /\.service\.js$/.test(f))) {
    const duplicates = topLevelFunctionDuplicates(fs.readFileSync(file, 'utf8'));
    if (duplicates.length) errors.push(`${rel(file)}: duplicate top-level functions: ${duplicates.join(', ')}`);
  }

  const budgets = {
    'core/accounting/tax/tax.service.js': 4050,
    'compliance/ifrs15/ifrs15.service.js': 2500,
    'compliance/ifrs9/ifrs9.service.js': 2200,
    'core/accounting/journal/journal.service.js': 1600,
    'reporting/forecasts/forecasts.service.js': 1200,
  };
  for (const [file, maxLines] of Object.entries(budgets)) {
    const count = read(file).split(/\r?\n/).length;
    if (count > maxLines) errors.push(`${file}: ${count} lines exceeds architectural budget ${maxLines}`);
  }

  const reportBuilder = read('reporting/report-builder/reportBuilder.service.js');
  if (!/Custom SQL reports are disabled for tenant isolation/.test(reportBuilder)) {
    errors.push('reporting/report-builder/reportBuilder.service.js: tenant-authored SQL must remain disabled');
  }
  if (/SET TRANSACTION READ ONLY|client\.query\(limited/.test(reportBuilder)) {
    errors.push('reporting/report-builder/reportBuilder.service.js: generic SQL execution engine must not be present');
  }

  const exactMoneyFiles = [
    'modules/transactions/receipts/customer-receipts/customerReceipts.service.js',
    'modules/transactions/payments/vendor-payments/vendorPayments.service.js',
    'modules/transactions/invoices/invoices.service.js',
    'modules/transactions/bills/bills.service.js',
    'modules/assets/fixed-assets/fixedAssets.service.js',
    'modules/assets/depreciation/depreciation.service.js',
    'core/accounting/ledger/reconciliation.service.js',
  ];
  const suspicious = /\bNumber\s*\([^\n]*(?:amount|balance|total|cost|debit|credit|outstanding|applied|tax)/i;
  for (const file of exactMoneyFiles) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (suspicious.test(line) && !/moneyNumber\s*\(/.test(line)) {
        errors.push(`${file}:${index + 1}: financial decision path uses native Number`);
      }
    });
  }

  return errors;
}

module.exports = { SRC, runArchitectureChecks, topLevelFunctionDuplicates };

if (require.main === module) {
  const errors = runArchitectureChecks();
  if (errors.length) {
    console.error(`Architecture gates failed (${errors.length}):`);
    errors.forEach((error) => console.error(` - ${error}`));
    process.exitCode = 1;
  } else {
    console.log('Architecture gates passed.');
  }
}
