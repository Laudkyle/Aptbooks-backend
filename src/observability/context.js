const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithObservabilityContext(context, fn) {
  return storage.run(Object.freeze({ ...(context || {}) }), fn);
}

function getObservabilityContext() {
  return storage.getStore() || {};
}

module.exports = { runWithObservabilityContext, getObservabilityContext };
