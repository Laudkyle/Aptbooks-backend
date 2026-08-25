const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('migration 166 installs tenant-safe versioned dashboards, placements, snapshots and reusable templates', () => {
  const src = read('db/migrations/sql/166_global_dashboard_studio.sql');
  for (const table of ['dashboard_shares','dashboard_placements','dashboard_revisions','dashboard_snapshots','dashboard_templates','dashboard_template_revisions']) {
    assert.match(src, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}|['\"]${table}['\"]`));
  }
  assert.match(src, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(src, /ALTER TABLE public\.%I FORCE ROW LEVEL SECURITY/);
  assert.match(src, /aptbooks_current_organization_id\(\)/);
  assert.match(src, /UNIQUE\(template_id,version\)/);
  assert.match(src, /CHECK \(template_scope IN \('private','organization'\)\)/);
});

test('three immutable AptBooks templates are prepopulated across application domains', () => {
  const { listSystemTemplates } = require('../reporting/dashboards/systemTemplates');
  const templates = listSystemTemplates();
  assert.equal(templates.length, 3);
  assert.deepEqual(templates.map((t) => t.name), ['Executive 360','Finance & Liquidity Control','Operations & Compliance Control']);
  for (const template of templates) {
    assert.match(template.id, /^system:/);
    assert.equal(template.scope, 'system');
    assert.ok(template.definition.widgets.length >= 8);
    const domains = new Set(template.definition.widgets.map((w) => w.metricKey.split('.')[0]));
    assert.ok(domains.size >= 3, `${template.name} should span multiple AptBooks domains`);
  }
});

test('dashboard template lifecycle is versioned, reusable and separate from live dashboard placement', () => {
  const service = read('reporting/dashboards/dashboards.service.js');
  const repo = read('reporting/dashboards/dashboards.repository.js');
  const routes = read('reporting/dashboards/dashboards.routes.js');
  assert.match(routes, /router\.post\('\/templates'/);
  assert.match(routes, /\/templates\/:templateId\/instantiate/);
  assert.match(service, /System templates cannot be edited; save a copy instead/);
  assert.match(service, /dashboard_template_version_conflict/);
  assert.match(service, /payload\.definition/);
  assert.match(repo, /dashboard_template_revisions/);
  assert.match(repo, /expectedVersion/);
  assert.match(service, /repo\.createDashboard/);
  assert.doesNotMatch(service, /instantiateTemplate[\s\S]{0,1400}replacePlacements/);
});

test('semantic metric layer is application-wide and permission checked on every execution', () => {
  const registry = read('reporting/dashboards/metrics/metricRegistry.js');
  const executor = read('reporting/dashboards/metrics/metricExecutor.js');
  for (const prefix of ['accounting.','receivables.','payables.','banking.','treasury.','inventory.','assets.','tax.','commerce.','hr.','planning.','workflow.']) {
    assert.match(registry, new RegExp(prefix.replace('.', '\\.')));
  }
  assert.match(executor, /repo\.hasPermission/);
  assert.match(executor, /organizationId:ctx\.organizationId,userId:ctx\.userId/);
  assert.match(executor, /dashboard_metric_forbidden/);
  assert.doesNotMatch(registry, /SELECT\s|INSERT\s|UPDATE\s|DELETE\s/i);
});

test('dashboard definitions remain declarative and reject unregistered metrics, groupings and visualizations', () => {
  const service = read('reporting/dashboards/dashboards.service.js');
  assert.match(service, /dashboard_metric_not_found/);
  assert.match(service, /dashboard_visualization_invalid/);
  assert.match(service, /dashboard_metric_grouping_invalid/);
  assert.match(service, /MAX_WIDGETS=24/);
  assert.doesNotMatch(service, /eval\(|new Function\(/);
});
