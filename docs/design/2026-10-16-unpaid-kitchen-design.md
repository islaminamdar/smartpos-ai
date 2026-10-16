# Kitchen dispatch before payment

16 October 2026 · UI/UX Specialist · model runtime-selected/not exposed

## Design

Saved orders can be explicitly sent to the kitchen before payment. The dispatch panel compares the current saved order with the last dispatched snapshot, previews quantity/name/unit/table/note changes, and requires confirmation. A dirty counter basket cannot be sent. A server check of the saved revision and preparation content controls payment readiness: unsent preparation changes block payment, while price-only changes do not repeat kitchen work. Cancelling and reopening a draft does not silently restart preparation; a manager must dispatch a new preparation round with a reason.

The new kitchen board is separate from the earlier paid-sale projection and its request journal. Each ticket keeps one identity through dispatch, amendments, payment and refund. A payment badge is distinct from preparation. Four quantity groups show Queued, Preparing, Ready and Served. Eight served items plus two added items remain eight served and two queued. Progression moves the entire named group; served requires handover confirmation and a backward correction requires a manager reason.

The existing Arial/navy/blue counter style remains. Two ticket columns on desktop stack on phones. Quantity groups wrap to two columns and then one at narrow widths. Controls use a minimum 48px height; written status and prominent notices complement colour. Order label, table, guests, notes, first-sent time, preparation round and invoice (once paid) provide operational context without prices or payment data in kitchen content.

## Notices and recovery

Initial dispatch, amendments, voids and refunds create immutable notices. A ticket remains active while any notice is pending, including previously served or cancelled work. The operator reviews an exact consecutive page of up to 20 notices, including previous/current content and withdrawals by preparation stage, and explicitly confirms review. Acknowledgement binds the ticket revision and the last displayed sequence. Later notices remain pending and preparation stays blocked. History pages are read-only and cannot acknowledge unseen content.

Stop notices say to stop preparation and check with the counter if food is already prepared or served. Acknowledgement records review; it does not undo prepared food, issue a refund or claim a physical ticket was printed.

The separate actor-and-branch journal stores exact commands before sending, uses atomic add across tabs, preserves original device identity for recovery and clears only a matching canonical acknowledgement or cancellation. Parent adoption runs before storage clears. Pending and storage-error states block normal actions. Cancellation consent is request-specific. Recovery can discover the original actor and branch without a current device/bootstrap result. Existing legacy kitchen journals remain untouched.

Visible-only polling avoids overlapping reads, invalidates earlier requests around writes and retains stale snapshots with disabled actions when refresh fails. Notice review rejects a different scope, missing sequence prefix or a ticket revision newer than the current board snapshot.

## Verification

Local automated verification: 27 UI interaction tests and 3 real Chromium IndexedDB tests passed. TypeScript and scoped ESLint passed. Scoped Semgrep ran 210 rules over 8 owned source files with zero findings before the final payment-readiness loading guard; the release owner repeats the final combined scan. Tests cover served-plus-added quantities, explicit dispatch, canonical storage order, exact prefix acknowledgement, missing/newer prefixes, cancelled prepared work, payment identity, stale state, manager controls, immutable retries, original-device recovery, request consent reset, actor isolation, two-tab atomic storage, payment readiness during an in-flight refresh and parent callback failure.

Rendered review completed against the local production build at `http://127.0.0.1:3049/counter`, with synthetic same-origin responses and real browser IndexedDB. Desktop 1280px, mobile 375px and narrow mobile 320px were reviewed. Final board document widths were 1265, 360 and 305px respectively, with no horizontal overflow and no visible button shorter than 44px. Final screenshots confirmed readable cancellation withdrawals, a two-column desktop board, stacked mobile quantities and the revised notice-panel padding. The final homepage was also checked at 1280px and 375px without overflow; its kitchen description states before-payment dispatch and additions without repeating served food. The release owner independently reviewed the final desktop board, 375px board and 320px refund notice.

Interactive browser cases included served 8 plus queued 2, acknowledging the first 20 of 22 notices while retaining the last 2, a lost stage acknowledgement recovered from the original journal entry, adding 2 items to a saved order and blocking payment until dispatch, a lost dispatch acknowledgement recovered without duplicating queued work, and a simulated unpaid-to-paid transition retaining one ticket and its preparation quantities. A refunded cancelled order remained active with explicit withdrawals from served and ready groups. Failed polling retained the last board and disabled actions. The loading-readiness guard is additionally covered by the dedicated unit regression.

Final journal readback contained zero unresolved commands. The dedicated test tab was closed, fixture interception was removed through navigation, and the temporary browser viewport was reset. Synthetic fixtures verify rendering and client interaction; they do not verify production authentication, database transactions, printers, physical preparation, live card charging or Android hardware. Those server and release checks remain owned by the release workflow. No production actions were performed by the UI/UX Specialist.
