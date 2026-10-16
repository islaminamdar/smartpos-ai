# Controlled next allocation — UI plan

2026-10-16. Implemented candidate; production enablement remains pending. No deployment, production sales activation or financial record changes are implied.

## Inspected gap

The current native app can prepare a signed allocation, finish it, upload receipts and upload its seal. `OfflinePreparation` then displays `offline_allocation_finished` with no next action. `ReconciliationPanel` exposes aggregate counts, which cannot prove that the particular prior allocation is confirmed and safe to replace. Its finishing text correctly says finishing does not close the cash shift or prepare another allocation. That distinction must remain.

The next action must use an authoritative native status for the exact prior allocation and shift. It must not infer eligibility from zero pending counts, reset retained records, silently reserve another invoice range, or substitute a new request after a lost response. New sales remain disabled by the independent production gate.

## Proposed interaction

A single **Next invoice allocation** section follows saved-record reconciliation. Reuse the established Arial type, navy text `#17324d`, blue action `#175cd3`, pale background `#f4f7fb`, white surfaces and subtle border `#dce3eb`. Keep left-aligned prose, existing 48px controls and a single-column phone layout. No new decorative cards, animation or dashboard metrics.

1. Read native state. If the original allocation or payment still needs confirmation, explain that specific hold and point to the existing saved-record/payment review area.
2. Show the original allocation reference and shift, with explicit wording about whether the same shift will continue. Do not expose financial details outside original native actor/PIN scope.
3. Require a fresh checkbox tied to the exact prior allocation, shift, current actor/scope and immutable request. The action describes exactly whether it advances setup or actually prepares a new signed allocation; final wording depends on the agreed native transition.
4. Persist/replay the same request in native storage. Show a busy state and block competing preparation, sign-out, enrollment, allocation finishing and payment actions through the shared operation lock.
5. On uncertainty, read the saved transition first. An explicit retry uses the saved identity and unchanged parameters. Never silently start another allocation.
6. On exact completed readback, refresh existing preparation and reconciliation. Retain all historical bills/results. Continue to display **New sales paused** until native readiness and the production gate actually authorize selling.

Same-shift continuation is preferable for the first bounded increment. Closing a cash drawer and opening another shift require their own explicit amount/reconciliation contract; the UI must not imply those actions occurred.

## Required native evidence

Native read state must identify the exact prior authority and shift, whether its seal is confirmed, any payment/setup/request hold, a stable pending transition identity, and the completed successor if any. The native implementation decides eligibility; unknown states fail closed. React must not authorize from aggregate reconciliation counts.

## Verification plan

Tests will cover eligibility and unknown-state rejection; consent reset on exact scope or prior authority changes; shared operation lock; uncertain action followed by same-request read/retry; restart discovery; stale result after native lock/background/scope change; payment/setup holds; successful readback refreshing setup without enabling sales or deleting history. Render the actual app using only a synthetic bridge at 375px and 1280px, plus a narrow overflow check. Browser fixtures cannot establish native cryptographic acceptance or physical counter readiness.

## Frozen implementation contract and cashier limit

Implemented state is `{schemaVersion:1,status:not_available|ready|pending|completed|blocked,previousAuthorityId,shiftId,nextShiftId,reasonCode,canContinue}`. The explicit native action receives only the original authority ID; durable native replay owns its identity. No JavaScript request ID or new allocation is created. Completed `nextShiftId` equals the old shift for continuation, or null for an already-closed original shift. An explicit, separately consented **Check shift status** can request fresh signed evidence after a completed same-shift handoff; it cannot close any drawer.

The Android-owned cash drawer cannot currently be closed by the browser counter because the browser has a different device binding. The UI explicitly states that closing this Android drawer is unavailable in this version. Same-open-shift continuation is implemented; a complete practical end-of-shift workflow remains a release gap until native drawer closure is added. Do not direct users to the website to perform this unsupported action.

## Implemented UI and review

`NativeNextAllocation` is integrated after saved-record reconciliation in the full Android App. Local checks are explicit and never write. Exact allocation/shift/actor/revision consent, native lock subscription, stale response suppression and the shared operation lock guard continuation. A retained uncertain handoff blocks account/setup/finish/recovery mutations while preserving read/retry. Original account sign-in remains available when needed. Completed same-actor feedback survives the parent setup refresh, with further actions requiring a fresh local read. No state is inferred from aggregate upload counts.

Pending or accepted historical payment review now uses the original payment ID and native historical PIN unlock, including accepted-result metadata from an older shift. The normal preparation unlock remains for a context with no saved payment/result. No unlock is offered before the device has returned its checkout metadata.

Synthetic full-App browser review exercised consent, continuation, lost response followed by exact local completed readback, same-open-shift handoff and a server-closed original shift. Requested viewports 375px, 1280px and 320px had effective content widths 360, 1265 and 305 respectively, with matching scroll widths and no horizontal overflow. Action controls measured 48px or taller. Parent review identified and corrected unsupported website drawer-close advice and disappearing completion feedback. The screen now explicitly states that Android drawer closure is unavailable in this version.

Private screenshots are under `/home/islaminamdar/.local/state/codex-tasks/restaurant-pos-2026-10-16/native-next-allocation/`: `mobile-375-completed.png`, `desktop-1280-completed.png` and `mobile-320-closed.png`. Synthetic browser evidence establishes presentation and interactions only; it does not establish native signature validation, real staff authentication, physical cash movement or release readiness.

Final verification: 16 next-allocation component tests and 37 full-App tests passed; the Counter suite passed all 39 cases after adding original-ID historical unlock, late-lock suppression, mismatched-ID rejection and initial-metadata unlock guards. The combined run passed 91 before the last added guard regression; the final Counter-only run passed 39, so all 92 relevant cases were covered across those runs. Native app TypeScript and scoped ESLint passed. Semgrep Community Edition ran 210 rules across the 3 UI runtime files with 0 findings and 0 errors. The first two new historical-unlock tests exposed an early-click path before metadata read; the UI now disables that unlock until the original metadata or retained uncertainty identity is known, and tests verify the guard.

Parent independently reviewed final 375px/1280px screenshots and the full-App same-open-shift completion. The repository fixture was removed; a private copy was retained with evidence. The owned 3050 preview was stopped and no listener remained. The owned Chrome tab was closed and viewport reset. No production or customer records were changed, and no separate commit was made by this UI task.
