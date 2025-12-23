const { z } = require("zod");

const partnerType = z.enum(["customer", "vendor"]);

const createPartnerSchema = z.object({
  type: partnerType,
  name: z.string().min(2),
  code: z.string().min(1).max(40).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(30).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  defaultReceivableAccountId: z.string().uuid().optional(),
  defaultPayableAccountId: z.string().uuid().optional(),
  paymentTermsId: z.string().uuid().optional(),
  notes: z.string().max(5000).optional()
});

const updatePartnerSchema = createPartnerSchema.partial();

const createContactSchema = z.object({
  name: z.string().min(2).max(200),
  email: z.string().email().optional(),
  phone: z.string().min(7).max(30).optional(),
  role: z.string().max(120).optional(),
  isPrimary: z.boolean().optional()
});

const updateContactSchema = createContactSchema.partial();

const createAddressSchema = z.object({
  label: z.string().max(60).optional(),
  line1: z.string().min(2).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(40).optional(),
  country: z.string().max(120).optional(),
  isPrimary: z.boolean().optional()
});

const updateAddressSchema = createAddressSchema.partial();

const listPartnersQuerySchema = z.object({
  type: partnerType.optional(),
  status: z.enum(["active", "inactive"]).optional()
});

module.exports = {
  createPartnerSchema,
  updatePartnerSchema,
  createContactSchema,
  updateContactSchema,
  createAddressSchema,
  updateAddressSchema,
  listPartnersQuerySchema
};
