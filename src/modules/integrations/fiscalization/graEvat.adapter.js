const { AppError } = require('../../../shared/errors/AppError');
const { buildSimulationCertification, normalizeFiscalSecurityResponse } = require('./fiscalization.kernel');

/*
 * GRA publishes the certified-invoicing requirements and onboarding flow, but the
 * production API documentation is provided to each taxpayer during GRA onboarding.
 * This adapter therefore exposes a stable boundary without inventing an official
 * request/response contract. The simulation adapter is usable immediately; the live
 * path intentionally refuses to transmit until the onboarding-specific contract
 * mapper is installed.
 */
async function submitToGraEvat({ settings, fiscalDocument }) {
  const mode = settings?.adapter_mode || 'simulation';
  const adapterCode = settings?.adapter_code || 'GRA_EVAT_SIM';
  const payload = fiscalDocument?.payload_json || {};

  if (mode === 'simulation' || adapterCode === 'GRA_EVAT_SIM') {
    const response = buildSimulationCertification(payload);
    return {
      accepted: true,
      simulation: true,
      httpStatus: 200,
      raw: response,
      security: normalizeFiscalSecurityResponse(response)
    };
  }

  if (mode === 'pending_gra_contract') {
    throw new AppError(409, 'GRA E-VAT live API contract is pending. Complete GRA onboarding/testing before enabling live transmission.');
  }

  if (mode === 'live') {
    if (!['signed_off', 'live'].includes(settings?.onboarding_status)) {
      throw new AppError(409, 'GRA E-VAT live mode requires GRA testing/sign-off status');
    }
    if (!settings?.api_contract_version) {
      throw new AppError(409, 'GRA E-VAT API contract version is required for live mode');
    }
    throw new AppError(
      501,
      'GRA E-VAT live transport mapper is not installed. GRA provides the production API contract during taxpayer onboarding; install that contract-specific mapper before go-live.'
    );
  }

  throw new AppError(400, `Unsupported fiscal adapter mode: ${mode}`);
}

module.exports = { submitToGraEvat };
