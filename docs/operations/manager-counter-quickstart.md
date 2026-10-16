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
3. Enter the cash received and/or the card amount. Recording a card payment here does not charge the customer's card; confirm payment separately on the card terminal.
4. Select **Save sale** and wait for confirmation. If confirmation is interrupted, use the saved-request recovery controls. Do not create another bill for the same payment until its status is resolved.
5. Open the confirmed receipt under **Receipts** and choose **Print / save PDF**. Check the actual paper output; a browser print dialog does not confirm delivery to a physical printer.

## Update the menu

In **Menu**, a manager can add an item or edit its price, unit and availability. Enter a reason and wait for the saved confirmation. For weight sales, enter the full kilogram price. Keep an item unavailable until its price is approved. Cashiers must refresh an older basket when its menu details change; issued bills retain their original details.

## Review branch reports

A manager can open **Reports**, choose an inclusive date range (up to 93 days) and select **Load report**. Dates use Dubai time. Sales and credit notes are counted on their issue dates, so a refund today for yesterday's bill reduces today's figures. Review sales, refunds, VAT, recorded cash/card payments and product totals; use **Export CSV** for the same selected range. Cash figures exclude opening float, change and drawer movements. Card figures do not confirm bank settlement. If a report fails to load, its totals are unavailable, not zero.

## End a shift

Review the shift totals, count the actual cash in the drawer, then use **Close shift**. Investigate any difference rather than changing the count to match the screen. Record authorized cash movements with their real amounts and reasons.

## Limits of the current pilot

- Real sales require an internet connection. The separate `/pos` workspace is training only and must not be used to issue customer bills.
- Do not clear browser storage while a request is waiting for confirmation.
- Issued bills preserve their original details. A refund creates a credit note; it does not erase the original invoice. The live pilot supports full returns, with a reason and confirmation.
- Android APK installation, offline live selling, automatic card charging, physical printer integration and the broader planned restaurant features are still under development.
- Subscription payments are handled separately from customer counter payments. Visiting the billing screen does not change the existing manually collected pilot arrangement.

Practice only in the training workspace or an explicitly designated test branch. Do not enter fabricated sales into the restaurant's live ledger.
