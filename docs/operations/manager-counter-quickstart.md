# Bur Dubai counter quick start

For the online pilot at [pos.internext.info/counter](https://pos.internext.info/counter).

## First use on the restaurant device

1. Open the staff counter link and sign in using the manager account provided separately. Keep the password private.
2. Confirm that the branch reads **Bur Dubai**. Enter a clear counter name, such as **Front counter**, and select **Register this counter**. Register each physical cashier device separately.
3. Open **Shift**. Count the money actually in the drawer, enter that opening cash amount and select **Open shift**.
4. Review the menu prices before taking orders. The opening prices came from the approved archived menu; 30 unpriced items remain unavailable. A named weight pack is not automatically a price per kilogram.

## Record a sale

1. Under **Sell**, choose the order type and add the customer's items. Check quantities and the total.
2. For items explicitly priced by kilogram, enter the actual weight in grams. Use the restaurant's verified scale reading.
3. If an offer applies, select **Check offers**, enter a coupon if needed, and choose one eligible offer. Check the displayed discount and final total. Changing items, quantities, order type or coupon clears the selection; check it again.
4. Enter the cash received and/or the card amount. Recording a card payment here does not charge the customer's card; confirm payment separately on the card terminal.
5. Select **Save sale** and wait for confirmation. If confirmation is interrupted, use the saved-request recovery controls. Do not create another bill for the same payment until its status is resolved.
6. Open the confirmed receipt under **Receipts** and choose **Print / save PDF**. Check the actual paper output; a browser print dialog does not confirm delivery to a physical printer.

## Update the menu

In **Menu**, a manager can add an item or edit its price, unit and availability. Enter a reason and wait for the saved confirmation. For weight sales, enter the full kilogram price. Keep an item unavailable until its price is approved. Cashiers must refresh an older basket when its menu details change; issued bills retain their original details.

## Set up offers

In **Offers**, a manager can create or edit a percentage discount, fixed AED discount, exact-item bundle, or buy-X-get-Y offer. Choose its items/categories, order types, minimum spend, coupon and any manager restriction. Date and weekly time windows use Dubai time; an overnight window belongs to its starting weekday. Enter a reason and wait for confirmation before leaving. An interrupted save keeps the same request for retry.

Only one offer applies per order. For buy-X-get-Y, add all paid and reward items to the basket; the cheapest eligible whole pieces or packs become free. Bundles require every specified item, and extra quantities stay at normal price. Weight items support percentage and fixed discounts; bundles and buy-X-get-Y use whole pieces/packs. Completely free orders and per-customer limits are not supported yet.

The usage limit counts completed orders, not the number of bundles. Editing, disabling or fully refunding an offer does not restore its previous uses. The server checks current prices, rules, schedule and remaining uses again when saving the sale. If that check fails after money was collected, resolve the saved request and reconcile the payment before creating a replacement. Issued receipts and credit notes retain the original offer and discounted amounts.

## Review branch reports

A manager can open **Reports**, choose an inclusive date range (up to 93 days) and select **Load report**. Dates use Dubai time. Sales and credit notes are counted on their issue dates, so a refund today for yesterday's bill reduces today's figures. Review sales, refunds, VAT, recorded cash/card payments and product totals; use **Export CSV** for the same selected range. Cash figures exclude opening float, change and drawer movements. Card figures do not confirm bank settlement. If a report fails to load, its totals are unavailable, not zero.

## Manage staff access

Open **Staff** to review cashiers assigned to this branch. Select a staff member, make the permitted changes, enter a reason and wait for **Staff access saved**. A branch manager cannot promote someone to manager or change an owner's access. Close the affected person's open shifts before disabling them or changing their role/branch. A name-only change can be made while their shift is open.

**Invite staff member** currently works for an existing account whose email is already verified. The invitation grants branch access only after that person signs in with the matching account. Creating or copying a link does not send an email, create an account or reset a password. New-account verification and forgotten-password email delivery still need setup. Keep the link private; revoke an unused invitation when it is no longer needed.

If a staff change has no confirmation, retry its saved request or use **Check saved change** after acknowledging the cancellation explanation. The check returns the original result if saved; otherwise an authorized manager can permanently cancel that original request. Do not clear browser storage to bypass an uncertain change. After access is restored and a replacement counter is registered, the same account can recover its earlier staff change.

## Change your own password

Finish saved requests and close your shifts first, then open **Account**. Enter your current password and the new password twice. Use 12–72 characters (at most 72 UTF-8 bytes). After confirmation, sign in again with the new password. If the screen says the password changed but signing out other sessions was not confirmed, the **new** password applies; do not resubmit the old password. Managers cannot see or reset someone else's password here.

## Recover work after access changes

Keep the original browser data. If branch access is unavailable, the counter's **Saved counter work** section can check your own earlier financial request. A disabled account can confirm a request already recorded, but cannot record a new sale or cancel an unsaved financial request. Ask the manager to restore access if further resolution is needed.

Resolve a saved financial request before re-registering the counter: new registration replaces its device proof. After a confirmed cancellation, reconcile any money already collected or returned before making a replacement request.

## End a shift

Review the shift totals, count the actual cash in the drawer, then use **Close shift**. Investigate any difference rather than changing the count to match the screen. Record authorized cash movements with their real amounts and reasons.

## Limits of the current pilot

- Real sales require an internet connection. The separate `/pos` workspace is training only and must not be used to issue customer bills.
- Do not clear browser storage while a request is waiting for confirmation.
- Issued bills preserve their original details. A refund creates a credit note; it does not erase the original invoice. The live pilot supports full returns, with a reason and confirmation.
- Android APK installation, offline live selling, automatic card charging, physical printer integration and the broader planned restaurant features are still under development.
- Subscription payments are handled separately from customer counter payments. Visiting the billing screen does not change the existing manually collected pilot arrangement.

Practice only in the training workspace or an explicitly designated test branch. Do not enter fabricated sales into the restaurant's live ledger.
