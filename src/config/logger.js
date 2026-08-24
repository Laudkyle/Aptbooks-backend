const pino = require('pino');
const { getObservabilityContext } = require('../observability/context');

const redact = {
  paths: [
    'password', 'token', 'accessToken', 'refreshToken', 'authorization',
    'req.headers.authorization', 'headers.authorization', 'apiKey', 'secret',
    '*.password', '*.token', '*.accessToken', '*.refreshToken', '*.secret'
  ],
  censor: '[REDACTED]'
};

module.exports = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: process.env.SERVICE_NAME || 'aptbooks-backend',
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || process.env.RELEASE_VERSION || 'dev',
  },
  redact,
  mixin() {
    const context = getObservabilityContext();
    return {
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.traceId ? { traceId: context.traceId } : {}),
      ...(context.spanId ? { spanId: context.spanId } : {}),
    };
  },
});
