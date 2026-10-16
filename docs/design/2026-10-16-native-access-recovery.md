# Same-staff local access recovery — design proposal

Checkpoint: candidate `f78b99b`, 2026-10-16. Design only; no new runtime API, native mutation, deployment or enablement is established here. Production Android sales remain paused. The existing App uses a shared native operation lock and distinct custody holds; preparation currently directs PIN/clock failures to support. `LOCAL-UNLOCK.md` and the native clock policy deliberately have no general reset path.

## Reviewed implementation direction

Native and security review narrowed the first implementation to **PIN recovery for the original staff actor with a healthy authenticated clock**. Clock checking may explain a block; automatic clock repair is not approved by this design. Clearing the global clock block could make an old allocation usable again, so clock repair needs a separate retirement/fencing protocol. Neither path is implemented yet.

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
