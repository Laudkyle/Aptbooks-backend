
const { AppError } = require('../../../shared/errors/AppError');
const templatesRepo = require('../document-templates/documentTemplates.repository');
const templatesSvc = require('../document-templates/documentTemplates.service');
const { buildPayload, samplePayload } = require('./payloadBuilders');
const { renderClassic, renderModern, renderCompact, renderCorporate } = require('./htmlTemplates');
const { getDocumentable } = require('../../../workflow/documents/documentable.registry');
const { withTransaction } = require('../../../db/tx');

function resolveRenderer(baseTemplateKey) {
  switch (baseTemplateKey) {
    case 'classic': return renderClassic;
    case 'modern': return renderModern;
    case 'compact': return renderCompact;
    case 'corporate': return renderCorporate;
    default: return renderClassic;
  }
}

async function resolveTemplate({ orgId, entityType, templateId = null }) {
  await templatesSvc.ensurePresetLibrary({ orgId });
  if (templateId) {
    const tpl = await templatesRepo.getTemplateById({ orgId, templateId });
    if (!tpl) throw new AppError(404, 'Template not found');
    return {
      templateId: tpl.id,
      templateCode: tpl.code,
      templateName: tpl.name,
      templateVersionId: tpl.current_version_id,
      templateVersionNo: tpl.current_version_no,
      baseTemplateKey: tpl.base_template_key,
      layoutConfig: tpl.layout_config || {},
      brandingConfig: tpl.branding_config || {},
      fieldConfig: tpl.field_config || {}
    };
  }
  const assignment = await templatesRepo.getAssignmentByEntityType({ orgId, entityType });
  if (assignment) {
    return {
      templateId: assignment.template_id,
      templateCode: assignment.template_code,
      templateName: assignment.template_name,
      templateVersionId: assignment.resolved_version_id,
      templateVersionNo: assignment.resolved_version_no,
      baseTemplateKey: assignment.base_template_key,
      layoutConfig: assignment.layout_config || {},
      brandingConfig: assignment.branding_config || {},
      fieldConfig: assignment.field_config || {}
    };
  }
  const fallback = await templatesRepo.getDefaultTemplate({ orgId });
  if (!fallback) throw new AppError(404, 'No default document template configured');
  return {
    templateId: fallback.id,
    templateCode: fallback.code,
    templateName: fallback.name,
    templateVersionId: fallback.resolved_version_id,
    templateVersionNo: fallback.resolved_version_no,
    baseTemplateKey: fallback.base_template_key,
    layoutConfig: fallback.layout_config || {},
    brandingConfig: fallback.branding_config || {},
    fieldConfig: fallback.field_config || {}
  };
}

async function previewSample({ orgId, actorUserId, entityType, templateId = null }) {
  const docInfo = getDocumentable(entityType);
  if (!docInfo) throw new AppError(400, 'Unsupported entity type');
  const template = await resolveTemplate({ orgId, entityType, templateId });
  const payload = samplePayload(entityType);
  const renderer = resolveRenderer(template.baseTemplateKey);
  const html = renderer({ title: docInfo.documentTypeName, payload, layout: template.layoutConfig, branding: template.brandingConfig, fields: template.fieldConfig });
  await withTransaction(async (client) => templatesRepo.insertRenderLog(client, {
    orgId,
    entityType,
    templateId: template.templateId,
    templateVersionId: template.templateVersionId,
    actorUserId,
    renderMode: 'sample_preview'
  }));
  return { template, payload, html, contentType: 'text/html' };
}

async function renderDocument({ orgId, actorUserId, entityType, documentId, templateId = null, mode = 'preview' }) {
  const docInfo = getDocumentable(entityType);
  if (!docInfo) throw new AppError(400, 'Unsupported entity type');
  const template = await resolveTemplate({ orgId, entityType, templateId });
  const payload = await buildPayload({ orgId, entityType, documentId });
  const renderer = resolveRenderer(template.baseTemplateKey);
  const html = renderer({ title: docInfo.documentTypeName, payload, layout: template.layoutConfig, branding: template.brandingConfig, fields: template.fieldConfig });
  await withTransaction(async (client) => templatesRepo.insertRenderLog(client, {
    orgId,
    entityType,
    entityId: documentId,
    templateId: template.templateId,
    templateVersionId: template.templateVersionId,
    actorUserId,
    renderMode: mode
  }));
  return { template, payload, html, contentType: 'text/html' };
}

module.exports = { previewSample, renderDocument };
