const repo = require("./components.repository");

async function createComponent({ orgId, payload }) {
  return repo.createComponent(orgId, payload);
}

async function listComponents({ orgId, query }) {
  return repo.listComponents(orgId, query);
}

async function getComponent({ orgId, componentId }) {
  return repo.getComponent(orgId, componentId);
}

async function updateComponent({ orgId, componentId, payload }) {
  return repo.updateComponent(orgId, componentId, payload);
}

async function deactivateComponent({ orgId, componentId }) {
  return repo.setStatus(orgId, componentId, "inactive");
}

module.exports = {
  createComponent,
  listComponents,
  getComponent,
  updateComponent,
  deactivateComponent,
};
