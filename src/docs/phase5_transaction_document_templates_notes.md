
# Phase: Transaction document templates and print rendering

Implemented backend foundation for transaction document templates with the recommended production-safe approach:

- preset template library (Classic, Modern, Compact, Corporate)
- per-document-type assignment model
- template versioning
- centralized render pipeline
- sample preview and real document render endpoints
- render audit logging

Routes added:
- `GET /modules/printing/templates`
- `POST /modules/printing/templates/bootstrap-presets`
- `GET /modules/printing/templates/supported-document-types`
- `GET /modules/printing/templates/assignments`
- `POST /modules/printing/templates/assignments`
- `POST /modules/printing/templates`
- `PUT /modules/printing/templates/:id`
- `POST /modules/printing/templates/:id/versions`
- `GET /modules/printing/render/sample/:entityType`
- `GET /modules/printing/render/:entityType/:documentId`

Supported transaction entity types:
- invoice
- bill
- receipt
- payment_out
- credit_note
- debit_note
- quotation
- sales_order
- purchase_requisition
- purchase_order
- goods_receipt
- expense
- petty_cash
- advance
- return
- refund

Notes:
- Rendering currently returns HTML with template metadata and payload for preview/print orchestration.
- The backend decides the resolved template; the frontend should only preview/print the returned render artifact.
- PDF generation was intentionally not hardwired here so you can choose browser print, headless PDF, or storage/export later without changing the template model.
