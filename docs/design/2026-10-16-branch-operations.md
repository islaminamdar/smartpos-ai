# Branch daily operations — design contract

2026-10-16. Candidate implementation uses the strict SQL024/API operations snapshot. Read-only manager/owner control screen; it does not close another counter, return money, change an order or declare an offline device synchronized.

## Direction

Continue the established counter typography and palette: navy `#142d4e` for primary text, blue `#165dcc` for actions/focus, white `#ffffff` surfaces, quiet slate `#526176`, amber `#fff5d9` for attention and pale red `#fff0ed` for failure. Use the existing inherited font with tabular numerals for amounts, left-aligned labels and readable 14–16px supporting copy. No new fonts, gradients, charts or animation are necessary.

The memorable element is a useful branch handover sheet: recorded sales appear immediately after compact branch controls, followed by open counters and outstanding work. Repeated identical statistic cards would obscure operational priorities; use distinct sections and divided rows instead. Counts only appear after verified reads, never as loading zeros.

```
Branch operations                     Refresh
[View branch]    Today / Dubai    Last successful refresh
Completeness: server-known records; offline-local unknown
Recorded sales / credits / net       Open detailed reports
Counters open                 Recent counted closes
[name, opened, cashier]        [counted / expected / difference]
Unpaid orders                 Kitchen workload and notices
Recorded offline attention and limits
```

At 375/320px, each row stacks its values with visible labels. Keep long branch/counter names wrapping, buttons at least 48px, accessible focus and no horizontally scrolling table. Desktop uses two purposeful columns for operational sections, preserving the same reading order. Amount differences use words/signs and labels, not colour alone.

## Scope and navigation

The current counter’s branch remains bound to its device. An Operations branch selector can independently read only owner/manager branches from bootstrap; it must never alter the sale basket, enrollment, device cookie or cashier branch. The server authorizes the selected branch on every read. Clear the prior branch snapshot immediately when scope changes, and suppress delayed responses.

Working destinations are existing Reports, Orders & tables, Kitchen and the current device’s Shift. Actions must identify their scope. Orders/Kitchen/Shift navigation is only offered when the selected overview branch matches the bound counter; a counter row must not imply permission to close another drawer. If cross-branch Reports navigation cannot preserve scope without altering checkout, provide a clearly scoped report component or omit that shortcut. No dead buttons or speculative workflow links.

## Read states and completeness

Initial load shows loading text and no fabricated totals. A failed initial load shows unavailable/retry. Refresh failure preserves a same-scope last-successful snapshot labelled as stale, with its timestamp and disabled drilldowns; no success status or refreshed timestamp. Requests must not overlap, and unmount/actor/branch changes invalidate responses. Manual Refresh is required; any future polling must pause while hidden.

The response must identify currency, timezone, business date, branch, generation time, exact source basis, section counts and row limits/truncation. Sales follow issued fiscal documents/credits, not unpaid order estimates. Pending orders are quoted workload, not collected sales. Card amounts are recorded tender, not bank reconciliation. Zero recorded exceptions does not prove there are no offline issues: local-only bills, unknown pending actions and unuploaded freezes cannot be observed here.

Where multiple databases or separate reads supply sections, communicate their actual freshness and avoid claiming one atomic snapshot. Unknown or unsupported payloads fail closed. Offline exception categories must be labelled according to server custody states, not grouped as automatically resolved or customer-refundable.

## Acceptance plan

Validate schema/scope, manager-role integration, initial failure, stale refresh, manual retry, actor/branch race, no zero on unavailable data, exact monetary labels, row truncation and working scope-safe navigation. Render synthetic 375/320/1280px flows and keyboard/focus states. A browser fixture proves presentation and interactions only; SQL isolation, real reports and merchant operations need independent verification. Production remains unchanged.


## Implemented scope and checks

`BranchOperations.tsx` validates the exact typed response and selected scope. LiveCounter exposes the read-only overview to any manager/owner branch, including before counter enrollment. Its branch selector never changes the selling branch, device binding or saved basket. Working shortcuts target existing same-bound-branch Reports, Orders & tables, Kitchen and current Shift; no remote-counter close action exists.

The single server snapshot supplies today’s issued-document amounts, all open-shift counts, recent 30-Dubai-day close totals, saved unpaid basket estimates, distinct kitchen ticket/batch counts and overlapping custody categories. Legacy missing close amounts remain Not recorded; a missing aggregate difference remains unavailable. Initial failure shows no totals; stale same-branch data is labelled and shortcuts disabled. A 401/403 discards cached data even when its body is malformed. Pending financial work does not prevent this read-only view, but existing workflow navigation guards remain.

Focused UI/integration checks passed 16 cases, including an unregistered manager, cashier-only exclusion, other-branch management without rebinding, exact money/unknown-local labels, missing amounts, truncation, stale refresh/retry, denial, wrong scope and delayed prior actor response. The existing live offers/open-order integration suites passed 20 cases. TypeScript passed; scoped ESLint has zero errors and only the existing LiveCounter image warning. Semgrep scanned the two UI runtime files with 210 rules and reported zero findings/errors. Rendered acceptance and fixture cleanup are recorded below after completion; these automated checks alone do not prove live restaurant data or production deployment.


The first independently reviewed desktop draft spent its initial viewport on controls and explanatory prose. This failed the daily-overview priority even though amounts were accurate. The revised layout combines branch/refresh controls, keeps a short offline-completeness limitation visible above sales, places the three sales totals before workflow shortcuts, and moves the full scope explanation into an accessible details disclosure after the amounts. The same information remains available without dominating the first screen. A scoped touch-size rule also prevents inherited counter styles from reducing Operations controls below the intended 48px.


## Final rendered verification

The corrected production preview included the actual counter stylesheet and synthetic read-only data. Reviewed desktop 1280×720, phone 375×812 and narrow phone 320×812. The effective client/scroll widths were 1265/1265, 360/360 and 305/305 respectively: no horizontal page overflow. All six Operations buttons/select controls measured 48px high. At desktop the three sales amounts occupied y488.19–527.19, visible without scrolling. At 375px, issued sales/credits occupied y735.81–770.31 and net y814.31–848.81; all amounts precede the full explanation and workflow buttons. The narrow layout keeps amount labels readable, stacks supporting values and opens the completeness disclosure.

The parent independently reviewed the final desktop screenshot and exercised Open reports into the existing Branch reports screen; the earlier stale-refresh flow retained old data with disabled shortcuts. Missing-amount and unenrolled flows are covered by synthetic fixtures and focused tests; no merchant data or device binding was changed. The initial preview omitted counter CSS and those initial screenshots were rejected, then regenerated with the actual styles. An earlier hierarchy also failed the first-screen usability review and was revised as described above.

Private evidence directory: `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/branch-operations/` with `desktop1280.png`, `branch-operations-ui-mobile375.png`, `mobile375-metrics.png`, `mobile320-metrics.png` and the retained synthetic fixture source. The temporary repository route was removed after review. The owned preview server and browser tab were closed and viewport reset; the final release build must run without that route. This is candidate UI acceptance, not production deployment, real financial confirmation, complete offline coverage or customer handover.

The parent also reviewed the final 375px evidence and accepted the readable, unstretched layout. A final text-only polish uses singular invoice, credit note, open shift, close, open order and recorded difference for a count of one; targeted UI/integration tests were rerun after that change. Screenshots precede only this grammatical correction; no layout or data behavior changed.
