# Manager stock guide — candidate

This describes the stock workflow in the release candidate. It is not yet available in the live restaurant pilot.

## Set up and count

Open **Stock** on a registered branch counter using a manager or owner account. Choose **Add stock item**, enter its name, optional stock code, unit and reorder level, and give a reason. Choose the unit carefully: an existing item's unit cannot change. Kilograms and litres allow three decimal places; pieces must be whole numbers.

A new item shows **Not counted**. Select it and record a **Physical count** before receiving or removing stock. Enter the quantity actually counted, including zero when the item is absent. The first count establishes a balance without inventing a prior quantity or delivery.

## Record changes

- **Receive** adds a positive quantity. Use a delivery reference when available.
- **Waste** removes a positive quantity and requires a reason.
- **Physical count** replaces the recorded balance with the quantity actually counted. Later counts preserve the difference in history.
- **Adjustment** adds a positive change or subtracts a negative change, with a reason.

Review the item, unit and amount before saving. Negative resulting balances are rejected. If another manager changed the item, refresh and review the latest balance before making a new request. Inactive items remain in history and cannot receive movements until a manager reactivates them.

## Recover interrupted work

The browser saves the exact request before sending it. If confirmation is lost, keep browser data and use **Check saved request**. A missing result is not permission to enter the same movement again. Retry the exact saved request, or explicitly cancel it if it has not applied. Cancellation may instead recover the original result when the server already saved it; it does not reverse a saved movement.

Saved stock work remains discoverable for its original signed-in account even when current branch access is unavailable. It still needs the original browser's counter binding. If browser storage or its coordination capability is unavailable, new writes pause. Do not clear stored work to bypass that pause.

## Read the figures

Low stock means an active, counted item is at or below its reorder level. Unknown balances are shown separately. History records who changed stock, the counter, reason, reference and exact quantity. Historical confirmation describes the original request; refresh to see the current balance.

These figures reflect recorded stock movements only. Sales do not automatically deduct ingredients, and stock changes do not change menu availability. Recipes, purchase orders, supplier balances, costs, expiry batches and branch transfers remain pending. No financial bill or payment is created by a stock movement.
