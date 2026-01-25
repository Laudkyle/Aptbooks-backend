const { z } = require("zod"); 

const uuid = z.string().uuid(); 

// -----------------
// Authorities
// -----------------

const authorityIdParam = z.object({
  authorityId: uuid,
}); 

const createAuthority = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  country_code: z.string().min(2).max(2).optional(), // ISO-3166-1 alpha-2
  status: z.enum(["active", "inactive"]).optional().default("active"),
}); 

const updateAuthority = z
  .object({
    authorityId: uuid,
    name: z.string().min(1).max(200).optional(),
    country_code: z.string().min(2).max(2).optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "authorityId"), {
    message: "At least one field must be provided",
  }); 

// -----------------
// Rate sets + lines
// -----------------

const rateSetIdParam = z.object({
  rateSetId: uuid,
}); 

const createRateSet = z.object({
  authority_id: uuid,
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  status: z.enum(["active", "inactive"]).optional().default("active"),
}); 

const addRateLine = z.object({
  rateSetId: uuid,
  effective_from: z.coerce.date(),
  effective_to: z.coerce.date().optional().nullable(),
  rate: z.number().min(0).max(1), // e.g. 0.25 for 25%
}); 

// -----------------
// Settings
// -----------------

const upsertSettings = z.object({
  default_authority_id: uuid.optional().nullable(),
  default_rate_set_id: uuid.optional().nullable(),

  // These are required for Phase 4 postings, but we store them early.
  deferred_tax_asset_account_id: uuid.optional().nullable(),
  deferred_tax_liability_account_id: uuid.optional().nullable(),
  deferred_tax_expense_account_id: uuid.optional().nullable(),

  rounding_decimals: z.number().int().min(0).max(6).optional(),
}); 

// -----------------
// Temp difference categories
// -----------------

const createTempDifferenceCategory = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  status: z.enum(["active", "inactive"]).optional().default("active"),
}); 

const categoryIdParam = z.object({
  categoryId: uuid,
}); 

// -----------------
// Temporary differences
// -----------------

const periodIdQuery = z.object({
  period_id: uuid,
}); 

const tempDifferenceIdParam = z.object({
  tempDifferenceId: uuid,
}); 

const createTempDifference = z.object({
  period_id: uuid,
  category_id: uuid,
  source_type: z.string().max(60).optional().nullable(),
  source_id: uuid.optional().nullable(),
  diff_type: z.enum(["DEDUCTIBLE", "TAXABLE"]),
  carrying_amount: z.number(),
  tax_base: z.number(),
  recognisable: z.boolean().optional().default(true),
  notes: z.string().max(1000).optional().nullable(),
}); 

const updateTempDifference = z
  .object({
    tempDifferenceId: uuid,
    category_id: uuid.optional(),
    source_type: z.string().max(60).optional().nullable(),
    source_id: uuid.optional().nullable(),
    diff_type: z.enum(["DEDUCTIBLE", "TAXABLE"]).optional(),
    carrying_amount: z.number().optional(),
    tax_base: z.number().optional(),
    recognisable: z.boolean().optional(),
    notes: z.string().max(1000).optional().nullable(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "tempDifferenceId"), {
    message: "At least one field must be provided",
  }); 


// -----------------
// Imports / copy-forward / reports
// -----------------

const importTempDifferences = z.object({
  period_id: uuid,
  source: z.string().max(60).optional().default("manual_import"),
  filename: z.string().max(200).optional().nullable(),
  rows: z.array(
    z.object({
      category_id: uuid.optional().nullable(),
      category_code: z.string().max(50).optional().nullable(),
      source_type: z.string().max(60).optional().nullable(),
      source_id: uuid.optional().nullable(),
      diff_type: z.enum(["DEDUCTIBLE", "TAXABLE"]),
      carrying_amount: z.number(),
      tax_base: z.number(),
      recognisable: z.boolean().optional().default(true),
      notes: z.string().max(1000).optional().nullable(),
    })
  ).min(1),
}); 

const copyForwardTempDifferences = z.object({
  from_period_id: uuid,
  to_period_id: uuid,
  overwrite: z.boolean().optional().default(false),
}); 

// -----------------
// Deferred tax compute/post
// -----------------

const computeDeferredTax = z.object({
  period_id: uuid,
  rate_set_id: uuid.optional().nullable(),
  memo: z.string().max(300).optional().nullable(),
}); 

const runIdParam = z.object({
  runId: uuid,
}); 

const postDeferredTax = z.object({
  period_id: uuid,
  run_id: uuid.optional().nullable(),
  memo: z.string().max(300).optional().nullable(),
}); 

const reverseDeferredTax = z.object({
  period_id: uuid,
  target_period_id: uuid.optional().nullable(),
  entry_date: z.coerce.date().optional().nullable(),
  reason: z.string().min(3).max(500).optional().nullable(),
}); 

module.exports = {
  authorityIdParam,
  createAuthority,
  updateAuthority,
  rateSetIdParam,
  createRateSet,
  addRateLine,
  upsertSettings,
  createTempDifferenceCategory,
  categoryIdParam,
  periodIdQuery,
  tempDifferenceIdParam,
  createTempDifference,
  updateTempDifference,
  computeDeferredTax,
  runIdParam,
  postDeferredTax,
  reverseDeferredTax,
  importTempDifferences,
  copyForwardTempDifferences,
}; 
