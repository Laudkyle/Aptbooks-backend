/**
 * Remove client-calculated monetary tax fields before statutory tax resolution.
 *
 * The client may preview these values, but transaction creation must derive
 * taxable bases and tax amounts from quantity/unit price, tax codes/rules, and
 * server-side configuration. Rate/category selections remain intact.
 */
function stripClientCalculatedTaxAmounts(line = {}) {
  const {
    taxAmount: _taxAmount,
    taxableAmount: _taxableAmount,
    lineTotal: _lineTotal,
    ...rest
  } = line || {};

  if (Array.isArray(rest.taxes)) {
    rest.taxes = rest.taxes.map((selection = {}) => {
      const {
        taxAmount: _selectionTaxAmount,
        taxableAmount: _selectionTaxableAmount,
        ...selectionRest
      } = selection;
      return selectionRest;
    });
  }

  return rest;
}

module.exports = { stripClientCalculatedTaxAmounts };
