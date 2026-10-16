# Kitchen stations — manager and kitchen guide

This guide describes the tested candidate workflow. It is not yet enabled on the customer site. Existing online counter sales continue to use the current kitchen screens. Station routing and receipt/kitchen printer routing are separate features; no printer compatibility is claimed here.

## Set up preparation areas

An owner or manager opens **Kitchen stations** and adds the branch's preparation areas, such as Grill, Drinks or Sweets. Search for a menu item, choose its preparation area and select **Save product assignment**. Unassigned products use **General** so they remain visible.

Assignments apply when new work is sent to the kitchen. Changing a station's name or a product assignment does not move existing preparation. Removing and re-adding a product within the same dispatched order generation keeps its original station. An explicitly reopened order starts a new generation and uses the current assignments; notices from the cancelled generation remain available.

To archive a station, first move or clear its product assignments. Archiving preserves its existing work and history. Multiple staff may use the branch's stations; choosing a station is a view preference, not a separate staff permission.

## Prepare an order

Open **Kitchen**. The station board includes both paid and unpaid preparation. Choose **All stations**, **General**, or a named station. The notice count covers the whole branch even when the view is filtered. Older work sent before station routing was enabled remains in the existing kitchen boards.

Select a work item to see its quantities, order reference, service type and preparation stages. Each stage button moves only that station's quantities in the selected stage. A manager can move work back one stage with a reason. A station must acknowledge its own pending changes before advancing preparation; another station's acknowledgement cannot clear them.

Additional quantities are queued while already served quantities remain served. Taking payment for a dispatched unpaid order keeps the same preparation rather than sending it a second time.

## Review changes and returns

Read the full notice before selecting **Acknowledge this notice**. Withdrawal notices identify the quantities and stages affected. Metadata changes and notices for fully withdrawn or cancelled work remain visible until acknowledged.

A partial return describes the credited quantities. It does not automatically undo food preparation or stock movements. Check what has actually been cooked and reconcile stock separately.

A final return cancels remaining preparation. If another station's items were returned earlier, that station receives a separate preparation-cancellation notice for any work still present. These stopped quantities are not presented as newly credited quantities. Each station acknowledges its own obligation.

## Connection problems and saved requests

An uncertain action stays saved on the original browser. Use the recovery action to check the original request. If the server already applied it, its exact confirmation is restored; otherwise recovery permanently cancels that unsaved request. Do not repeat the operation as a fresh request while its result is uncertain.

Pending station changes prevent account or counter changes. Recovery remains visible if a manager loses editing permissions or the new-work interface is disabled. A request for another branch must be handled with that branch's authorized binding. Keep browser data intact if storage cannot be verified.

## Release and acceptance

Customer activation still requires the reviewed SQL031–032 deployment, API release routing, the counter interface flag and explicit admission for the intended branch. Turning off new admission must not remove existing station work, its readers or recovery. Local tests and synthetic browser fixtures do not establish printer support or acceptance of a real restaurant shift.
