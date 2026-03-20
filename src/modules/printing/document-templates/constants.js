
const { listDocumentables } = require("../../../workflow/documents/documentable.registry");

const PRESET_TEMPLATE_LIBRARY = [
  {
    code: "TX_CLASSIC",
    name: "Classic",
    description: "Balanced classic transaction document with signature area and full header.",
    baseTemplateKey: "classic",
    isDefault: true,
    paperSize: "A4",
    orientation: "portrait",
    brandingConfig: { accentColor: "#0f172a", showLogo: true, showSignatureBlock: true, showPaymentInstructions: true },
    layoutConfig: { headerStyle: "stacked", density: "comfortable", showWatermark: false },
    fieldConfig: { showReference: true, showWorkflowStatus: true, showCurrencyCode: true }
  },
  {
    code: "TX_MODERN",
    name: "Modern",
    description: "Modern business document with card totals and strong accent treatment.",
    baseTemplateKey: "modern",
    isDefault: false,
    paperSize: "A4",
    orientation: "portrait",
    brandingConfig: { accentColor: "#2563eb", showLogo: true, showSignatureBlock: false, showPaymentInstructions: true },
    layoutConfig: { headerStyle: "split", density: "comfortable", showWatermark: false },
    fieldConfig: { showReference: true, showWorkflowStatus: true, showCurrencyCode: true }
  },
  {
    code: "TX_COMPACT",
    name: "Compact",
    description: "Space-efficient template for fast internal printing and receipts.",
    baseTemplateKey: "compact",
    isDefault: false,
    paperSize: "A4",
    orientation: "portrait",
    brandingConfig: { accentColor: "#334155", showLogo: true, showSignatureBlock: false, showPaymentInstructions: false },
    layoutConfig: { headerStyle: "compact", density: "tight", showWatermark: false },
    fieldConfig: { showReference: true, showWorkflowStatus: false, showCurrencyCode: true }
  },
  {
    code: "TX_CORPORATE",
    name: "Corporate",
    description: "Formal enterprise-style template suitable for procurement and settlement documents.",
    baseTemplateKey: "corporate",
    isDefault: false,
    paperSize: "A4",
    orientation: "portrait",
    brandingConfig: { accentColor: "#111827", showLogo: true, showSignatureBlock: true, showPaymentInstructions: true },
    layoutConfig: { headerStyle: "formal", density: "comfortable", showWatermark: false },
    fieldConfig: { showReference: true, showWorkflowStatus: true, showCurrencyCode: true }
  }
];

const SUPPORTED_TRANSACTION_ENTITY_TYPES = [
  "invoice",
  "bill",
  "receipt",
  "payment_out",
  "credit_note",
  "debit_note",
  "quotation",
  "sales_order",
  "purchase_requisition",
  "purchase_order",
  "goods_receipt",
  "expense",
  "petty_cash",
  "advance",
  "return",
  "refund"
];

function listSupportedDocumentTypes() {
  const known = new Set(listDocumentables());
  return SUPPORTED_TRANSACTION_ENTITY_TYPES
    .filter((t) => known.has(t))
    .map((entityType) => ({ entityType }));
}

module.exports = {
  PRESET_TEMPLATE_LIBRARY,
  SUPPORTED_TRANSACTION_ENTITY_TYPES,
  listSupportedDocumentTypes
};
