BEGIN;

ALTER TABLE tax_return_templates DROP CONSTRAINT IF EXISTS tax_return_templates_tax_type_check;
ALTER TABLE tax_return_templates
  ADD CONSTRAINT tax_return_templates_tax_type_check
  CHECK (tax_type IN ('VAT','GST','SALES','WITHHOLDING','IMPORT','OTHER'));

-- Ghana tax defaults for Aptbooks tax engine.
-- Sources reflected in metadata/source_notes:
-- - GRA VAT 2026: VAT 15%, NHIL 2.5%, GETFund 2.5%, COVID-19 levy abolished, effective combined rate 20%.
-- - GRA CST: CST 5%.
-- - GRA WHT: resident/non-resident withholding categories and rates.
-- - GRA stamp duty/customs/excise pages: product/instrument-specific rates stored as configurable placeholders.

INSERT INTO tax_country_packs(organization_id, pack_code, country_code, name, version_no, default_templates, metadata, is_active)
VALUES
  (NULL, 'GH-TAX-2026-COMPLETE', 'GH', 'Ghana Tax Defaults 2026', '2026.1.0',
   '[
      {"taxType":"VAT","code":"GH_VAT_2026","name":"Ghana VAT/NHIL/GETFund Return 2026","boxes":[
        {"boxCode":"OUTPUT_VAT","label":"Output VAT 15%","sortOrder":10,"direction":"output"},
        {"boxCode":"OUTPUT_NHIL","label":"Output NHIL 2.5%","sortOrder":20,"direction":"output"},
        {"boxCode":"OUTPUT_GETFUND","label":"Output GETFund Levy 2.5%","sortOrder":30,"direction":"output"},
        {"boxCode":"OUTPUT_CST","label":"Communications Service Tax 5%","sortOrder":40,"direction":"output"},
        {"boxCode":"OUTPUT_TOURISM","label":"Tourism Levy 1%","sortOrder":50,"direction":"output"},
        {"boxCode":"INPUT_VAT","label":"Recoverable Input VAT/NHIL/GETFund","sortOrder":60,"direction":"input"},
        {"boxCode":"ZERO_RATED","label":"Zero-rated supplies","sortOrder":70,"direction":"output"},
        {"boxCode":"EXEMPT","label":"Exempt supplies","sortOrder":80,"direction":"output"},
        {"boxCode":"NET_VAT","label":"Net VAT/levies payable or recoverable","sortOrder":90,"direction":"output"}
      ]},
      {"taxType":"WITHHOLDING","code":"GH_WHT_2026","name":"Ghana Withholding Tax Return 2026","boxes":[
        {"boxCode":"WHT_PAYABLE","label":"Withholding tax payable","sortOrder":10,"direction":"output"},
        {"boxCode":"WHT_RECEIVABLE","label":"Withholding tax certificates receivable","sortOrder":20,"direction":"input"}
      ]},
      {"taxType":"OTHER","code":"GH_OTHER_TAXES_2026","name":"Ghana Other Domestic Taxes 2026","boxes":[
        {"boxCode":"CIT_PAYABLE","label":"Corporate income tax payable","sortOrder":10,"direction":"output"},
        {"boxCode":"PAYE_PAYABLE","label":"PAYE payable","sortOrder":20,"direction":"output"},
        {"boxCode":"CST_PAYABLE","label":"CST payable","sortOrder":30,"direction":"output"},
        {"boxCode":"TOURISM_PAYABLE","label":"Tourism levy payable","sortOrder":40,"direction":"output"},
        {"boxCode":"EXCISE_PAYABLE","label":"Excise duty payable","sortOrder":50,"direction":"output"},
        {"boxCode":"STAMP_DUTY_PAYABLE","label":"Stamp duty payable","sortOrder":60,"direction":"output"},
        {"boxCode":"IMPORT_DUTY_PAYABLE","label":"Import/customs duty payable","sortOrder":70,"direction":"output"}
      ]}
    ]'::jsonb,
   '{
      "country":"Ghana",
      "currency":"GHS",
      "effectiveFrom":"2026-01-01",
      "filing":"monthly where applicable; direct taxes and sector-specific taxes depend on taxpayer registration and GRA rules",
      "sourceNotes":[
        "VAT standard rate 15%; NHIL 2.5%; GETFund Levy 2.5%; COVID-19 Health Recovery Levy abolished; effective combined VAT/levy rate 20% from 2026 reform.",
        "CST rate 5% for qualifying electronic communications service providers.",
        "WHT records include common resident and non-resident categories; verify industry-specific exemptions/treaties before filing.",
        "Excise, import duty, mineral royalties and stamp duty may be product-, instrument-, tariff-, or sector-specific; records are configurable placeholders, not final automatic assessment rules."
      ],
      "jurisdictions":[
        {"code":"GH","name":"Ghana","countryCode":"GH","levelCode":"country","isDefault":true}
      ],
      "taxCodes":[
        {"code":"GH_VAT_STD_15","name":"VAT Standard 15%","taxType":"VAT","rate":"15.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"both","boxCode":"OUTPUT_VAT","reportingGroup":"VAT","effectiveFrom":"2026-01-01"},
        {"code":"GH_NHIL_2_5","name":"National Health Insurance Levy 2.5%","taxType":"VAT","rate":"2.500000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"both","boxCode":"OUTPUT_NHIL","reportingGroup":"VAT_LEVY","effectiveFrom":"2026-01-01"},
        {"code":"GH_GETFUND_2_5","name":"GETFund Levy 2.5%","taxType":"VAT","rate":"2.500000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"both","boxCode":"OUTPUT_GETFUND","reportingGroup":"VAT_LEVY","effectiveFrom":"2026-01-01"},
        {"code":"GH_VAT_EFFECTIVE_20","name":"VAT + NHIL + GETFund Effective 20%","taxType":"VAT","rate":"20.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"both","boxCode":"OUTPUT_VAT","reportingGroup":"VAT_COMPOSITE","effectiveFrom":"2026-01-01","isCompound":true,"components":["GH_VAT_STD_15","GH_NHIL_2_5","GH_GETFUND_2_5"]},
        {"code":"GH_VAT_ZERO_0","name":"VAT Zero-rated Supply 0%","taxType":"VAT","rate":"0.000000","taxScope":"zero_rated","applicationScope":"sales","calculationMethod":"standard","direction":"output","boxCode":"ZERO_RATED","reportingGroup":"VAT_ZERO","effectiveFrom":"2026-01-01"},
        {"code":"GH_VAT_EXEMPT_0","name":"VAT Exempt Supply 0%","taxType":"VAT","rate":"0.000000","taxScope":"exempt","applicationScope":"both","calculationMethod":"standard","direction":"both","boxCode":"EXEMPT","reportingGroup":"VAT_EXEMPT","effectiveFrom":"2026-01-01"},
        {"code":"GH_VAT_IMPORT_20","name":"VAT/NHIL/GETFund on Imports 20%","taxType":"IMPORT","rate":"20.000000","taxScope":"import","applicationScope":"purchases","calculationMethod":"standard","direction":"input","boxCode":"INPUT_VAT","reportingGroup":"IMPORT_VAT","effectiveFrom":"2026-01-01"},
        {"code":"GH_CST_5","name":"Communications Service Tax 5%","taxType":"OTHER","rate":"5.000000","taxScope":"taxable","applicationScope":"sales","calculationMethod":"standard","direction":"output","boxCode":"OUTPUT_CST","reportingGroup":"CST","effectiveFrom":"2020-09-15"},
        {"code":"GH_TOURISM_LEVY_1","name":"Tourism Levy 1%","taxType":"OTHER","rate":"1.000000","taxScope":"taxable","applicationScope":"sales","calculationMethod":"standard","direction":"output","boxCode":"OUTPUT_TOURISM","reportingGroup":"TOURISM_LEVY","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_GOODS_RES_3","name":"WHT Resident Supply of Goods 3%","taxType":"WITHHOLDING","rate":"3.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_RESIDENT","effectiveFrom":"2026-01-01","thresholdAmount":"2000.00"},
        {"code":"GH_WHT_WORKS_RES_5","name":"WHT Resident Supply of Works 5%","taxType":"WITHHOLDING","rate":"5.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_RESIDENT","effectiveFrom":"2026-01-01","thresholdAmount":"2000.00"},
        {"code":"GH_WHT_SERVICES_RES_7_5","name":"WHT Resident Services 7.5%","taxType":"WITHHOLDING","rate":"7.500000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_RESIDENT","effectiveFrom":"2026-01-01","thresholdAmount":"2000.00"},
        {"code":"GH_WHT_DIVIDENDS_8","name":"WHT Dividends 8%","taxType":"WITHHOLDING","rate":"8.000000","taxScope":"withholding","applicationScope":"both","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_INVESTMENT","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_INTEREST_8","name":"WHT Interest 8%","taxType":"WITHHOLDING","rate":"8.000000","taxScope":"withholding","applicationScope":"both","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_INVESTMENT","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_RENT_RESIDENTIAL_8","name":"WHT Rent Residential 8%","taxType":"WITHHOLDING","rate":"8.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_RENT","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_RENT_NONRES_15","name":"WHT Rent Non-residential/Royalties/Natural Resources 15%","taxType":"WITHHOLDING","rate":"15.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_RENT_ROYALTY","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_DIRECTORS_20","name":"WHT Directors/Managers/Board Fees 20%","taxType":"WITHHOLDING","rate":"20.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_COMPENSATION","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_NONRES_MGT_TECH_20","name":"WHT Non-resident Management/Technical Fees 20%","taxType":"WITHHOLDING","rate":"20.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_NON_RESIDENT","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_NONRES_GOODS_WORKS_SERVICES_20","name":"WHT Non-resident Goods/Works/Services 20%","taxType":"WITHHOLDING","rate":"20.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_NON_RESIDENT","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_NONRES_TELECOM_TRANSPORT_15","name":"WHT Non-resident Telecom/Transport Business 15%","taxType":"WITHHOLDING","rate":"15.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_NON_RESIDENT","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_BRANCH_REPATRIATION_8","name":"WHT Repatriated Branch After-tax Profits 8%","taxType":"WITHHOLDING","rate":"8.000000","taxScope":"withholding","applicationScope":"both","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_NON_RESIDENT","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_INSURANCE_PREMIUMS_5","name":"WHT General Insurance Premiums 5%","taxType":"WITHHOLDING","rate":"5.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_INSURANCE","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_PETROLEUM_SUBCONTRACTOR_RES_7_5","name":"WHT Resident Petroleum Subcontractor 7.5%","taxType":"WITHHOLDING","rate":"7.500000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_PETROLEUM","effectiveFrom":"2026-01-01"},
        {"code":"GH_WHT_PETROLEUM_SUBCONTRACTOR_NONRES_15","name":"WHT Non-resident Petroleum Subcontractor 15%","taxType":"WITHHOLDING","rate":"15.000000","taxScope":"withholding","applicationScope":"purchases","calculationMethod":"withholding","direction":"withholding","boxCode":"WHT_PAYABLE","reportingGroup":"WHT_PETROLEUM","effectiveFrom":"2026-01-01"},
        {"code":"GH_CIT_STANDARD_25","name":"Corporate Income Tax Standard 25%","taxType":"OTHER","rate":"25.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"output","boxCode":"CIT_PAYABLE","reportingGroup":"CIT","effectiveFrom":"2026-01-01"},
        {"code":"GH_CIT_TAX_HOLIDAY_1","name":"Corporate Income Tax Holiday Rate 1%","taxType":"OTHER","rate":"1.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"output","boxCode":"CIT_PAYABLE","reportingGroup":"CIT","effectiveFrom":"2026-01-01"},
        {"code":"GH_PAYE_RESIDENT_TABLE","name":"PAYE Resident Graduated Rates","taxType":"OTHER","rate":"0.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"output","boxCode":"PAYE_PAYABLE","reportingGroup":"PAYE","effectiveFrom":"2026-01-01","metadata":{"calculation":"Use HR PAYE brackets/statutory rules; tax code is a filing/reporting placeholder."}},
        {"code":"GH_PIT_NONRESIDENT_25","name":"Personal Income Tax Non-resident 25%","taxType":"OTHER","rate":"25.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"output","boxCode":"PAYE_PAYABLE","reportingGroup":"PIT","effectiveFrom":"2026-01-01"},
        {"code":"GH_CAPITAL_GAINS_15","name":"Capital Gains Tax 15%","taxType":"OTHER","rate":"15.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"output","boxCode":"CIT_PAYABLE","reportingGroup":"CAPITAL_GAINS","effectiveFrom":"2026-01-01"},
        {"code":"GH_STAMP_DUTY_0_25","name":"Stamp Duty Ad Valorem Lower Band 0.25%","taxType":"OTHER","rate":"0.250000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"output","boxCode":"STAMP_DUTY_PAYABLE","reportingGroup":"STAMP_DUTY","effectiveFrom":"2026-01-01"},
        {"code":"GH_STAMP_DUTY_1","name":"Stamp Duty Ad Valorem Upper Band 1%","taxType":"OTHER","rate":"1.000000","taxScope":"taxable","applicationScope":"both","calculationMethod":"standard","direction":"output","boxCode":"STAMP_DUTY_PAYABLE","reportingGroup":"STAMP_DUTY","effectiveFrom":"2026-01-01"},
        {"code":"GH_EXCISE_CONFIG","name":"Excise Duty Product-specific","taxType":"OTHER","rate":"0.000000","taxScope":"taxable","applicationScope":"sales","calculationMethod":"standard","direction":"output","boxCode":"EXCISE_PAYABLE","reportingGroup":"EXCISE","effectiveFrom":"2026-01-01","metadata":{"calculation":"Product/tariff-specific. Configure exact rate per excisable product."}},
        {"code":"GH_IMPORT_DUTY_CONFIG","name":"Import Duty Tariff-specific","taxType":"IMPORT","rate":"0.000000","taxScope":"import","applicationScope":"purchases","calculationMethod":"standard","direction":"input","boxCode":"IMPORT_DUTY_PAYABLE","reportingGroup":"IMPORT_DUTY","effectiveFrom":"2026-01-01","metadata":{"calculation":"Customs tariff/HS-code-specific. Configure exact import duty band per item."}},
        {"code":"GH_MINERAL_ROYALTY_CONFIG","name":"Mineral Royalty Sector-specific","taxType":"OTHER","rate":"0.000000","taxScope":"taxable","applicationScope":"sales","calculationMethod":"standard","direction":"output","boxCode":"CIT_PAYABLE","reportingGroup":"MINERAL_ROYALTY","effectiveFrom":"2026-01-01","metadata":{"calculation":"Sector/license-specific; configure exact royalty terms for mining taxpayers."}}
      ],
      "taxRules":[
        {"name":"Ghana Standard VAT/NHIL/GETFund on local taxable sales","taxCode":"GH_VAT_EFFECTIVE_20","documentType":"invoice","transactionScope":"sales","supplyType":"goods","partnerType":"customer","status":"active"},
        {"name":"Ghana Standard VAT/NHIL/GETFund on local taxable services","taxCode":"GH_VAT_EFFECTIVE_20","documentType":"invoice","transactionScope":"sales","supplyType":"services","partnerType":"customer","status":"active"},
        {"name":"Ghana Import VAT/NHIL/GETFund on imports","taxCode":"GH_VAT_IMPORT_20","documentType":"bill","transactionScope":"purchases","supplyType":"goods","partnerType":"vendor","status":"active"},
        {"name":"Ghana WHT resident services on vendor bills","taxCode":"GH_WHT_SERVICES_RES_7_5","documentType":"bill","transactionScope":"purchases","supplyType":"services","partnerType":"vendor","status":"active"},
        {"name":"Ghana WHT resident goods on vendor bills","taxCode":"GH_WHT_GOODS_RES_3","documentType":"bill","transactionScope":"purchases","supplyType":"goods","partnerType":"vendor","status":"active"},
        {"name":"Ghana WHT resident works on vendor bills","taxCode":"GH_WHT_WORKS_RES_5","documentType":"bill","transactionScope":"purchases","supplyType":"mixed","partnerType":"vendor","status":"active"}
      ]
    }'::jsonb,
   TRUE)
ON CONFLICT (organization_id, pack_code) DO UPDATE SET
  name = EXCLUDED.name,
  version_no = EXCLUDED.version_no,
  default_templates = EXCLUDED.default_templates,
  metadata = EXCLUDED.metadata,
  is_active = TRUE;

COMMIT;
