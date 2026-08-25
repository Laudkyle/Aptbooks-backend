const { z } = require('zod');

const uuid = z.string().uuid();
const code = z.string().trim().min(1).max(60);
const name = z.string().trim().min(1).max(200);
const nonnegative = z.coerce.number().finite().nonnegative();
const positiveQty = z.coerce.number().finite().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const createUnitSchema = z.object({
  code, name,
  symbol: z.string().trim().max(20).optional().nullable(),
  decimalPlaces: z.coerce.number().int().min(0).max(6).optional().default(2),
});

const createInventoryCategorySchema = z.object({
  code, name,
  inventoryAccountId: uuid, cogsAccountId: uuid, adjustmentAccountId: uuid, clearingAccountId: uuid,
  parentId: uuid.optional().nullable(),
});
const updateInventoryCategorySchema = createInventoryCategorySchema.partial().extend({
  status: z.enum(['active','inactive']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const createInventoryItemSchema = z.object({
  categoryId: uuid, unitId: uuid, taxProfileId: uuid.optional().nullable(),
  sku: code, name,
  barcode: z.string().trim().max(120).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  reorderPoint: nonnegative.optional().default(0),
  reorderQty: nonnegative.optional().default(0),
  trackingMethod: z.enum(['none','batch','serial']).optional().default('none'),
  preferredWarehouseId: uuid.optional().nullable(),
});
const updateInventoryItemSchema = createInventoryItemSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const createWarehouseSchema = z.object({ code, name, isActive: z.boolean().optional().default(true) });
const updateWarehouseSchema = createWarehouseSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const createBinSchema = z.object({
  warehouseId: uuid, code, name,
  isDefault: z.boolean().optional().default(false),
});
const updateBinSchema = z.object({
  warehouseId: uuid.optional(), code: code.optional(), name: name.optional(),
  status: z.enum(['active','inactive']).optional(), isDefault: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const transactionLineSchema = z.object({
  itemId: uuid, quantity: positiveQty,
  unitCost: nonnegative.optional().nullable(),
  direction: z.enum(['increase','decrease']).optional().nullable(),
});
const createInventoryTransactionSchema = z.object({
  periodId: uuid, txnDate: isoDate,
  txnType: z.enum(['receipt','issue','transfer','adjustment']),
  sourceWarehouseId: uuid.optional().nullable(), destWarehouseId: uuid.optional().nullable(),
  reference: z.string().trim().max(120).optional().nullable(), memo: z.string().trim().max(500).optional().nullable(),
  idempotencyKey: z.string().trim().max(200).optional().nullable(),
  lines: z.array(transactionLineSchema).min(1).max(1000),
}).superRefine((value, ctx) => {
  if (value.txnType === 'receipt' && !value.destWarehouseId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['destWarehouseId'], message: 'Destination warehouse is required' });
  if (['issue','adjustment'].includes(value.txnType) && !value.sourceWarehouseId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceWarehouseId'], message: 'Source warehouse is required' });
  if (value.txnType === 'transfer') {
    if (!value.sourceWarehouseId || !value.destWarehouseId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceWarehouseId'], message: 'Source and destination warehouses are required' });
    if (value.sourceWarehouseId && value.sourceWarehouseId === value.destWarehouseId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['destWarehouseId'], message: 'Destination must differ from source' });
  }
  value.lines.forEach((line, index) => {
    if (value.txnType === 'receipt' && line.unitCost == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', index, 'unitCost'], message: 'Receipt unit cost is required' });
    if (value.txnType === 'adjustment' && !line.direction) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', index, 'direction'], message: 'Adjustment direction is required' });
  });
});

module.exports = {
  createUnitSchema, createInventoryCategorySchema, updateInventoryCategorySchema,
  createInventoryItemSchema, updateInventoryItemSchema, createWarehouseSchema, updateWarehouseSchema,
  createBinSchema, updateBinSchema, createInventoryTransactionSchema,
};
