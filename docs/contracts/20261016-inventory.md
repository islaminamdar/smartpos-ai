# Recorded branch inventory — SQL027 candidate

## Scope and operational meaning

SQL027 adds a branch stock register, immutable manager command outcomes and immutable movement history. It does not change SQL001–026, `pos_products`, sales, receipts, payments, cash drawers, tax, purchase accounting or offline custody. A stock item is separate from a sales menu product. There are no automatic sale deductions, recipes, transfers, supplier balances, costing, valuation or expiry tracking in this slice. Quantities describe **server-recorded movements**, not verified live physical stock or unuploaded device work.

Only an authenticated, currently active owner or manager with access to an active branch can read current inventory or submit a new change. A new write also requires that actor's active device and unrevoked binding for the exact branch. Read-only branch selection does not rebind the counter. Existing access and release gates still apply at the application layer. This is a local candidate migration; it has not been applied to production.

## Quantities and item lifecycle

All quantities are exact integer thousandths, bounded in absolute value by `1_000_000_000_000`. Units are `kg`, `litre`, or `piece`; piece quantities and thresholds must be multiples of 1000. Units are immutable. Stock cannot become negative or exceed the quantity bound. A branch can hold at most 1000 items, including inactive items; items and their history cannot be deleted.

A newly created item has `onHandMilli: null`, `movementCount: 0`, and revision 1. Editing its metadata preserves that unknown balance. The first movement must be a physical count, including a count of zero. That first count has `beforeMilli: null` and `deltaMilli: null`; it does not claim stock was received. Subsequent counts record their actual difference from the previous recorded balance.

Every metadata edit and movement increments the same item revision. The submitted `expectedRevision` must match; stale requests fail without writing. `movementCount` counts movements only. An inactive item rejects new movements but can be reactivated by a versioned metadata edit. A previously committed movement remains recoverable after later edits or deactivation.

Names are nonempty, trimmed text up to 160 characters. Reasons are nonempty, trimmed text up to 240. SKU is null or an exact uppercase ASCII identifier matching `[A-Z0-9._-]{1,64}`, unique across all items in that branch, including inactive items. No silent normalization occurs. A movement reference is null or nonempty trimmed text up to 120 characters; it is a manager-supplied document or supplier reference, not evidence that a purchase or supplier payment was recorded.

Stored text is preserved exactly: PostgreSQL counts Unicode codepoints and its `btrim` removes ASCII spaces. Response validation uses those semantics for stored item names, reasons and references, and bounded raw strings for staff/device label snapshots. It does not apply JavaScript trimming or truncate immutable values. The browser normalizes its input before saving a command; the HTTP command schema remains stricter than the stored-output schema.

## Exact command contracts

The request ID is a client-generated lowercase UUID persisted before sending. Every object below is strict: missing or additional fields are rejected. JSON numbers must be integers. The command JSON is limited to 8192 bytes after PostgreSQL JSON representation.

```ts
type ItemSave = {
  id: UUID; type: 'item.save'; branchId: UUID; deviceId: UUID;
  expectedRevision: number; reason: string;
  item: {
    id: UUID; name: string; sku: string | null;
    unit: 'kg' | 'litre' | 'piece'; reorderLevelMilli: number; active: boolean;
  };
};
type StockMovement = {
  id: UUID; type: 'stock.receive' | 'stock.waste' | 'stock.count' | 'stock.adjust';
  branchId: UUID; deviceId: UUID; itemId: UUID; expectedRevision: number;
  quantityMilli: number; reason: string; reference: string | null;
};
```

`item.save` with expected revision 0 creates a new item. Updating an existing item requires its exact positive revision. `stock.receive` and `stock.waste` take a positive magnitude. `stock.adjust` takes a nonzero signed change. `stock.count` takes a nonnegative absolute observed quantity. Receive, waste and adjust require an initialized balance. No command accepts a client-controlled actor, organization, balance, movement timestamp or resulting revision.

## RPCs and exact results

The four public RPCs are granted only to `authenticated`. Tables and helper functions have no grants to PUBLIC, anon, authenticated or service_role; row-level security is enabled without client table policies. Security-definer entry points use an empty search path.

### `pos_manage_inventory(p_command jsonb, p_binding text)`

Successful writes return:

```ts
type Item = {
  id: UUID; branchId: UUID; name: string; sku: string | null;
  unit: 'kg' | 'litre' | 'piece'; reorderLevelMilli: number; active: boolean;
  revision: number; onHandMilli: number | null;
  createdAt: ISODateTime; updatedAt: ISODateTime; movementCount: number;
};
type Movement = {
  id: UUID; itemId: UUID;
  type: 'stock.receive' | 'stock.waste' | 'stock.count' | 'stock.adjust';
  quantityMilli: number; beforeMilli: number | null; deltaMilli: number | null;
  afterMilli: number; reason: string; reference: string | null;
  actorId: UUID; deviceId: UUID; actorName: string; deviceName: string;
  recordedAt: ISODateTime; revision: number;
};
type Applied = {
  status: 'applied'; requestId: UUID; replayed: boolean;
  item: Item; movement: Movement | null;
};
type Cancelled = { status: 'cancelled'; requestId: UUID; replayed: boolean };
```

The movement ID equals the request ID. Metadata saves have `movement: null`. Actor and device names are immutable snapshots; a missing staff display name uses `Owner` or `Manager`. A replay returns the original saved item and movement, even when current stock has subsequently changed. Only `replayed` becomes true. New-write authorization precedes replay; use the historical request RPC if access was revoked after an uncertain response.

### `pos_inventory_request(p_mode text, p_command jsonb, p_binding text)`

`p_mode` is `lookup` or `cancel`. Both require the authenticated original actor and exact historically bound branch/device/token, including revoked bindings or inactive devices. They grant no read access to current inventory. A request lock serializes lookup/cancellation against the writer. Existing request ID, full payload, actor, organization, branch and device must all match. Another actor or a changed payload cannot retrieve the outcome.

- Existing applied request: return its original `Applied` result with replayed true. Cancel never reverses a committed stock movement.
- Existing cancelled request: return its original `Cancelled` result with replayed true.
- Lookup without a stored request: `{status:'not_found',requestId}`; no mutation. This does not prove a delayed write cannot still commit.
- Explicit cancel without a stored request: atomically save `{status:'cancelled',requestId,replayed:false}`. This immutable tombstone defeats every subsequent exact write with that ID. A delayed authorized write returns the cancelled result; a changed body conflicts.

The UI must persist and retry the same request ID/body after uncertainty. It may abandon a pending operation only after a verified cancelled result. A missing lookup does not authorize a new request ID. Cancellation records no movement, item mutation or financial reversal.

### `pos_inventory(p_branch uuid, p_query jsonb)`

Exact query: `{search: string, filter: 'all'|'low'|'uncounted'|'inactive', afterId: UUID|null}`. Search is at most 160 characters and matches a case-insensitive literal substring in name or SKU; percent/underscore are ordinary characters. `afterId` is an exclusive UUID cursor; rows sort by UUID ascending.

Exact result:

```ts
{
  status: 'ready'; branchId: UUID; asOf: ISODateTime;
  counts: {
    totalItems: number; activeItems: number; inactiveItems: number;
    lowStockItems: number; uncountedItems: number;
  };
  matchingItems: number; items: Item[]; nextCursor: UUID | null;
}
```

The page contains at most 50 items. `nextCursor` is the last returned ID only when another matching item exists. Counts cover the whole branch, not the page or search; `matchingItems` covers the entire filtered search before cursor slicing. Low stock means active, initialized balance at or below the threshold, including a zero threshold. Uncounted means active with unknown balance. Inactive items are excluded from those two counts. Quantities are never summed across units. A single SQL statement supplies all page fields and counts from one snapshot. More than 1000 source items fails the entire read rather than returning partial totals.

### `pos_inventory_history(p_branch uuid, p_item uuid, p_before_revision integer default null)`

Exact result: `{status:'ready',branchId,asOf,item:Item,entries:Movement[],nextBeforeRevision:number|null}`. Entries sort by revision descending and are bounded to 50. A non-null cursor is exclusive and must be in 2–2147483646. The next cursor is the last returned movement revision only if another entry exists. Revision gaps caused by metadata edits are expected. The current item and movement page share one statement snapshot; `item.movementCount` remains the total count, independent of the selected page. Foreign or missing items are not disclosed.

## Transaction and custody invariants

New writes acquire the existing shared staff-authority advisory lock15 and recheck active manager/owner access in a VOLATILE outer function. They then acquire global request lock38, branch inventory lock39, device/binding row locks, global item lock40 and the item row lock. Branch locking serializes the item cap and SKU uniqueness. Item locking also prevents cross-branch races from reusing a globally unique item ID. Staff revocation takes the existing exclusive actor15 gate, so either the authorized write completes first or revocation is observed before any change. Historical recovery acquires request38 then historical device/binding locks; it does not acquire current staff authority.

Projection update, command outcome, movement and audit event commit in one transaction. A failure in any insert rolls the entire write back. Immutable triggers protect command and movement records; the stock identity trigger forbids deletion and ID, scope, unit or creation-time changes. No helper trusts caller-supplied roles, names, balances or resulting quantities. Reads perform no writes.

Errors include `POS_ACCESS_DENIED`, `POS_MANAGER_REQUIRED`, `POS_DEVICE_INVALID`, `POS_IDEMPOTENCY_CONFLICT`, and inventory-specific `POS_INVENTORY_INVALID`, `POS_INVENTORY_NOT_FOUND`, `POS_INVENTORY_CONFLICT`, `POS_INVENTORY_SKU_CONFLICT`, `POS_INVENTORY_UNIT_IMMUTABLE`, `POS_INVENTORY_INACTIVE`, `POS_INVENTORY_COUNT_REQUIRED`, `POS_INVENTORY_INSUFFICIENT`, `POS_INVENTORY_CAPACITY`, `POS_INVENTORY_IMMUTABLE`. API handlers must map these to finite public messages without returning SQL details. Capacity failures never substitute partial state.

## Browser API and recovery journal

`GET /api/pos/inventory` takes `branchId`, optional `search`, `filter` and `afterId`; `GET /api/pos/inventory/history` takes `branchId`, `itemId` and optional `beforeRevision`. Both require the online pilot and current authenticated read authority. Duplicate or unknown query keys are rejected. `POST /api/pos/inventory` takes the exact command, requires the online pilot and same origin, and verifies the current device binding before the database writer. All replies are private/no-store.

`POST /api/pos/inventory/recovery` takes `{mode:'lookup'|'cancel',command}` and requires the same origin, authenticated actor and original historical binding, but not the pilot or current manager/device activation. Both POST routes require `X-POS-Actor` to match the authenticated user before any device or inventory operation. This is an expected-identity check, not a source of authority; missing or changed identity fails closed. Body limits are 8192 bytes for writes and 9216 for recovery. Database errors are mapped to finite public codes.

The browser stores one exact pending command per actor/branch/device in persistent local storage. Web Locks serialize save/clear across tabs, and storage events discover work started elsewhere. Another pending payload cannot be overwritten. New writes require durable storage; the original record is cleared only after a matching applied/cancelled acknowledgement. A `not_found` result retains the record and allows only exact retry or explicit cancellation. Historical outcomes are never presented as current stock; the UI refreshes the current item separately. Current stock access can fail while the original actor's global recovery remains available in the signed-in pilot counter.

## Verification status

The frozen SQL027 candidate passed 178 independent assertions and 13 observed two-session lock-wait races on disposable PostgreSQL. Actual responses also passed the production TypeScript schemas. Coverage includes first-count unknown versus zero, immutable outcomes, historical recovery after revocation, stale revisions, duplicate writes, both cancellation/write race outcomes, branch quotas, literal search, pagination, coherent item/history snapshots, monotonic update times, global item/SKU collisions and preservation of financial records. The disposable test database was verified dropped. A scoped Semgrep scan ran 47 rules over SQL027 with zero findings; prior migrations remained byte-identical.

The parent production handlers passed seven actual PostgreSQL integration scenarios (authentication/cookie/Supabase transport mocked; database roles and transactions real), including Unicode snapshot preservation, interrupted confirmation/replay, revocation recovery and unchanged financial records. The full web suite passed 1074 tests with one existing skip. Thirty focused UI/integration tests and 320/375/1280 browser reviews cover the usable counter flow; a first count of zero with lost confirmation recovered exactly one history entry. Scoped API and UI scans found no findings; this is not the full platform security audit.

These are local candidate checks. Deployment review and physical/customer acceptance remain separate. No production migration, feature enablement or customer stock seed has been performed.
