# Same-staff local access recovery — design proposal

Initial design checkpoint: candidate `f78b99b`, 2026-10-16. The early proposals below are historical. The final PIN-only candidate implementation and verification are recorded at the end of this document; the combined clock-repair proposal remains unimplemented. Production Android sales remain paused. No deployment or customer release is established by this document.

## Reviewed implementation direction

Native and security review narrowed the first implementation to **PIN recovery for the original staff actor with a healthy authenticated clock**. Clock checking may explain a block; automatic clock repair is not approved by this design. Clearing the global clock block could make an old allocation usable again, so clock repair needs a separate retirement/fencing protocol. At that initial design checkpoint neither path was implemented.

The existing PIN credential scope covers the original organization, branch, device, actor, key epoch and installation; it does not include a shift. The proposed recovery freezes that exact credential scope, persists a candidate verifier and device-signed request in the authenticated PIN database before HTTP, then atomically replaces the verifier and saves an immutable acceptance audit in that same database. Financial records and allocation clocks are not changed. Successful recovery leaves the app locked until an explicit new-PIN unlock. The enrollment manager can differ from the cashier credential actor; server authorization must not confuse those identities.

The server/native wire contract remains pending. It must distinguish exact accepted-result retrieval from authorization for a new reset. An initial proof may expire before approval; a refreshed proof can only retain the same request ID and old/new credential commitments after an authoritative not-approved expiry response, never after an ambiguous network failure. Native must retain accepted proof versions. The metadata API below is an early UX proposal, not a frozen implementation contract.

## Operator flow

Add **Recover local access** in Device setup, close to the existing access/preparation controls. Do not place it beside receipt confirmation as an alternative way to finish a doubtful payment. Explain that recovery needs internet, the original enrolled staff account and Android confirmation, and keeps all bills, payment records and invoice limits.

Present two explicit purposes: **Reset forgotten or locked PIN** and **Check device time**. Their availability must come from native state; a clock issue must not invite repeated PIN guesses. Android alone collects the current account password and new PIN/confirmation. The web layer receives neither secret. Do not promise that a manager can reset another cashier’s access or that a new account can claim this counter.

| State | Screen/action |
|---|---|
| Available | Explain purpose and preserved limits; explicit consent for the original counter and recovery purpose, then Continue in Android. |
| Waiting for native dialog | Disable duplicate actions and shared setup/payment mutations; Android handles cancellation. |
| Pending or lost response | Saved recovery needs checking. Show safe reference only. Check saved status first; never change purpose or create another request. |
| Exact pending retry allowed | Fresh consent for the same native-owned request; Retry saved recovery. No browser-generated replacement ID. |
| Completed | Local access recovery saved. Recheck setup/payment status; original bill permission may still be expired and new sales remain paused. |
| Blocked/unknown | Preserve records, explain known cause or generic unavailable state; keep historical upload and exact payment-result recovery accessible. |

Pending recovery must be discovered before enabling new setup or payment work after restart. Sign-out/account/enrollment changes cannot orphan the request. Read-only checks must not perform automatic reset, renewal or time repair. A native lock/background event clears consent and visible completion details, invalidates delayed responses and requires a fresh state read. Cancelling a dialog does not mean a request was cancelled: read native state after cancellation or any error.

## Proposed metadata bridge, pending native agreement

`getNativeAccessRecoveryState()` is local/read-only. Suggested result: `{schemaVersion:1,status:not_needed|available|pending|completed|blocked,kind:null|pin|clock,requestId:null|uuid,actorId:null|uuid,reasonCode:null|string,canStart:boolean,canRetry:boolean}`. Native eligibility may need distinct capability fields for PIN and clock; do not infer them from one generic `available` state.

`beginNativeAccessRecovery({kind})` opens native credential/confirmation dialogs and persists the exact recovery request before network submission. `retryNativeAccessRecovery({requestId})` reuses its native saved body. Only a validated read or result for the exact original scope/request may resolve the UI hold. Missing/unknown responses do not authorize another identity. No proof, new PIN, password, browser clock or authority limit is an input to JavaScript recovery.

Before implementation, agree whether recovery rotates one original-shift credential or every retained credential for the same actor/device, how a clock recovery covers all retained authority clocks without extending them, and what server/native completion proves. A completed security repair does not clear an uncertain payment, seal an allocation, acknowledge an upload, close a shift or grant another invoice range. Existing historical data stays readable/verifiable under its original policy; no rewriting signed records.

## Presentation and acceptance

Reuse current calm device-setup layout: one primary action, stacked labels on 320/375px, 48px controls, no exposed cryptographic payloads, and a collapsed support reference. Keep the status summary near its action so mobile staff do not scroll between a warning and consent. Desktop remains a readable constrained panel, not a dense settings dashboard.

Required tests once implemented: same-original-actor enforcement, native-only secret entry, different actor/branch and unknown-state refusal, exact request restart/lost-response recovery, cancellation after persistence, old async response after background, pending hold before counter readiness, historical uploads still usable, unchanged receipt/intent/authority limits, and truthful completed-but-expired/paused states. Render phone and desktop using synthetic fixtures. Browser verification cannot establish native PIN storage, cryptographic repair, device-clock correctness or merchant acceptance.


## PIN-only implementation slice following f63c248

The current bounded slice is **Recover forgotten PIN** for the same original enrolled staff account, with a healthy device clock and internet. Global clock repair remains a separate unimplemented workflow; the panel must not offer PIN reset as a clock repair. This section supersedes the earlier combined `kind: pin|clock` proposal for this slice only. The native metadata contract is now frozen and the candidate UI is implemented in `apps/android-pos/src/NativePinRecovery.tsx`. See `docs/contracts/20261016-native-pin-recovery.md` for the actual native/server protocol.

Place the panel after account access and before offline preparation, so someone unable to unlock can find recovery without passing through new-sales controls. Native Android dialogs collect the current account password, new PIN and PIN confirmation; there are no JavaScript password/PIN fields, stored drafts or browser proofs. Start, pending, server-approved-awaiting-local-apply, completed and blocked states must be distinguishable. A native-approved result may still require explicit foreground application; it is not already a working new PIN. Successful application keeps the app locked and instructs staff to unlock with the new PIN. Saved bills, unresolved payments, original shift scopes, expiry, invoice ranges and budgets are preserved.

PIN recovery must remain reachable when an original saved payment is itself blocked by forgotten credentials. Native policy, not a generic UI financial-hold check, decides whether that exact recovery is eligible. Pending reset prevents new setup/enrollment/sign-out/collection and receipt confirmation, while signed historical uploads and original result review remain available. Original-account sign-in must remain possible where required. Local status discovery precedes new-work readiness after restart; failure stays held until an explicit successful read. A lost response does not permit another PIN or request identity. Native lock/background invalidates consent and suppresses late callbacks. The frozen contract allows a later independent recovery only when native returns completed with canStart=true; the UI requires new consent and a separate Recover PIN again action.


## Implemented candidate UI and review evidence

The strict JavaScript bridge exports `getNativePinRecoveryState()`, `startNativePinRecovery()` and `retryNativePinRecovery(requestId)`. The seven metadata fields are schemaVersion, status, requestId, canStart, canRetry, passwordRequired and reasonCode. The exact status family is not_available / ready / pending / approved / completed / blocked. Unknown fields, malformed identifiers and unknown reasons are rejected. Pending and approved require a saved request ID; retry rejects a response for any different ID. Completed retains its reference without retaining a pending hold.

The panel only collects a checkbox. Password and PIN values never enter React, browser storage, a JavaScript recovery draft or the metadata interface. A failed mutation performs a local status read, not an automatic network retry. The original saved ID remains held if a later read is missing or different. Native lock, hidden-document and pagehide events clear consent, mark status stale and invalidate late responses across account/revision changes. Initial PIN discovery is ordered after existing drawer discovery, avoiding a shared-lock race when immediate reads are batched. Counter readiness waits for discovery, but not for a resolved pending hold: existing payment reads/results remain available with new collection and receipt confirmation blocked.

The completed screen says the new PIN is saved and the counter remains locked. It does not claim renewed authority, changed invoice limits, repaired time, completed payment, allocation finish, closed cash drawer or enabled production sales. Pending signed-out lookup remains possible where native advertises it; application of the saved approval still requires native eligibility under the original account. Other setup panels use generic saved-payment-or-setup guidance rather than incorrectly directing every PIN hold to payment review.

Verification on 2026-10-16:

- 148 scoped UI/bridge/App/Counter/next-allocation/drawer tests passed after final hold-copy changes. The added actual-Android-output case then passed with all 16 bridge/parser tests, bringing the scoped count to 149. Four App tests specifically cover initial pending holds, original-account sign-in while enrollment remains blocked, failed discovery with explicit read recovery, and completed-new-PIN-locked state after parent refresh.
- Strict parsing accepted actual Android ready/pending/approved/completed metadata in `tests/unit/pos/fixtures/native-pin-recovery-android-output.json`; this does not establish hardware or customer acceptance.
- App TypeScript and scoped ESLint passed. Final scoped Semgrep ran 210 rules across all seven changed runtime UI/bridge files, including hold-copy panels: zero findings, zero errors and full parsing.
- Actual React App plus strict bridge parsers was rendered with synthetic native responses at 375×812, 320×812 and 1280×720. Document scroll/client widths were respectively 360/360, 305/305 and 1265/1265 (scrollbars account for the difference). PIN buttons measured 48px tall. References wrapped; no horizontal overflow was observed. Checked ready consent, original pending→approved→fresh consent→completed, completed locked copy and clock-blocked explanation.
- Parent independently reviewed the full App lost-response→same-ID pending→approved→completed flow and verified saved-record upload stayed available, receipt count remained visible and new-PIN unlock was separate. Browser fixtures do not test actual credential dialogs, encrypted storage, PIN derivation, server authorization, physical Android behavior or production configuration.
- Private screenshots/metrics: `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/native-pin-recovery/`. Temporary repository fixture removed, owned Vite port3050 stopped, owned Chrome review tab closed and viewport reset. No customer data or production writes were performed by this UI task.
