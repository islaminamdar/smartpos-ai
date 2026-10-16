# Native manager outcome retrieval

Candidate implementation dated 16 October 2026. SQL017–021 remain unapplied in production; native sale issuance and hosted manager decision writes remain disabled. This contract records implemented custody behavior, not customer release acceptance.

## Historical device proof

`POST /api/pos/offline/payment-freeze` accepts the original immutable freeze envelope plus a separately device-signed query. `POST /api/pos/offline/payment-resolution` accepts that query alone. The native recovery button re-registers the exact original freeze on each explicit retry, covering an interrupted first submission. Every attempt uses a new 32-byte random challenge. JavaScript supplies only the saved intent ID; native code owns the keys, envelopes, endpoint and challenge.

Historical requests neither send nor adopt session cookies. The service verifies the original signed allocation, enrolled public-key fingerprint, device signature, epoch, freeze ID and proof hash before calling the case reader. Current login, membership, sale flags and grant expiry do not invalidate possession of existing records. They still govern new activity elsewhere. Request limits are 1,420,000 bytes for registration and 16,384 for retrieval; responses are limited to 1,420,000 bytes. Limits apply to streamed bytes as well as declared lengths. Responses are private and not cached.

## Authoritative server result

SQL021 adds a service-only reader under the existing financial lock order. It returns the original proof and one of pending, resolved or conflict. Exact historical raw-proof conflicts remain conflicts. A recorded attestation with an interrupted signature stays pending until its signature can be attached. Recovery may finish that attachment but cannot create a manager decision. The service reads again under locks afterward so a newly recorded contradiction outranks the old result.

The service verifies the stored freeze and historical basket arithmetic, all original identities/hashes, manager identity, full tender evidence, completion timestamps, drawer scope and result signature. It signs `native-payment-resolution-status`, binding the current challenge and exact original freeze to its result hash. This handoff has purpose `reconciliation-only`; it cannot reset a clock, renew an allocation or authorize selling. Existing independently verified invoice evidence from registration is retained as a contradiction, not imported as a new native receipt.

## Native acceptance

SQLite version 5 adds immutable result, status and conflict custody. The engine verifies the original freeze, pinned server signature, challenge, scope, result hash, decision and tender before committing. Repeated signatures for the same outcome preserve the first accepted response. Authenticated contradictory outcomes or later conflicts create a durable hold; wrong proofs or challenges are rejected without manufacturing an authenticated conflict. A conflict for an older intent also blocks committing a newer already-prepared intent.

No acceptance path changes the original intent request, freeze, financial receipt, acknowledgement, outbox, invoice sequence, chain or selling clock. An accepted full return or card void is a manager attestation of an external event. The app does not refund a card or move cash. It never relabels the payment as never collected, issues a replacement bill or reopens permission.

Historical custody can finish while signed out or locked. Displaying the basket or outcome still requires the original account/allocation and native PIN, and is subject to the foreground lifecycle guard. The bridge exposes a separate `lastResolvedIntentId`/`lastResolvedIntent`, never a fabricated receipt. Locked views retain conservative recovery references and hide payment details. The browser manager view uses `nativeDelivery: not_confirmed`: this implementation has no device-delivery acknowledgement back to that screen.

## Verification and remaining acceptance

Tests cover real Android SQLite/Keystore acceptance, concurrent writers, immutable evidence, genuine v4 migration, wrong proof/key/scope/challenge, late contradictions, interrupted responses, original records and locked display. Actual synthetic Android bridge output is checked by the TypeScript parsers. Independent PostgreSQL tests exercise permissions and observed lock waits; service tests use real P-256 signatures and disposable PostgreSQL, with authentication transport mocked. UI fixtures cover phone and desktop states. These are bounded checks, not a full platform audit.

Still required before customer offline use: full two-device native/server journeys through offline operation, reboot and reconnect; controlled next allocation and shift; PIN/clock/staff/device-loss recovery; approved manager policy and accounting treatment for unresolved retained funds; production signing/update preservation; physical POS/printer and supervised manager acceptance. No provider refund, physical cash return or successful restaurant shift is established by synthetic tests.
