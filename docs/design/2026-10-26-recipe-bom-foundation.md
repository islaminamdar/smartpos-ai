# Recipe/BOM inventory foundation

The recipe module uses branch-local, immutable recipe versions. Each version names a sellable POS product, its output quantity and the exact stock-item quantities required. The manager can publish a replacement version; past versions remain available for future audit and eventual consumption snapshots.

This foundation deliberately **does not deduct inventory from sales**. Existing bills, refunds, kitchen events, tax documents and stock balances remain untouched. Sale deduction needs a separate commissioned rollout that snapshots the chosen recipe version and is proven against shift, return and offline reconciliation paths. Recipes cannot reference a paused or another-branch stock item. Piece ingredients must use whole units.

`pos_recipes(branch)` lists the latest recipe per product for a manager. `pos_manage_recipe(command,binding)` publishes an immutable replacement and records both an idempotent command and an audit event. It shares the existing manager/device binding gate with stock control.

The migration has no supplier, purchase price, cost, valuation or margin data. Those require an approved receiving and cost-accounting design rather than inferred values from manually recorded stock.
