const renderSvc = require('../modules/printing/render/render.service');

async function previewTransactionTemplate({ orgId, actorUserId, entityType, templateId }) {
  return renderSvc.previewSample({ orgId, actorUserId, entityType, templateId: templateId || null });
}

async function renderTransactionDocument({ orgId, actorUserId, entityType, documentId, templateId, mode }) {
  return renderSvc.renderDocument({ orgId, actorUserId, entityType, documentId, templateId: templateId || null, mode: mode || 'preview' });
}

module.exports = { previewTransactionTemplate, renderTransactionDocument };
