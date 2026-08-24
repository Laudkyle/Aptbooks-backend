const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const src = path.resolve(__dirname, '..');
const failures = [];
function read(rel) { return fs.readFileSync(path.join(src, rel), 'utf8'); }
function must(rel, rx, message) {
  const text = read(rel);
  if (!rx.test(text)) failures.push(`${rel}: ${message}`);
}
function mustNot(rel, rx, message) {
  const text = read(rel);
  if (rx.test(text)) failures.push(`${rel}: ${message}`);
}

must('config/env.js', /REFRESH_TOKEN_USE_COOKIE must be true in production/, 'production cookie refresh must fail fast');
must('config/env.js', /RATE_LIMIT_STORE must be postgres in production/, 'distributed rate limiting must be mandatory');
must('config/env.js', /RLS_ENABLED must be true in production/, 'RLS must be mandatory');
must('config/env.js', /DATABASE_MIGRATOR_URL must be set in production/, 'separate migrator identity must be mandatory');
must('db/pool.js', /clearClientTenant/, 'pooled connections must scrub tenant state');
must('db/pool.js', /rolbypassrls/, 'runtime role check must reject BYPASSRLS');
must('middleware/origin.middleware.js', /CORS_ALLOWED_ORIGINS/, 'credential-cookie origin validation missing');
must('middleware/tenantHeader.middleware.js', /x-organization-id/, 'tenant spoofing guard missing');
must('db/migrations/sql/161_phase1_row_level_tenant_isolation.sql', /FORCE ROW LEVEL SECURITY/, 'RLS must be forced');
must('db/migrations/sql/161_phase1_row_level_tenant_isolation.sql', /aptbooks_parent_tenant_isolation/, 'child/detail RLS missing');
must('db/migrate.js', /checksum_sha256/, 'migration checksums missing');
must('core/foundation/users/auth.routes.js', /loginRateLimit/, 'shared login rate limit missing');
mustNot('core/foundation/users/auth.routes.js', /const\s+loginAttempts\s*=\s*new\s+Map/, 'process-local login limiter remains');
must('app.js', /env\.EXPOSE_SWAGGER/, 'Swagger production gate missing');
must('health/health.routes.js', /assertRuntimeRoleSafe/, 'readiness least-privilege gate missing');

const validation = cp.spawnSync(process.execPath, [path.join(__dirname, 'request-validation.audit.js')], { encoding: 'utf8' });
if (validation.status !== 0) failures.push(`request validation coverage failed:\n${validation.stdout}${validation.stderr}`);

const tenantAwareWorkers = [
  'utilities/scheduled-tasks/accruals.jobs.js',
  'utilities/scheduled-tasks/assets.jobs.js',
  'utilities/scheduled-tasks/automation.jobs.js',
  'utilities/scheduled-tasks/ias12.jobs.js',
  'utilities/scheduled-tasks/ifrs9.jobs.js',
  'utilities/scheduled-tasks/ifrs15.jobs.js',
  'utilities/scheduled-tasks/ifrs16.jobs.js',
  'utilities/scheduled-tasks/reports.jobs.js',
  'utilities/scheduled-tasks/maintenance.jobs.js',
  'modules/webhooks/webhooks.service.js',
];
for (const rel of tenantAwareWorkers) {
  const text = read(rel);
  if (!/bindTenant|runWithTenant/.test(text)) failures.push(`${rel}: background tenant context missing`);
}

if (failures.length) {
  console.error('Phase 1 backend security gate: FAIL');
  failures.forEach((f) => console.error(` - ${f}`));
  process.exit(1);
}
console.log('Phase 1 backend security gate: PASS');
console.log(validation.stdout.trim());
