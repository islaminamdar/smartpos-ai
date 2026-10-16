# Branch operations snapshot — SQL024 candidate

This read-only candidate adds `pos_branch_operations(p_branch uuid)`. It does not deploy migrations, enable offline issuance, change staff permissions, or write operational/financial data. SQL001–023 remain unchanged.

## Authorization and consistency

Only `authenticated` may execute the RPC. It derives `auth.uid()` itself. The caller must currently be active, with the owner or manager role for the branch's organization, and either organization-wide membership or an assignment to that exact active branch. A counter device binding is deliberately unnecessary: management can select an authorized branch without changing their counter device. Cashiers, foreign organizations, inactive branches and revoked membership are denied.

The outer PL/pgSQL function is VOLATILE and acquires the existing shared staff-authority advisory lock15 before rechecking membership. A staff revocation that commits while the reader waits is observed. All operational sections and the stable SQL011 fiscal report are subsequently read in one SQL statement snapshot. The read never finalizes a pending request, signs a decision, or changes custody. `generatedAt` is the request's `statement_timestamp()`; it may precede a staff-lock wait and is not a freshness lease or permission to write.

## Exact return contract

```text
{
 schemaVersion: 1, status: "ready", branchId: UUID, branchName: string,
 currency: "AED", timezone: "Asia/Dubai", businessDate: YYYY-MM-DD,
 generatedAt: timestamp, basis: "server_recorded", offlineDeviceCoverage: "unknown",
 sales: {documentCount, legacyOrdersExcluded, summary, payments},
 openShifts: {totalCount, limit:20, truncated, items:[{
   id, deviceId, deviceName, openedBy, staffName:null|string, openedAt, openingCashFils
 }]},
 closedShifts: {
   windowStart, windowEnd, totalCount, incompleteCount, discrepancyCount,
   netDifferenceFils:null|integer, limit:20, truncated, items:[{
     id, deviceId, deviceName, openedBy, staffName:null|string, openedAt, closedAt,
     countedCashFils:null|integer, expectedCashFils:null|integer,
     cashDifferenceFils:null|integer
   }]
 },
 unpaidOrders: {totalCount,totalFils,oldestCreatedAt:null|timestamp,
   limit:20,truncated,items:[{id,label,serviceType,tableName:null|string,
     createdAt,updatedAt,totalFils}]},
 kitchen: {
   paidTickets:{queued,preparing,ready},
   tabTickets:{activeCount,withUnacknowledgedChanges},
   tabBatches:{queued,preparing,ready}
 },
 offlineCustody: {unsealedAuthorities,unresolvedUploadExceptions,
   pendingPaymentFreezes,conflictRecords,unsupportedEvidenceRecords,blockedDeviceEpochs}
}
```

All counts are nonnegative integers; all monetary values are exact integer fils. Timestamps are PostgreSQL JSON timestamp strings with offsets. Fields are always present, with explicit nulls as shown. Lists are sorted deterministically and contain at most20 rows. All count and monetary aggregates use the full eligible source, not the displayed list. `truncated` means `totalCount > 20`.

### Sales

`sales` is the reduced result of unchanged `pos_branch_report(branch,businessDate,businessDate)`. `summary` contains `invoiceCount`, `creditNoteCount`, `salesGrossFils`, `refundGrossFils`, `netGrossFils`, `netExVatFils`, `vatFils`. `payments` contains cash/card rows `{method,salesFils,refundsFils,netFils}`, ordered by method. Issued fiscal snapshots and credit-note issuance date determine the totals. A refund for a prior-day invoice appears on today's credit-note date. Undocumented legacy orders remain excluded and counted explicitly; the legacy counter is inherited unchanged and is not an unpaid-tab count. A full Dubai business day is the fiscal reporting period; current work sections have their own scopes below.

### Drawers and unpaid orders

Open shifts include all server-recorded open shifts, including earlier days, oldest first (`openedAt,id`). Opening cash is stored data; the response does not estimate the current drawer balance.

Closed shifts cover `[Dubai midnight businessDate-29, generatedAt)`, most recent first (`closedAt DESC,id DESC`). `windowEnd` equals `generatedAt`. `incompleteCount` counts any row missing one or more stored cash fields. `discrepancyCount` counts complete rows whose difference is nonzero. `netDifferenceFils` is null if any row is incomplete; otherwise it is the full-window signed sum, including zero for an empty complete window. Counted cash must be nonnegative. Complete rows must obey `difference=counted-expected`; inconsistent or unsafe values fail the whole response, including rows beyond the20-item list. A signed sum can offset positive and negative differences; it is not a count of discrepancies or total absolute losses.

Unpaid orders are SQL015 open tabs across all dates, oldest first (`createdAt,id`). `totalFils` is the sum of saved `subtotal_fils` estimates, not recognized revenue or a guarantee of the future checkout price. No buyer, delivery address, note, product lines or proof payload is returned. Table/staff/device names are operational labels; removed staff membership yields null staffName.

### Kitchen

Paid ticket counters count SQL014 ticket rows in queued/preparing/ready stages. Tab counters use SQL016 tickets and batches separately to avoid double-counting paid tab work as a new paid ticket. An active tab ticket has outstanding positive-quantity queued/preparing/ready batches or unacknowledged changes; cancelled tickets with unacknowledged corrections are retained. `withUnacknowledgedChanges` counts tickets, not events. `tabBatches` counts distinct positive-quantity batches at each stage, never sums mixed piece/pack/kg quantities. These are server kitchen records; historical offline imports deliberately do not manufacture kitchen dispatches.

### Recorded offline custody

These categories overlap and must not be summed into a count of customers, payments or incidents:

- `unsealedAuthorities`: stored allocations without a server-accepted terminal seal, including expired allocations and interrupted bundle attachment.
- `unresolvedUploadExceptions`: exception records without an immutable exception-resolution row.
- `pendingPaymentFreezes`: retained normal freezes without an attached signed manager result. A decision row alone does not clear this count.
- `conflictRecords`: all retained immutable conflict records; current candidate has no conflict-resolution mechanism.
- `unsupportedEvidenceRecords`: retained raw unsupported-text proofs; current candidate has no raw-evidence resolution mechanism.
- `blockedDeviceEpochs`: enrolled epochs with their persistent blocked flag.

Signed manager outcomes may reduce pending freezes, while conflict/raw/epoch holds remain visible independently. Zero server records never proves a device has uploaded all receipts, received an ACK/result, has no frozen payment, or is safe to sell/close. Local custody, network state, device clock health and device receipt of signed results remain unknown. This response grants no financial authority.

## Bounds, failure and performance

Each new source is branch-scoped with a50001-row sentinel and an accepted maximum50000. Separate source counts cover open/closed shifts, open tabs, active paid kitchen, all tab-kitchen tickets (including retained history), selected active batches, authority history, epochs and each custody evidence category. Historical source growth can therefore make the entire view unavailable, rather than silently undercounting. Branch/status/time/authority indexes support these lookups; no cross-branch evidence scan or unbounded list is requested. The unchanged SQL011 report has its own50000-document and5000-product limits and inherited report-validation behavior. SQL024 additionally rejects a legacyOrdersExcluded count above50000; that inherited SQL011 count is computed completely before the cap check.

`POS_OPERATIONS_TOO_LARGE` rejects any source cap breach. `POS_OPERATIONS_INVALID_DATA` rejects inconsistent stored closed balances or any returned number outside the exact JavaScript integer range ±9007199254740991 (or fractional values). Existing report access/profile/range/size errors remain failures. Authorization can return the existing `POS_ACCESS_DENIED` or `POS_OPERATIONS_ACCESS_DENIED`. Missing migration/RPC/dependency is unavailable, never an empty successful report. The HTTP service must validate the full shape and map unavailable/error responses without substituting zero totals.

No production migration has been applied as part of this candidate. Actual disposable PostgreSQL/security test evidence is recorded separately; deployment and customer readiness require their own authorization and verification.
