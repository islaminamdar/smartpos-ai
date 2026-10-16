# Android cash drawer close — UI implementation

2026-10-16. Candidate work; no deployment, provider action, physical cash movement or production sales activation is established by this report.

## Flow and source of truth

The full Android App places **Close this cash drawer** after saved-record reconciliation and before next-allocation continuation. It automatically reads native local close metadata before enabling the counter. That local check never submits or retries a close. The explicit **Check drawer for closing** asks native code for current server status and original-scope Android PIN/confirmation. A first shift without a provisioned PIN uses native confirmation; JavaScript never accepts secrets or silently enrolls offline access.

The cashier enters actual counted cash in AED using a text/decimal input. The parser rejects exponent notation, negatives, separators and more than two decimal places rather than rounding. Confirmation is tied to the exact shift, amount, actor and setup revision. Native code persists the immutable command before sending; React does not create replacement command IDs.

A pending request displays its original saved count and references. There is no editable cash input. An explicit server check must confirm eligibility before **Retry original close request**, which passes only the original command ID. Lost close responses are followed by a read; there is no automatic write retry. A changed shift or command remains blocked. After a failure before persistence, only an explicit same-shift online check returning `ready`, `canClose=true` and no command ID can release the hold for fresh count entry. A local getter cannot release that uncertainty.

The completed result shows counted cash, expected cash and difference from the verified server result, plus Dubai closure time. It is not a local drawer estimate. Confirmed totals remain visible after the parent refresh. The existing next-allocation step is separate for a finished allocation; the empty-shift path may return to opening cash after native confirms closure. Neither path automatically opens a shift, moves cash or prepares another allocation.

## Custody and privacy

Pending close discovery independently blocks new payment creation/confirmation, new setup, enrollment and account changes. Historical payment read/cancel/freeze/manager-result recovery remain available, along with saved-record uploads and eligible terminal allocation finishing needed to clear obligations. Existing consent for receipt confirmation is cleared when the close hold appears.

The panel uses the same operation lock as the counter and other setup actions. Native lock/background clears visible count and result, resets consent and invalidates delayed results. Actor/revision changes invalidate online eligibility. Signed-out presentation retains only original shift/command metadata, even if a synthetic bridge supplies full amounts. Unknown reasons fail closed. A failed local state read preserves the close hold; an explicit successful check can recover it.

## Presentation and evidence

The panel reuses the existing Android type, colors, disclosure patterns, 48px controls and responsive cash-count form. There are no new visual frameworks or artificial financial examples in runtime code. The synthetic preview uses a separate temporary fixture that must be removed before the final asset build.

Rendered full-App review at 375px exercised invalid three-decimal input, exact AED123.45 consent, empty first-shift closure, retained server expected AED125.00/difference AED-1.55, and blank separate opening-cash setup. At 320px, pending locked metadata hid the saved count until explicit check, then allowed only the same-ID retry. At 1280px the completed reconciliation amounts and next steps were readable. Effective widths 360/305/1265 matched scroll widths; observed controls were at least 48px high.

Private evidence: `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/native-shift-close/`, including `mobile-375-count.png`, `mobile-375-closed.png`, `desktop-1280-closed.png` and `mobile-320-pending.png`. Browser fixtures verify presentation and interaction only. Actual native proof validation, server accounting, device upgrade/history retention and a supervised restaurant shift require their separate evidence.

## Automated verification

The final combined focused run passed 113 tests across drawer close, full Android App, Counter and next-allocation suites. A subsequent drawer-only run passed 17/17 after adding a direct delayed PIN/check response regression, covering 114 distinct relevant cases across those runs. Cases include exact money parsing and consent invalidation, no editable pending amount, initial pending discovery, failure/read recovery, authoritative absence after pre-persistence failure, original-ID retry, stale actor/background results, signed-out amount privacy, server-result display, no implicit next shift, and new-payment/confirmation blocking while historical review remains accessible. Native app TypeScript and scoped ESLint passed. Semgrep Community Edition scanned the 4 changed UI runtime files with 210 rules, 0 findings and 0 errors.

Parent independently exercised the full-App ready → AED123.45 explicit consent → verified closed AED125.00/-1.55 result at 1280px, confirmed the totals survived refresh, and reviewed the final 375px closed-result screenshot. The temporary repository fixture was removed after review; its private evidence copy remains. The owned port-3050 preview and browser tab were closed, with the viewport reset. A subsequent nonvisual boundary correction aligned the count parser with the native/server maximum of 100,000,000 fils (AED 1,000,000.00); exact maximum and one-fils-over tests were added. The reviewed layout is unchanged.

Final nonvisual corrections: the counted-cash cap now matches the native/server 100,000,000-fils limit, and next setup gives explicit saved-close guidance for `native_shift_close_pending`. The final drawer/next-allocation run passed 35/35 (18 drawer, 17 continuation), bringing distinct relevant coverage across the documented runs to 116 cases. Scoped ESLint and Android TypeScript passed again. One intermediate test-edit mistake referenced a parameter outside its test case; it was corrected before this passing rerun.
