
const { z } = require("../../../shared/validators/common.validators");
const { SUPPORTED_TRANSACTION_ENTITY_TYPES } = require("./constants");

const jsonObj = z.record(z.string(), z.unknown()).default({});

const createTemplateSchema = z.object({
  code: z.string().min(2).max(50),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional().nullable(),
  baseTemplateKey: z.enum(["classic", "modern", "compact", "corporate"]),
  paperSize: z.enum(["A4", "Letter"]).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
  isDefault: z.boolean().optional(),
  layoutConfig: jsonObj.optional(),
  brandingConfig: jsonObj.optional(),
  fieldConfig: jsonObj.optional()
});

const updateTemplateSchema = createTemplateSchema.partial();

const createTemplateVersionSchema = z.object({
  layoutConfig: jsonObj.optional(),
  brandingConfig: jsonObj.optional(),
  fieldConfig: jsonObj.optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  isPublished: z.boolean().optional()
});

const upsertAssignmentSchema = z.object({
  entityType: z.enum(SUPPORTED_TRANSACTION_ENTITY_TYPES),
  templateId: z.string().uuid(),
  templateVersionId: z.string().uuid().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional()
});

const previewSampleSchema = z.object({
  entityType: z.enum(SUPPORTED_TRANSACTION_ENTITY_TYPES),
  templateId: z.string().uuid().optional(),
  templateVersionId: z.string().uuid().optional()
});

module.exports = {
  createTemplateSchema,
  updateTemplateSchema,
  createTemplateVersionSchema,
  upsertAssignmentSchema,
  previewSampleSchema
};
