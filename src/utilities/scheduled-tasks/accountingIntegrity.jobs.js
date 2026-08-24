const { pool } = require('../../db/pool');
const { runWithTenant } = require('../../shared/security/tenantContext');
const { getSystemActorUserId } = require('../../core/foundation/users/systemActor.service');
const integritySvc = require('../../core/accounting/integrity/financialIntegrity.service');
const { metrics } = require('../../observability/metrics.registry');

/**
 * Persist one daily financial-assurance run per tenant execution.
 *
 * Organizations are enumerated outside tenant RLS because organizations is a
 * bootstrap table. Every financial query then executes inside AsyncLocalStorage
 * tenant context so the pool applies PostgreSQL RLS before checkout use.
 */
async function runFinancialIntegrityDaily() {
  const { rows: organizations } = await pool.query(
    `SELECT id FROM organizations ORDER BY created_at ASC`
  );

  const results = [];
  for (const organization of organizations) {
    const orgId = organization.id;
    try {
      const result = await runWithTenant(orgId, async () => {
        const actorUserId = await getSystemActorUserId({ orgId });
        return integritySvc.runIntegrityChecks({ orgId, actorUserId, persist: true });
      });
      results.push({ orgId, ok: true, runId: result.runId, status: result.status, counts: result.counts });
      metrics.integrityRuns.inc({ status: String(result.status || 'completed') });
      if (String(result.status || '').toLowerCase() !== 'pass' && String(result.status || '').toLowerCase() !== 'passed') {
        metrics.integrityFailures.inc({ reason: 'check_failure' });
      }
    } catch (error) {
      results.push({ orgId, ok: false, errorCode: error?.code || 'integrity_run_failed' });
      metrics.integrityRuns.inc({ status: 'execution_failed' });
      metrics.integrityFailures.inc({ reason: 'execution_failed' });
    }
  }

  const failures = results.filter((row) => !row.ok);
  if (failures.length) {
    const error = new Error(`Financial integrity checks failed to execute for ${failures.length} organization(s)`);
    error.code = 'financial_integrity_scheduler_partial_failure';
    error.details = { failures };
    throw error;
  }
  return { organizationsChecked: results.length, results };
}

module.exports = { runFinancialIntegrityDaily };
