const { z } = require("zod");

const setCreditPolicySchema = z.object({
  creditLimit: z.coerce.number().min(0).optional(),
  creditDays: z.coerce.number().int().min(0).optional(),
  holdIfOver: z.coerce.boolean().optional(),
  notes: z.string().max(2000).nullable().optional()
});

module.exports = { setCreditPolicySchema };
