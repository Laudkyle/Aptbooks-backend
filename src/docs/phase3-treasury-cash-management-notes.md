
Phase 3 backend implementation added on top of the existing banking layer.

Included modules
- payment runs
- bank transfers
- payment approval batches
- cheque management
- cash forecasting
- treasury dashboard

Implementation notes
- The new treasury layer reuses existing bank accounts, accounting periods, and Tier 1 journal posting interfaces.
- Payment runs execute into journals by debiting each line offset account and crediting the selected bank account GL.
- Bank transfers post by debiting the destination bank GL and crediting the source bank GL. Optional fees debit a fee account and increase the source-bank credit.
- Approval batches can approve both payment runs and bank transfers together.
- Cheques support available, issued, cleared, voided, and bounced lifecycle states. Standalone cheque issue can optionally post a journal.
- Cash forecasting is operational and additive: it starts from current bank transaction balances and layers in approved/submitted runs, transfers, and issued cheques.
- Treasury dashboard returns balances, pending workloads, liquidity needs, and a 30-day forecast.

Limitations
- Payment approval batches intentionally group only treasury-native items created in this phase: payment runs and bank transfers.
- Cheque clearing and bounce currently update treasury state only; they do not create reversal journals automatically.
- Forecasting is short-horizon operational liquidity forecasting, not a replacement for your existing reporting/forecast module.
