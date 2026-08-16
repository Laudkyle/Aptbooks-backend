const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  payloadHash, validateFiscalPayload, nextRetryAt, offlineDeadline, buildSimulationCertification,
  normalizeFiscalSecurityResponse, sumMoney
} = require('../modules/integrations/fiscalization/fiscalization.kernel');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const basePayload = {
  documentType:'sales_receipt', transactionType:'sale', documentNumber:'POS-00000001', supplyAt:'2026-08-16T10:00:00.000Z',
  currencyCode:'GHS', seller:{name:'Apt Mart Ltd',taxId:'C0012345678',address:'Accra, Ghana'}, buyer:{name:null,taxId:null},
  lines:[{description:'Item A',quantity:'1.000000',unitOfMeasure:'EA',taxExclusiveAmount:'100.00'}],
  totals:{taxExclusiveAmount:'100.00',totalTax:'20.00',taxInclusiveAmount:'120.00'},
  device:{machineRegistrationCode:'MRC-001'}
};

test('fiscal payload hash is deterministic across object key order', () => {
  const a = payloadHash({ z: 1, a: { y: 2, x: 3 } });
  const b = payloadHash({ a: { x: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
});

test('GRA fiscal payload validator enforces seller identity, supply time, number and line detail', () => {
  assert.equal(validateFiscalPayload(basePayload).valid, true);
  const broken = structuredClone(basePayload); broken.seller.taxId = null; broken.lines[0].unitOfMeasure = null;
  const out = validateFiscalPayload(broken);
  assert.equal(out.valid, false);
  assert.ok(out.errors.some((x) => x.includes('TIN')));
  assert.ok(out.errors.some((x) => x.includes('unit of measure')));
});

test('buyer TIN can be required where a receipt is intended to support input tax credit', () => {
  const out = validateFiscalPayload({ ...basePayload, buyerTaxIdRequiredForInputCredit: true });
  assert.equal(out.valid, false);
  assert.ok(out.errors.some((x) => x.includes('Buyer name and TIN')));
});

test('simulation certification exposes all GRA security artifact slots but is unmistakably simulated', () => {
  const sim = buildSimulationCertification(basePayload);
  assert.equal(sim.simulation, true);
  for (const key of ['commissionerGeneralSignature','qrCode','receiptSignature','invoiceSignature','verificationEngineId','fiscalTimestamp','serialNumber','receiptNumber','machineRegistrationCode','graReference']) assert.ok(sim[key]);
  assert.match(sim.graReference, /^SIM-/);
});

test('security response normalization supports adapter snake_case/camelCase variants', () => {
  const out = normalizeFiscalSecurityResponse({ qr_code:'QR', receipt_signature:'RS', verification_engine_id:'VE', machine_registration_code:'MC' });
  assert.equal(out.qrCode,'QR'); assert.equal(out.receiptSignature,'RS'); assert.equal(out.verificationEngineId,'VE'); assert.equal(out.machineRegistrationCode,'MC');
});

test('offline fiscal deadline never exceeds the 24-hour configured cap', () => {
  const start = new Date('2026-08-16T10:00:00Z');
  assert.equal(offlineDeadline(start, 24).toISOString(), '2026-08-17T10:00:00.000Z');
  assert.equal(offlineDeadline(start, 48).toISOString(), '2026-08-17T10:00:00.000Z');
});

test('retry schedule uses bounded exponential backoff', () => {
  const start = new Date('2026-08-16T10:00:00Z');
  assert.equal(nextRetryAt(1,start).toISOString(), '2026-08-16T10:01:00.000Z');
  assert.equal(nextRetryAt(3,start).toISOString(), '2026-08-16T10:04:00.000Z');
  assert.equal(nextRetryAt(20,start).toISOString(), '2026-08-16T12:08:00.000Z');
});

test('fiscal monetary summation stays on integer minor units', () => {
  assert.equal(sumMoney(['15.00','2.50','2.50']), '20.00');
  assert.equal(sumMoney(['0.10','0.20']), '0.30');
});

test('Release 5 migration models fiscal documents, devices, queue, security fields and append-only logs', () => {
  const sql = read('db/migrations/sql/152_gra5_evat_fiscalization.sql');
  for (const token of ['fiscalization_settings','fiscal_locations','fiscal_devices','fiscal_documents','fiscal_transmission_queue','fiscal_system_logs','commissioner_general_signature','qr_code','receipt_signature','verification_engine_id','machine_registration_code','offline_deadline_at','FOR EACH ROW EXECUTE FUNCTION prevent_fiscal_system_log_mutation']) assert.match(sql,new RegExp(token));
});

test('queue claiming uses FOR UPDATE SKIP LOCKED and durable claimed state', () => {
  const src = read('modules/integrations/fiscalization/fiscalization.service.js');
  assert.match(src,/FOR UPDATE SKIP LOCKED/); assert.match(src,/status='claimed'/); assert.match(src,/claimed_at < NOW\(\) - INTERVAL '10 minutes'/);
});

test('live GRA adapter does not invent a production API contract', () => {
  const src = read('modules/integrations/fiscalization/graEvat.adapter.js');
  assert.match(src,/production API documentation is provided/);
  assert.match(src,/live transport mapper is not installed/);
  assert.match(src,/GRA_EVAT_SIM/);
});

test('invoice issuance and POS completion/create automatically prepare fiscal snapshots when enabled', () => {
  const invoice = read('modules/transactions/invoices/invoices.service.js');
  const commerce = read('modules/commerce/commerce.service.js');
  assert.match(invoice,/autoPrepareForSource[\s\S]*sourceType: 'invoice'/);
  assert.match(commerce,/autoPrepareForSource[\s\S]*sourceType: 'pos_sale'/);
});

test('fiscalization API exposes settings, readiness, devices, documents, offline and queue processing', () => {
  const routes = read('modules/integrations/fiscalization/fiscalization.routes.js');
  for (const token of ['/settings','/readiness','/devices','/documents','/offline','/queue/process','/logs']) assert.ok(routes.includes(token));
});

test('fiscal queue processing remains organization-scoped and simulation is never labelled official certification', () => {
  const src = read('modules/integrations/fiscalization/fiscalization.service.js');
  const migration = read('db/migrations/sql/152_gra5_evat_fiscalization.sql');
  assert.match(src,/WHERE organization_id=\$3 AND status IN \('queued','retry'\)/);
  assert.match(src,/documentStatus = simulated \? 'simulated' : 'certified'/);
  assert.match(migration,/is_simulation BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration,/simulated/);
});

test('POS receipt payload exposes fiscal status and security artifacts after processing', () => {
  const commerce = read('modules/commerce/commerce.service.js');
  assert.match(commerce,/commissioner_general_signature/);
  assert.match(commerce,/qr_code/);
  assert.match(commerce,/machine_registration_code/);
  assert.match(commerce,/is_simulation/);
});
