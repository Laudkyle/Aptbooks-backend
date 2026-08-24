const { z } = require('zod');
const { AppError } = require('../errors/AppError');

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function inspectJson(value, path = '$', state = { nodes: 0 }, limits = {}) {
  const maxDepth = Number(limits.maxDepth || 30);
  const maxNodes = Number(limits.maxNodes || 50000);
  const maxStringLength = Number(limits.maxStringLength || 1_000_000);
  const depth = Number(limits.depth || 0);

  state.nodes += 1;
  if (state.nodes > maxNodes) throw new AppError(413, 'Request body is too complex', { path }, 'request_too_complex');
  if (depth > maxDepth) throw new AppError(413, 'Request body nesting is too deep', { path }, 'request_too_deep');

  if (typeof value === 'string' && value.length > maxStringLength) {
    throw new AppError(413, 'A request field is too large', { path }, 'request_field_too_large');
  }
  if (!value || typeof value !== 'object') return;

  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) {
    throw new AppError(400, 'Invalid request object', { path }, 'invalid_request_object');
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      inspectJson(value[i], `${path}[${i}]`, state, { ...limits, depth: depth + 1 });
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new AppError(400, 'Request contains a forbidden property name', { path: `${path}.${key}` }, 'forbidden_request_property');
    }
    inspectJson(child, `${path}.${key}`, state, { ...limits, depth: depth + 1 });
  }
}

function requestSafetyMiddleware(req, _res, next) {
  try {
    if (req.body !== undefined && req.body !== null) inspectJson(req.body);
    if (req.query !== undefined && req.query !== null) inspectJson(req.query, '$query', { nodes: 0 }, { maxDepth: 10, maxNodes: 5000, maxStringLength: 10000 });
    if (req.params !== undefined && req.params !== null) inspectJson(req.params, '$params', { nodes: 0 }, { maxDepth: 5, maxNodes: 500, maxStringLength: 5000 });
    next();
  } catch (error) {
    next(error);
  }
}

function formatZodError(error) {
  const flattened = error.flatten();
  return {
    fields: flattened.fieldErrors,
    fieldErrors: flattened.fieldErrors, // compatibility during API-contract migration
    formErrors: flattened.formErrors,
  };
}

function parseWithSchema(schema, value, source) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(422, 'Please correct the highlighted fields and try again.', {
      source,
      ...formatZodError(result.error),
    }, 'validation_error');
  }
  return result.data;
}

function validateBody(schema) {
  return (req, _res, next) => {
    try {
      req.body = parseWithSchema(schema, req.body ?? {}, 'body');
      next();
    } catch (error) { next(error); }
  };
}

function validateQuery(schema) {
  return (req, _res, next) => {
    try {
      req.query = parseWithSchema(schema, req.query ?? {}, 'query');
      next();
    } catch (error) { next(error); }
  };
}

function validateParams(schema) {
  return (req, _res, next) => {
    try {
      req.params = parseWithSchema(schema, req.params ?? {}, 'params');
      next();
    } catch (error) { next(error); }
  };
}

function strictObjectFromKeys(keys) {
  const shape = {};
  for (const key of keys || []) shape[key] = z.unknown().optional();
  return z.object(shape).strict();
}

function createModuleBodyContract(keys, { allowEmpty = true } = {}) {
  const unique = Array.from(new Set((keys || []).filter(Boolean))).sort();
  const schema = strictObjectFromKeys(unique).superRefine((value, ctx) => {
    if (!allowEmpty && Object.keys(value).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Request body cannot be empty' });
    }
  });
  return validateBody(schema);
}

module.exports = {
  z,
  requestSafetyMiddleware,
  validateBody,
  validateQuery,
  validateParams,
  parseWithSchema,
  createModuleBodyContract,
};
