# Kitchen stations: configuration and routing contract

This is an implementation contract for an unfinished feature. Configuration alone does not route preparation. Existing paid/unpaid kitchen behavior must remain unchanged until the complete scoped workflow is verified. No station-routing activation or deployment is established by this document.

## Required end state

Managers define branch stations and assign products. An unassigned product goes to General. The selected station is snapshotted by the server when paid preparation starts or a product first enters an unpaid preparation generation. Later configuration edits do not move existing work. Additions to the same product/generation retain their original station. Archived stations retain their outstanding work and history.

Station commands move only the selected station's quantities. Existing unpaid batches remain the quantity ledger; paid work needs explicit station child states and a defined aggregate parent state. Payment preserves dispatched preparation rather than duplicating it. Returns/withdrawals use historical station ownership, never current product assignments. Every affected station receives its own notice acknowledgement obligation. Fully removed or served work with pending notices stays visible. Legacy whole-order actions must not bypass station boundaries; historical exact request recovery must remain available.

The UI keeps a shared station selector, visible General work and a branch-wide attention indicator above both preparation families. A filter is not an authorization boundary. Managers configure stations separately from menu pricing. Mobile controls must remain usable at 375px, and desktop must show the same quantities/action scope. Printer routing, courses and offline-import kitchen projection remain separate work.

## First implementation boundary: configuration

SQL031 and `/api/pos/kitchen-stations` provide authoritative configuration and exact request recovery. They do not change ticket projection, stages, notices, existing commands or financial/menu revisions. The customer-facing manager editor and scoped preparation integration remain pending until their complete workflow exists.

All UUIDs are canonical lowercase. JSON objects reject unknown fields; integers are JSON numbers, never numeric strings. Names contain 1–60 Unicode code points, equal their ECMAScript `trim()` result and contain no ASCII control characters (U+0000–001F or U+007F). Validation never normalizes or silently trims a saved request. General is reserved case-insensitively. A branch has at most 128 station records, including archived records; records are archived rather than deleted. Active names are unique case-insensitively within a branch. Archived names may be reused, because station identity and future historical snapshots use IDs, not names. A station cannot be archived while products remain assigned to it; reassign or clear those routes first. Creating an already archived station is invalid. Each product has at most one explicit station. Clearing an assignment returns future work to General. Only a current active station can receive an assignment.

Configuration revision is branch-wide: zero before the first command, then increases once for each successful change. `expectedRevision` is 0–2147483646; conflicts fail without a change. No-op commands fail without consuming a revision. Branch serialization makes duplicate names, assignment/archive races and revision conflicts deterministic. Product routing requires a product owned by the same organization and branch; disabled products may be configured for future use. Configuration changes do not change product prices, product revisions, invoices, tabs, preparation or stock.

Station = `{id, name, active, createdAt, updatedAt}`.
Route = `{productId, stationId}`; `stationId` is nullable only in a route-clear acknowledgement, not a stored route or list entry.

Common command fields: `{id, branchId, deviceId, expectedRevision, type}`.

- `type="station.save"`: adds `station:{id,name,active}`. New ID creates an active station; an existing same-branch ID renames, archives or reactivates it. IDs cannot be adopted across branches.
- `type="route.set"`: adds `productId` and `stationId:uuid|null`.

Command result = `{status:"applied",requestId,branchId,replayed,revision,station:Station|null,route:Route|null}`. Exactly one of station/route is present according to the original command. Revision equals expectedRevision+1. Saved name/active or route/product/station must match the original request. A replay returns the exact original result with only `replayed` changed. Cancellation = `{status:"cancelled",requestId,branchId,replayed}` and permanently prevents that exact request from executing.

Read query = `{branchId,deviceId,afterProductId?:uuid}`. Result = `{status:"ready",organizationId,branchId,actorRole,revision,generatedAt,stations:Station[0..128],routes:Route[0..100],routeCount,nextProductId:uuid|null}`. Stations include archives, ordered by ID. Routes are ordered by product ID, after the exclusive cursor. `routeCount` is an integer 0–2147483647. Total count covers all routes, not just the page; a next cursor equals the last shown product only when more exist. Configuration, counts and page are read from one database snapshot. Clients assembling multiple pages must discard/restart if the configuration revision changes. A cursor is not authority to another branch.

## Authority, recovery and audit

Reads require active branch staff and the supplied currently bound device. New commands require an active owner/manager and active original device binding. Branch IDs, organization IDs and roles are derived/checked on the server. All new tables use RLS and no direct client/service-role grants; private helpers have no public execution grant. RPCs use fixed empty search paths.

Commands/cancellations store immutable original actor, organization, branch, device, complete payload and result. Historical lookup permits an inactive original actor to recover only their exact committed result through an original historical binding or a currently valid replacement device in the same branch with active current staff authority, following the established management-recovery policy. It never grants new configuration access. Creating an unsaved cancellation requires current active branch authority and a valid same-branch binding; a demoted original manager may cancel their own pending request but may not execute it. Another actor, modified payload, foreign branch or changed original device ID cannot adopt a request. Recovery returns the original result even after later configuration changes. It does not perform the original mutation.

Mutation and recovery serialize on the same request lock. New mutations additionally serialize on branch configuration. Acquire shared actor-authority lock before request, binding/device locks before branch configuration; never acquire financial order, shift, tab or preparation locks. Current staff/device revocation must serialize correctly. Record each applied command in the branch audit log; failed requests leave no configuration, revision or audit residue. Any statement failure rolls the entire change back.

RPCs:

- `pos_list_kitchen_stations(p_branch uuid,p_device uuid,p_binding text,p_after_product uuid default null)`
- `pos_execute_kitchen_station_command(p_command jsonb,p_binding text)`
- `pos_resolve_kitchen_station_request(p_command jsonb,p_binding text)`

Errors: `POS_STATION_INVALID`, `POS_STATION_CONFLICT`, `POS_STATION_NAME_CONFLICT`, `POS_STATION_CAPACITY`, `POS_STATION_ASSIGNED`, `POS_STATION_NOT_FOUND`, `POS_STATION_PRODUCT_INVALID`, `POS_STATION_NO_CHANGES`, plus established access/device/manager/idempotency/cancellation errors. HTTP mapping must fail closed on unknown errors or mismatched confirmations.

## Acceptance and remaining integration

Configuration requires actual PostgreSQL checks for tenant/role/device scope, strict malformed payload rejection, pagination, archive/reassignment, name uniqueness, exact replay/cancellation, inactive-original recovery, replacement bindings, no-op/revision exhaustion, audit atomicity, concurrent save/archive/assignment and request/recovery races. HTTP/schema tests must reject mismatched results and exercise source/origin/body bounds. Scoped static security review supplements these tests.

Routing is not complete until mixed-station paid and unpaid orders, served work plus additions, weighted withdrawals, promotion, partial/final returns, station retirement, legacy mutation guards, independent notice acknowledgement, durable browser recovery and complete pagination have passed integration and responsive browser checks. A future rollback must keep readers/recovery for already routed work. Physical kitchen printers need their own acceptance evidence.

## Configuration evidence — 2026-10-16

The configuration candidate passed 146 isolated PostgreSQL checks, including eight independently observed lock-wait races. Actual SQL outputs were parsed by the strict TypeScript schemas. The test applies the 29 POS migrations through SQL031 excluding the unrelated SQL007 PayPal and SQL009 login-source-limit migrations; authentication identities are synthetic. It verifies role/branch/device restrictions, historical-original versus current-replacement recovery, cancellation, immutable commands, private helper/table permissions, audit rollback, capacity/revision limits and 105-route pagination. Both disposable databases were dropped and the owned cluster/socket removed.

The 27 new API/schema tests and 24 related kitchen tests passed. The complete unit run passed 1,377 tests with one pre-existing skipped RLS placeholder; the isolated SQL tests supply the actual configuration permission checks. Typechecking, scoped lint and the production build passed. The build still reports warnings in existing Sentry/legacy code. Scoped TypeScript Semgrep and generic SQL checks found no issues; generic SQL scanning is not semantic PL/pgSQL analysis. Independent source/evidence review found no blocking issue in this foundation. HTTP authentication/database adapters are mocked in unit tests, so these results do not establish real hosted login or deployment acceptance.

Both new endpoint paths remain excluded from the public release allowlist. No customer configuration, tickets, bills or production deployment changed. The [UI/UX direction](../design/2026-10-16-kitchen-stations.md) is a reviewed plan, not a rendered screen. Next work must implement snapshotted station ownership, scoped stages and notice acknowledgement across both kitchen families, then the durable editor and responsive acceptance; repeating configuration checks alone does not finish routing.
