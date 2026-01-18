const { z } = require("zod");

const createPaystackIntentSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(3).max(3).default("GHS"),
  customerEmail: z.string().email(),
  callbackUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
  links: z.array(z.object({ entityType: z.string(), entityId: z.number() })).optional()
});

const createMtnRequestToPaySchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(3).max(3).default("EUR"),
  phoneNumber: z.string().min(8),
  payerMessage: z.string().max(140).optional(),
  payeeNote: z.string().max(140).optional(),
  externalId: z.string().max(64).optional(),
  metadata: z.record(z.any()).optional(),
  links: z.array(z.object({ entityType: z.string(), entityId: z.number() })).optional()
});

module.exports = {
  createPaystackIntentSchema,
  createMtnRequestToPaySchema
};
