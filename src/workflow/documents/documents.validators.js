const { z } = require("zod");

const uuid = z.string().uuid();

const createDocumentSchema = z.object({
  document_type_id: uuid.optional(),
  title: z.string().min(1).max(240),
  description: z.string().max(5000).optional(),
  entity_type: z.string().min(1).max(80),
  entity_id: uuid,
  entity_ref: z.string().max(120).optional(),
});

const listDocumentsQuerySchema = z.object({
  entity_type: z.string().min(1).max(80).optional(),
  entity_id: uuid.optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const submitDocumentSchema = z.object({
  comment: z.string().max(2000).optional(),
});

const approvalActionSchema = z.object({
  comment: z.string().max(2000).optional(),
});

const createDocumentTypeSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  is_active: z.boolean().optional(),
});

const createApprovalLevelSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(120),
  sequence: z.coerce.number().int().min(1).max(50),
  is_active: z.boolean().optional(),
});

const setDocumentTypeApprovalLevelsSchema = z.object({
  approval_level_ids: z.array(uuid).min(1).max(50),
});

const setApprovalLevelUsersSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(0),
});

module.exports = {
  createDocumentSchema,
  listDocumentsQuerySchema,
  submitDocumentSchema,
  approvalActionSchema,
  createDocumentTypeSchema,
  createApprovalLevelSchema,
  setDocumentTypeApprovalLevelsSchema,
  setApprovalLevelUsersSchema,
};
