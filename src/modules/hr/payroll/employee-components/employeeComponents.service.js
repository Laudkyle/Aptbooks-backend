const repo = require("./employeeComponents.repository"); 

async function assignComponent({ orgId, payload }) {
  return repo.createAssignment(orgId, payload); 
}

async function listAssignments({ orgId, query }) {
  return repo.listAssignments(orgId, query); 
}

async function getAssignment({ orgId, assignmentId }) {
  return repo.getAssignment(orgId, assignmentId); 
}

async function updateAssignment({ orgId, assignmentId, payload }) {
  return repo.updateAssignment(orgId, assignmentId, payload); 
}

async function deactivateAssignment({ orgId, assignmentId }) {
  return repo.setStatus(orgId, assignmentId, "inactive"); 
}

module.exports = {
  assignComponent,
  listAssignments,
  getAssignment,
  updateAssignment,
  deactivateAssignment,
}; 
