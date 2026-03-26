const { withTransaction } = require("../../../db/tx");
const { AppError } = require("../../../shared/errors/AppError");
const { writeAudit } = require("../../../core/foundation/audit-logs/audit.service");
const repo = require("./documentTemplates.repository");
const { PRESET_TEMPLATE_LIBRARY, listSupportedDocumentTypes, SUPPORTED_TRANSACTION_ENTITY_TYPES } = require("./constants");

async function ensurePresetLibrary({ orgId, actorUserId = null }) {
  const current = await repo.listTemplates({ orgId });
  if (current.length) return current;

  await withTransaction(async (client) => {
    let defaultTemplateId = null;
    
    for (const preset of PRESET_TEMPLATE_LIBRARY) {
      let tpl = await repo.getTemplateByCode({ orgId, code: preset.code, client });
      
      if (!tpl) {
        try {
          tpl = await repo.createTemplate(client, {
            orgId,
            actorUserId,
            code: preset.code,
            name: preset.name,
            description: preset.description,
            baseTemplateKey: preset.baseTemplateKey,
            paperSize: preset.paperSize,
            orientation: preset.orientation,
            isActive: true,
            isSystem: true,
            isDefault: preset.isDefault === true
          });
        } catch (error) {
          // If duplicate key error, try to fetch the existing template
          if (error.code === '23505' || (error.message && error.message.includes('duplicate key'))) {
            tpl = await repo.getTemplateByCode({ orgId, code: preset.code, client });
            if (!tpl) {
              throw error; // Re-throw if we still can't find it
            }
          } else {
            throw error;
          }
        }
        
        // Verify creation was successful
        if (!tpl || !tpl.id) {
          throw new AppError(500, `Failed to create preset template: ${preset.code}`);
        }
        
        // Only create version if this is a newly created template
        if (tpl && tpl.id) {
          await repo.createVersion(client, {
            templateId: tpl.id,
            actorUserId,
            layoutConfig: preset.layoutConfig,
            brandingConfig: preset.brandingConfig,
            fieldConfig: preset.fieldConfig,
            status: 'published',
            isPublished: true
          });
        }
      }
      
      // Check if tpl exists and has an id before accessing
      if (preset.isDefault === true && tpl && tpl.id) {
        defaultTemplateId = tpl.id;
      }
    }
    
    if (defaultTemplateId) {
      await repo.unsetOtherDefaults(client, { orgId, exceptTemplateId: defaultTemplateId });
      
      for (const entityType of SUPPORTED_TRANSACTION_ENTITY_TYPES) {
        const existing = await repo.getAssignmentByEntityType({ orgId, entityType, client });
        if (!existing) {
          await repo.upsertAssignment(client, {
            orgId,
            entityType,
            templateId: defaultTemplateId,
            actorUserId,
            isActive: true,
            notes: 'Auto-created default transaction template assignment'
          });
        }
      }
    }
  });
  
  return repo.listTemplates({ orgId });
}

async function listTemplates({ orgId }) {
  await ensurePresetLibrary({ orgId });
  return repo.listTemplates({ orgId });
}

async function getTemplate({ orgId, templateId }) {
  await ensurePresetLibrary({ orgId });
  const found = await repo.getTemplateById({ orgId, templateId });
  if (!found) throw new AppError(404, 'Template not found');
  return found;
}

async function createTemplate({ orgId, actorUserId, payload, audit = {} }) {
  let out = null;
  
  try {
    out = await withTransaction(async (client) => {
      // Check if template already exists
      const existing = await repo.getTemplateByCode({ orgId, code: payload.code, client });
      if (existing) {
        return existing;
      }
      
      const created = await repo.createTemplate(client, {
        orgId,
        actorUserId,
        ...payload,
        isSystem: false
      });
      
      if (!created || !created.id) {
        throw new AppError(500, 'Failed to create template');
      }
      
      if (payload.isDefault) {
        await repo.unsetOtherDefaults(client, { orgId, exceptTemplateId: created.id });
      }
      
      await repo.createVersion(client, {
        templateId: created.id,
        actorUserId,
        layoutConfig: payload.layoutConfig || {},
        brandingConfig: payload.brandingConfig || {},
        fieldConfig: payload.fieldConfig || {},
        status: 'published',
        isPublished: true
      });
      
      return repo.getTemplateById({ orgId, templateId: created.id });
    });
    
    // Only write audit if template was successfully created and is new
    if (out && out.id) {
      // Check if this is a newly created template (not an existing one)
      const isNew = out.created_at && (new Date() - new Date(out.created_at)) < 5000; // Created in last 5 seconds
      if (isNew) {
        await writeAudit({
          organizationId: orgId,
          actorUserId,
          action: 'document_template.created',
          entityType: 'document_template',
          entityId: out.id,
          ip: audit.ip,
          userAgent: audit.userAgent,
          after: out
        });
      }
    }
    
    return out;
  } catch (error) {
    // Handle duplicate key error gracefully
    if (error.code === '23505' || (error.message && error.message.includes('duplicate key'))) {
      // Template already exists, try to fetch it
      const existingTemplate = await repo.getTemplateByCode({ orgId, code: payload.code });
      if (existingTemplate) {
        return existingTemplate;
      }
    }
    throw error;
  }
}

async function updateTemplate({ orgId, actorUserId, templateId, payload, audit = {} }) {
  const before = await getTemplate({ orgId, templateId });
  
  const out = await withTransaction(async (client) => {
    const updated = await repo.updateTemplate(client, { orgId, templateId, actorUserId, patch: payload });
    if (!updated) throw new AppError(404, 'Template not found');
    
    if (payload.isDefault === true) {
      await repo.unsetOtherDefaults(client, { orgId, exceptTemplateId: updated.id });
    }
    
    if (payload.layoutConfig || payload.brandingConfig || payload.fieldConfig) {
      await repo.createVersion(client, {
        templateId,
        actorUserId,
        layoutConfig: payload.layoutConfig || before.layout_config || {},
        brandingConfig: payload.brandingConfig || before.branding_config || {},
        fieldConfig: payload.fieldConfig || before.field_config || {},
        status: 'published',
        isPublished: true
      });
    }
    
    return repo.getTemplateById({ orgId, templateId });
  });
  
  if (out && out.id) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: 'document_template.updated',
      entityType: 'document_template',
      entityId: out.id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      before,
      after: out
    });
  }
  
  return out;
}

async function createTemplateVersion({ orgId, actorUserId, templateId, payload, audit = {} }) {
  const template = await getTemplate({ orgId, templateId });
  
  const version = await withTransaction(async (client) => {
    await repo.createVersion(client, {
      templateId,
      actorUserId,
      layoutConfig: payload.layoutConfig || template.layout_config || {},
      brandingConfig: payload.brandingConfig || template.branding_config || {},
      fieldConfig: payload.fieldConfig || template.field_config || {},
      status: payload.status || 'published',
      isPublished: payload.isPublished !== false
    });
    
    return repo.getTemplateById({ orgId, templateId });
  });
  
  if (version && version.id) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: 'document_template.version_created',
      entityType: 'document_template',
      entityId: templateId,
      ip: audit.ip,
      userAgent: audit.userAgent,
      after: version
    });
  }
  
  return version;
}

async function listAssignments({ orgId }) {
  await ensurePresetLibrary({ orgId });
  return repo.listAssignments({ orgId });
}

async function upsertAssignment({ orgId, actorUserId, payload, audit = {} }) {
  await ensurePresetLibrary({ orgId, actorUserId });
  
  if (!SUPPORTED_TRANSACTION_ENTITY_TYPES.includes(payload.entityType)) {
    throw new AppError(400, 'Unsupported entity type for document template assignment');
  }
  
  const template = await repo.getTemplateById({ orgId, templateId: payload.templateId });
  if (!template) throw new AppError(400, 'Invalid templateId');

  const beforeList = await repo.listAssignments({ orgId });
  const before = beforeList.find((r) => r.entity_type === payload.entityType) || null;

  const out = await withTransaction(async (client) => {
    return repo.upsertAssignment(client, {
      orgId,
      actorUserId,
      ...payload
    });
  });

  if (out && out.id) {
    await writeAudit({
      organizationId: orgId,
      actorUserId,
      action: 'document_template.assignment_upserted',
      entityType: 'document_template_assignment',
      entityId: out.id,
      ip: audit.ip,
      userAgent: audit.userAgent,
      before,
      after: out
    });
  }
  
  return out;
}

module.exports = {
  ensurePresetLibrary,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  createTemplateVersion,
  listAssignments,
  upsertAssignment,
  listSupportedDocumentTypes
};