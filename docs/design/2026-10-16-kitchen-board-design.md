# Paid-order kitchen board

16 October 2026 · UI/UX Specialist · model runtime-selected/not exposed

## Purpose and scope

A branch kitchen follows already paid counter orders from queued to preparing, ready and served. This release does not imply unpaid table orders, table allocation, split bills, an offline kitchen or a dedicated kitchen staff role. Full refunds produce terminal cancelled tickets; kitchen controls never issue financial refunds. The older `/kds` controller is not reused because it reads and writes the legacy orders flow directly.

The counter's existing Arial type, navy `#142d4e`, blue `#165dcc`, white surfaces, pale `#f4f7fb` background and visible blue focus rings remain the visual foundation. Amber `#a56412` marks queued ticket edges and green `#16724c` marks ready edges. Every state also has a written label; colour is never the only signal. Large invoice references, order type and quantities carry the visual hierarchy. No decorative animation or arbitrary lateness threshold distracts from preparation.

Desktop uses three ticket columns, medium widths two, and widths600px or below one. Ticket lines pair quantity and unit with the full product name, preserving weight sales to three decimal places. Controls have48px minimum heights, long identifiers wrap, and headings/counts wrap rather than creating horizontal page overflow. Active and served/cancelled views remain distinct. Complete branch counts are labelled separately from the active page; pagination replaces the page instead of combining snapshots taken at different times.

## Operation and recovery

- Forward actions are one adjacent state: Start preparing, Mark ready, then Mark served. Served requires confirmation that the order has actually been handed over.
- Managers and owners may correct one state backward, with a required reason. Cashiers see no correction control. The server is authoritative for permissions and revisions.
- The board refreshes every10 seconds only while the page is visible, avoids overlapping reads, and invalidates older reads when a write begins. Refresh failure retains the last verified tickets with an explicit warning and disables actions. An unavailable board is never displayed as zero orders.
- Before sending, an exact immutable command is added to IndexedDB under actor and branch. Atomic add prevents a second tab from replacing an unresolved request. A new counter device continues recovery with the original saved device ID.
- Uncertain network results, malformed acknowledgements, permission/revision conflicts and mismatched cancellation IDs retain the original request. A GET showing the desired ticket state is insufficient to clear it. Only the matching update acknowledgement or matching permanent cancellation acknowledgement clears storage.
- Cancellation recovery requires an explicit checkbox. Its copy distinguishes cancellation of an unsaved status change from cancellation/refund of the order.
- Same-document events and BroadcastChannel notifications synchronize pending state, with focus fallback and atomic database protection. Notification failures do not invalidate committed journal transactions.
- The global recovery component can discover the authenticated original actor and pending original branches without loading a kitchen board. The parent counter gates sign-out, password change and replacement-device registration while recovery remains pending or storage cannot be read.

## Verification

Twenty-one targeted checks passed:18 UI interaction tests and3 real Chromium IndexedDB integration tests. Coverage includes exact retries, storage-before-network, cross-actor isolation, foreign branch rejection, matching and mismatching acknowledgements, replacement-device recovery, complete counts with page replacement, manager correction reasons, served confirmation, refunded tickets, stale reads, visibility/non-overlapping polling and atomic two-tab storage. TypeScript passed. Scoped Semgrep ran210 rules over4 owned files with zero findings; this is not a full-platform audit.

## Rendered review

The integrated local production preview was exercised through CUA with synthetic same-origin API responses and real browser IndexedDB at1280,375 and320 CSS pixels. Desktop showed three ticket columns; both phone widths stacked ticket cards, quantities, full product names and48px actions without overlap. Page scroll width did not exceed the viewport. The control measurement found no visible non-checkbox target below44px; checkbox labels provide the48px hit area. No page exception logs were observed.

The rendered workflow passed forward preparation, manager correction with reason, served confirmation, served/refund terminal view, uncertain503 retention, stale-view action lock and exact cancellation recovery. Navigating to Account while pending kept Sign out and password fields/actions disabled. A synthetic second original-branch request remained visible above the current-branch Kitchen board and was resolved separately. In both no-bootstrap and unenrolled states the original actor's saved request remained recoverable; counter registration was disabled until matching cancellation, then re-enabled. No registration or real account action was performed.

One rendered finding was fixed: the cancellation checkbox retained consent across requests. The panel is now keyed by request ID and the21st regression test proves a new request starts unchecked. The final rebuilt320px preview confirmed the correction: after cancellation and a second uncertain request, consent is unchecked and the cancellation button is disabled. The Branch subscription copy correctly says US$100 per branch per month and preserves earlier manual arrangements. Its newly added billing link initially measured17px high. The root engineer corrected the Branch links, and the final rebuilt320px preview measured the billing link at44px, home link at44px and wrapped training link at61px, with no horizontal overflow or undersized visible targets.

Private measurement evidence: `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/kitchen-ui-review/results.json`. Screenshots were captured and visually inspected in native CUA output. This review does not claim live deployment, real network/backend acceptance, printer verification or customer acceptance.

All synthetic requests were explicitly resolved and actual IndexedDB readback confirmed zero pending records. The temporary local CUA tab was closed, removing fetch overrides, and viewport emulation was reset. No production tab or account was touched.
