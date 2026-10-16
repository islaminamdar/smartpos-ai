# Native cash-drawer close

Candidate only. SQL017–023 and matching server/native changes are not deployed to the online pilot. Android production sale issuance remains disabled; this increment is not a customer APK release or a declaration that the full POS goal is complete.

## Explicit operation

The Android screen reads saved close state locally first. **Check drawer for closing** checks the original authenticated actor, branch, device and shift online, using the original native PIN when one exists. A first empty shift before offline PIN/allocation setup instead uses explicit native confirmation and the current authenticated device actor. JavaScript never receives the PIN.

The operator enters actual counted cash in AED with at most two decimals and a maximum of AED 1,000,000.00, then confirms the displayed amount and original drawer. The native implementation persists one exact close command before sending it. Active allocations, unuploaded custody or unresolved payments prevent a new close. The shared operation lock and pending-close hold also prevent account/setup changes and new collection/receipt confirmation; historical review and uploads remain available to clear obligations.

SQL023 supplies current context and exact historical lookup. Execution continues through the existing bound, serialized `pos_execute_live_command`; it does not introduce a second close ledger. The server signs challenge-bound results with original scope, command identity and request hash. Android verifies the signature, freshness and exact request before displaying counted cash, expected cash, difference and closure time. The displayed accounting result comes from the verified server response, not a local estimate.

## Uncertain response and restart

SQLite v7 appends immutable request, signed outcome and setup-transition records. A missing response keeps the original amount and command. The UI offers **Check close result** first, never an editable replacement amount or automatic retry. Historical lookup may retrieve the original committed result even after current authority is unavailable; it never executes or cancels an absent command. An explicit retry uses only the saved command identity and the native saved body, after current readiness permits it.

If failure occurred before native request persistence, only an explicit authoritative same-shift check showing no saved command can release the local uncertainty and allow a fresh count/consent. A local getter alone cannot do this. Unknown or contradictory results remain held. Lock, background and account changes remove cash details and invalidate delayed responses; original identifiers remain available for recovery.

## After verified closure

An empty shift with no allocation can archive the exact setup transition and return to the separate opening-cash flow. A shift with an allocation preserves its history and requires the existing **Continue setup** handoff after confirmed upload/seal obligations. Neither closure nor handoff automatically opens another shift, reserves invoice numbers, prepares an allocation or enables sales. **Check close result** remains available after closure to complete an interrupted local setup update without repeating the financial command.

## Verification and release boundary

[UI evidence](../../docs/design/2026-10-16-native-drawer-close.md) records synthetic 320/375/1280px reviews, exact-count consent, lost-response handling, privacy and parent-refresh behavior. Native proof/storage, database concurrency and HTTP tests have separate evidence owned by their implementing reviewers. Browser fixtures do not prove Android hardware behavior or real cash handling. Production migration/route approval, signed APK distribution, complete two-device offline/reconnect acceptance, physical printer acceptance and a supervised manager shift remain separate requirements. No customer release is authorized by these checks.
