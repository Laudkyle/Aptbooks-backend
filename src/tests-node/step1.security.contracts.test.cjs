const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('accounting imports and webhook management require authentication', () => {
  for (const file of ['core/accounting/imports/imports.routes.js', 'modules/webhooks/webhooks.routes.js']) {
    const source = read(file);
    assert.match(source, /router\.use\(authRequired\)/);
  }
});

test('manual webhook dispatch is tenant scoped', () => {
  const routes = read('modules/webhooks/webhooks.routes.js');
  const service = read('modules/webhooks/webhooks.service.js');
  assert.match(routes, /dispatchPending\(\{ limit, orgId \}\)/);
  assert.match(service, /async function claimPending\(\{ limit, orgId = null \}\)/);
  assert.match(service, /organization_id=\$3/);
});

test('saved report builder refuses free-form SQL and GET collaboration reads do not require idempotency', () => {
  const service = read('reporting/report-builder/reportBuilder.service.js');
  const routes = read('reporting/report-builder/reportBuilder.routes.js');
  assert.match(service, /Custom SQL reports are disabled for tenant isolation/);
  assert.doesNotMatch(routes, /"\/:reportId\/shares",[\s\S]{0,120}idempotency/);
  assert.doesNotMatch(routes, /"\/:reportId\/schedules",[\s\S]{0,120}idempotency/);
});

test('test runner does not use shell exec and is blocked in production', () => {
  const source = read('utilities/tests/tests.service.js');
  assert.doesNotMatch(source, /child_process["']\)\.exec|\{ exec \}/);
  assert.match(source, /spawn\(/);
  assert.match(source, /shell:\s*false/);
  assert.match(source, /Test runner API is not available in production/);
});

test('tenant HTTP users cannot administer the global scheduler', () => {
  const source = read('utilities/scheduled-tasks/scheduledTasks.routes.js');
  assert.match(source, /Scheduled-task administration is internal-only/);
  assert.doesNotMatch(source, /requirePermission\(\"settings\.manage\"\)/);
});

test('tenant error-log routes exclude global rows and sensitive diagnostic columns', () => {
  const source = read('utilities/errors/errors.routes.js');
  assert.doesNotMatch(source, /organization_id IS NULL/);
  assert.doesNotMatch(source, /SELECT \*/);
  assert.doesNotMatch(source, /stack|user_agent|\bip\b/);
  assert.match(source, /WHERE organization_id=\$1/);
});

test('saved report list carries tenant-scoped latest version kind for legacy SQL disablement', () => {
  const source = read('reporting/report-builder/reportBuilder.repository.js');
  assert.match(source, /SELECT r\.\*, latest\.kind/);
  assert.match(source, /v\.organization_id=r\.organization_id/);
  assert.match(source, /r\.organization_id=\$1/);
});

test('automation accounting-jobs route cannot expose the global scheduler to tenant RBAC', () => {
  const source = read('modules/automation/accounting-jobs/accountingJobs.routes.js');
  assert.match(source, /Accounting job administration is internal-only/);
  assert.doesNotMatch(source, /requirePermission/);
});

test('tenant automation and health endpoints do not expose global scheduler history', () => {
  const smart = read('modules/automation/smart-notifications/smartNotifications.service.js');
  const health = read('health/health.routes.js');
  assert.match(smart, /scheduler_failures is a platform-only trigger/);
  const branch = smart.match(/if \(rule\.trigger_type === 'scheduler_failures'\)[\s\S]*?else if \(rule\.trigger_type === 'recurring_due'\)/)?.[0] || '';
  assert.doesNotMatch(branch, /FROM\s+scheduled_task_runs/i);
  assert.match(health, /checks\.scheduler = \{ restricted: true \}/);
  const systemRoute = health.slice(health.indexOf('"/health/system"'));
  assert.doesNotMatch(systemRoute, /schedulerHealthSummary\(/);
});
