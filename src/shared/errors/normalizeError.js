const { AppError } = require('./AppError');

function startCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function detectCode(status, err) {
  if (err instanceof AppError && err.code) return err.code;
  switch (err?.code) {
    case '23505': return 'duplicate_record';
    case '23503': return 'related_record_not_found';
    case '23502': return 'missing_required_field';
    case '22P02': return 'invalid_identifier';
    case '22007': return 'invalid_date';
    case '23514': return 'invalid_value';
    case '42883': return 'unsupported_operation';
    default: break;
  }
  switch (status) {
    case 400: return 'invalid_request';
    case 401: return 'authentication_required';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 413: return 'payload_too_large';
    case 422: return 'validation_error';
    case 429: return 'rate_limit_exceeded';
    default: return 'internal_error';
  }
}

function normalizeValidationDetails(details) {
  if (!details) return undefined;
  const fieldErrors = details.fieldErrors || details.field_errors || undefined;
  const formErrors = details.formErrors || details.form_errors || undefined;
  if (!fieldErrors && !formErrors) return details;
  return {
    fields: fieldErrors || {},
    form: formErrors || []
  };
}

function detectMessage(status, err) {
  if (err?.code === '23505') {
    const raw = String(err?.detail || '');
    const match = raw.match(/Key \((.+?)\)=\((.+?)\) already exists\./);
    if (match) {
      const field = startCase(match[1].split(',')[0]);
      return `${field} already exists. Please use a different value.`;
    }
    return 'This record already exists. Please use a different value.';
  }

  if (err?.code === '23503') {
    return 'This action could not be completed because a related record is missing or still in use.';
  }

  if (err?.code === '23502') {
    const column = firstDefined(err?.column, String(err?.message || '').match(/null value in column \"(.+?)\"/)?.[1]);
    return column
      ? `${startCase(column)} is required.`
      : 'Please complete all required fields and try again.';
  }

  if (err?.code === '22P02') {
    return 'One of the values provided is not valid. Please refresh the page and select a valid option.';
  }

  if (err?.code === '22007') {
    return 'Please enter a valid date and try again.';
  }

  if (err?.code === '23514') {
    return 'One of the values provided is outside the allowed range.';
  }

  const rawMessage = String(err?.message || '').trim();
  const lower = rawMessage.toLowerCase();

  if (lower.includes('validation error')) return 'Please correct the highlighted fields and try again.';
  if (lower.includes('missing bearer token')) return 'Please sign in to continue.';
  if (lower.includes('invalid token')) return 'Your session is no longer valid. Please sign in again.';
  if (lower.includes('invalid api key')) return 'The API key provided is not valid.';
  if (lower.includes('forbidden')) return 'You do not have permission to perform this action.';
  if (lower.includes('unauthenticated')) return 'Please sign in to continue.';
  if (lower.includes('payload too large')) return 'The uploaded content is too large. Please reduce the file size and try again.';
  if (lower.includes('cors')) return 'This request is not allowed from the current origin.';
  if (lower.includes('invalid decimal') || lower === 'invalid number' || lower.includes('too many decimal places')) {
    return 'Please enter a valid amount and try again.';
  }
  if (lower.startsWith('amount must be at least')) return rawMessage;
  if (lower.startsWith('amount cannot exceed')) return rawMessage;
  if (lower.includes('unsupported statementtype')) return 'The selected statement type is not supported.';
  if (lower.includes('invalid pct')) return 'Please enter a valid percentage and try again.';
  if (lower.includes('periodid required') || lower.includes('periodid is required')) return 'Please select an accounting period and try again.';
  if (lower.includes('at least one field required for update')) return 'Please change at least one field before saving.';
  if (lower.includes('center not found')) return 'The selected center could not be found.';
  if (lower.includes('tax return not found')) return 'The selected tax return could not be found.';

  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  if (rawMessage) return rawMessage;

  switch (status) {
    case 400: return 'The request could not be processed. Please check your input and try again.';
    case 401: return 'Please sign in to continue.';
    case 403: return 'You do not have permission to perform this action.';
    case 404: return 'The requested resource could not be found.';
    case 409: return 'This action could not be completed because of a conflict with existing data.';
    case 429: return 'Too many requests. Please wait a moment and try again.';
    default: return 'Something went wrong on our side. Please try again.';
  }
}

function inferStatus(err) {
  if (err instanceof AppError && Number.isInteger(err.status)) return err.status;

  switch (err?.code) {
    case '23505': return 409;
    case '23503': return 409;
    case '23502': return 400;
    case '22P02': return 400;
    case '22007': return 400;
    case '23514': return 400;
    default: break;
  }

  const message = String(err?.message || '').toLowerCase();
  if (message.includes('validation error')) return 422;
  if (message.includes('missing bearer token') || message.includes('invalid token') || message.includes('invalid api key')) return 401;
  if (message.includes('forbidden') || message.includes('api key revoked')) return 403;
  if (message.includes('payload too large')) return 413;
  if (message.includes('unsupported statementtype')) return 400;
  if (message.includes('invalid decimal') || message === 'invalid number' || message.includes('too many decimal places')) return 400;
  if (message.includes('periodid required') || message.includes('at least one field required for update')) return 400;
  return 500;
}

function normalizeError(err, req) {
  const status = inferStatus(err);
  const code = detectCode(status, err);
  const message = detectMessage(status, err);
  const details = normalizeValidationDetails(err?.details);

  return {
    status,
    code,
    message,
    details,
    originalMessage: String(err?.message || ''),
    requestId: req?.request_id || null,
    stack: err?.stack || undefined
  };
}

module.exports = { normalizeError };
