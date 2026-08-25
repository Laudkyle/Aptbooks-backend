const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'phase3-debt-baseline.json'), 'utf8'));
const rel = (file) => path.relative(SRC, file).replaceAll('\\', '/');
const read = (r) => fs.readFileSync(path.join(SRC, r), 'utf8');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function count(source, regex) {
  return [...source.matchAll(regex)].length;
}

function currentCounts(suffix, regex) {
  const result = {};
  for (const file of walk(SRC)) {
    const r = rel(file);
    if (!r.endsWith(suffix)) continue;
    const n = count(fs.readFileSync(file, 'utf8'), regex);
    if (n) result[r] = n;
  }
  return result;
}

function ratchetCounts(errors, label, current, allowed) {
  for (const [file, value] of Object.entries(current)) {
    const max = allowed[file] || 0;
    if (value > max) errors.push(`${label}: ${file} has ${value}; Phase 3 baseline allows ${max}`);
  }
}

function upwardImports() {
  const out = {};
  const root = path.join(SRC, 'core/accounting');
  for (const file of walk(root).filter((x) => x.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    const matches = [...source.matchAll(/require\(['"][^'"]*(?:modules|reporting|compliance)\/[^'"]*['"]\)/g)].map((m) => m[0]);
    if (matches.length) out[rel(file)] = [...new Set(matches)].sort();
  }
  return out;
}

function runPhase3MaintainabilityGate() {
  const errors = [];

  ratchetCounts(errors, 'SELECT * repository debt',
    currentCounts('.repository.js', /\bSELECT\s+\*/gi), baseline.selectStarByRepository);
  ratchetCounts(errors, 'direct pool.query service debt',
    currentCounts('.service.js', /\bpool\.query\s*\(/g), baseline.directPoolQueryByService);
  ratchetCounts(errors, 'direct pool.query route debt',
    currentCounts('.routes.js', /\bpool\.query\s*\(/g), baseline.directPoolQueryByRoute);

  for (const file of walk(SRC).filter((x) => x.endsWith('.js'))) {
    const r = rel(file);
    if (r.startsWith('tests/') || r.startsWith('tests-node/') || r.startsWith('quality/') || r.startsWith('db/seeds/')) continue;
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).length;
    if (lines <= 800) continue;
    const max = baseline.legacyLargeFiles[r];
    if (!max) errors.push(`${r}: new runtime file has ${lines} lines; new modules must stay <= 800 lines`);
    else if (lines > max) errors.push(`${r}: legacy file grew to ${lines} lines; Phase 3 debt budget is ${max}`);
  }

  const currentUpward = upwardImports();
  for (const [file, imports] of Object.entries(currentUpward)) {
    const allowed = new Set(baseline.coreAccountingUpwardImports[file] || []);
    for (const spec of imports) if (!allowed.has(spec)) errors.push(`${file}: new core-accounting upward dependency ${spec}`);
  }

  const taxRootLines = read('core/accounting/tax/tax.routes.js').trimEnd().split(/\r?\n/).length;
  if (taxRootLines > 80) errors.push(`core/accounting/tax/tax.routes.js must remain a composition root (got ${taxRootLines} lines)`);
  for (const name of ['tax-workspace.routes.js', 'tax-setup.routes.js', 'tax-compliance.routes.js', 'tax-returns.routes.js', 'tax-withholding.routes.js']) {
    const r = `core/accounting/tax/${name}`;
    if (!fs.existsSync(path.join(SRC, r))) errors.push(`${r}: missing bounded tax route module`);
    else if (read(r).trimEnd().split(/\r?\n/).length > 700) errors.push(`${r}: route module exceeds 700-line Phase 3 ceiling`);
  }

  for (const required of ['shared/db/repositoryStandard.js', 'types/brands.d.ts', 'types/accounting.d.ts', 'types/http.d.ts', 'tsconfig.phase3.json']) {
    if (!fs.existsSync(path.join(SRC, required))) errors.push(`${required}: missing Phase 3 standardization artifact`);
  }
  const repoStandard = read('shared/db/repositoryStandard.js');
  for (const name of ['explicitColumns', 'tenantPredicate', 'queryMany', 'queryOne', 'queryRequired', 'requireOrganizationId']) {
    if (!new RegExp(`\\b${name}\\b`).test(repoStandard)) errors.push(`repositoryStandard.js: missing ${name}`);
  }
  const tsconfig = JSON.parse(read('tsconfig.phase3.json'));
  if (tsconfig.compilerOptions?.strict !== true || tsconfig.compilerOptions?.noEmit !== true) {
    errors.push('tsconfig.phase3.json must keep strict=true and noEmit=true');
  }

  return errors;
}

module.exports = { runPhase3MaintainabilityGate };

if (require.main === module) {
  const errors = runPhase3MaintainabilityGate();
  if (errors.length) {
    console.error(`Phase 3 maintainability gate failed (${errors.length}):`);
    errors.forEach((error) => console.error(` - ${error}`));
    process.exitCode = 1;
  } else {
    console.log('Phase 3 maintainability gate passed.');
  }
}
