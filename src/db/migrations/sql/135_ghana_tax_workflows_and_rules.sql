BEGIN;

UPDATE tax_country_packs
SET metadata = jsonb_set(
  jsonb_set(
    metadata,
    '{taxRules}',
    COALESCE(metadata->'taxRules', '[]'::jsonb) || '[
      {"code":"GH_RULE_ZERO_RATED_EXPORTS","name":"Ghana zero-rated export supplies","taxCode":"GH_VAT_ZERO_0","documentType":"invoice","transactionScope":"sales","supplyType":"export","partnerType":"customer","status":"active"},
      {"code":"GH_RULE_EXEMPT_SUPPLIES","name":"Ghana exempt supplies","taxCode":"GH_VAT_EXEMPT_0","documentType":"invoice","transactionScope":"sales","supplyType":"services","partnerType":"customer","status":"active"},
      {"code":"GH_RULE_CST_TELECOM","name":"Ghana Communications Service Tax on telecom services","taxCode":"GH_CST_5","documentType":"invoice","transactionScope":"sales","supplyType":"services","partnerType":"customer","conditions":{"industry":"telecom"},"status":"active"},
      {"code":"GH_RULE_TOURISM_LEVY","name":"Ghana Tourism Levy on applicable tourism services","taxCode":"GH_TOURISM_LEVY_1","documentType":"invoice","transactionScope":"sales","supplyType":"services","partnerType":"customer","conditions":{"industry":"tourism"},"status":"active"},
      {"code":"GH_RULE_WHT_RENT","name":"Ghana withholding tax on rent","taxCode":"GH_WHT_RENT_NONRES_15","documentType":"bill","transactionScope":"purchases","supplyType":"services","partnerType":"vendor","conditions":{"category":"rent"},"status":"active"},
      {"code":"GH_RULE_WHT_NONRES_SERVICES","name":"Ghana non-resident withholding on services","taxCode":"GH_WHT_NONRES_GOODS_WORKS_SERVICES_20","documentType":"bill","transactionScope":"purchases","supplyType":"services","partnerType":"vendor","conditions":{"residency":"non_resident"},"status":"active"},
      {"code":"GH_RULE_IMPORT_DUTY_CONFIG","name":"Ghana import duty configurable rule","taxCode":"GH_IMPORT_DUTY_CONFIG","documentType":"bill","transactionScope":"purchases","supplyType":"import","partnerType":"vendor","status":"active"},
      {"code":"GH_RULE_EXCISE_CONFIG","name":"Ghana excise duty configurable rule","taxCode":"GH_EXCISE_CONFIG","documentType":"invoice","transactionScope":"sales","supplyType":"goods","partnerType":"customer","conditions":{"requiresProductExciseSetup":true},"status":"active"}
    ]'::jsonb
  ),
  '{workflows}',
  '[
    {"code":"GH_VAT_SETUP","title":"Set up Ghana VAT/NHIL/GETFund","steps":["Install Ghana country pack","Map output and input tax accounts","Add GRA VAT registration","Use GH_VAT_EFFECTIVE_20 for standard taxable supplies","Review VAT/NHIL/GETFund return monthly"]},
    {"code":"GH_WHT_SETUP","title":"Set up Ghana withholding tax","steps":["Map withholding payable and receivable accounts","Assign vendor tax profiles and WHT codes","Review withholding open items","Create, approve and post withholding remittances","Issue or record withholding certificates"]},
    {"code":"GH_SPECIAL_TAX_SETUP","title":"Configure special Ghana taxes","steps":["Review configurable excise/import/stamp/mineral royalty tax codes","Replace placeholder rates with product, tariff, instrument, or sector-specific rates","Attach rules only to applicable transactions","Review diagnostics before filing"]}
  ]'::jsonb
)
WHERE pack_code = 'GH-TAX-2026-COMPLETE' AND organization_id IS NULL;

COMMIT;
