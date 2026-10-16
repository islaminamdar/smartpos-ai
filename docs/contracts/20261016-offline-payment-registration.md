# Offline payment registration candidate

This implements the custody prerequisite of [manager payment resolution](20261016-offline-payment-resolution.md). It does not resolve a payment or enable offline selling. SQL017 and SQL018 are candidate migrations, not live changes. There is no registration HTTP endpoint, manager decision writer, native upload bridge or terminal-result acceptance in this increment.

## Database custody

SQL018 preserves SQL017 unchanged and adds private, RLS-enabled, append-only claims, freezes and conflicts. Existing offline receipts backfill a globally unique payment-intent/order/document claim; inconsistent history aborts the migration. Claim creation occurs inside the same rollback boundary as an imported financial record.

New freeze/import writers acquire payment-intent advisory lock 31 before original-order lock 0, then device, shift, key epoch and authority row locks. Document identity lock 32 follows those locks. Normal order/document/cancellation writers have insertion guards. Preserved SQL017 implementations remain private; service-role callers cannot invoke the renamed functions to bypass the new guards.

Registration independently validates canonical bytes, original signed-bundle hashes, exact scope/request, quantities, historical prices, tax arithmetic, buyer requirements and planned cash/card tender. This is defense in depth: the service must first verify the signatures using the enrolled historical device key. SQL does not perform ECDSA verification.

If registration wins, a later contradictory invoice cannot create financial records. If a matching original invoice already exists, its original issuance envelope, receipt and acknowledgement are returned for independent service verification; the contradictory freeze remains recorded. Cross-scope collisions disclose no foreign receipt and hold only the incoming evidence's scope. Changed freeze identities, malformed authenticated evidence and conflicting delayed imports remain durable records rather than silent replacements.

All frozen cases and contradictions are unresolved holds in this foundation. They block shift closure, new grants and new seals; previously committed receipt/ACK and seal replay remain recoverable. No generic clear, delete, resolved flag or automatic expiry removes a hold.

Service-only interfaces:

- `pos_offline_payment_freeze(p_envelope)` returns `registered`, `conflict` or `already_issued`. Exact payload replay preserves the first stored envelope despite different valid ECDSA signatures. Registration reports whether the authority has contradictions.
- `pos_offline_payment_case(p_authority,p_freeze)` returns only a matching historical case. Conflict summaries are the latest 50 in deterministic order, with `conflictsTruncated`; the immutable evidence ledger retains the rest. A future HTTP manager caller still needs current authenticated authorization.

## Signed service status

`registerOfflinePaymentFreeze` verifies the original freeze and separate fresh query using `verifyOfflinePaymentFreeze`, then calls SQL018. It rebinds the returned authority, freeze ID/hash and payment intent before signing a response.

For `already_issued`, it verifies the original device-signed issuance against the stored historical bundle, independently recalculates the original invoice, compares every frozen identity/basket/tender, and verifies the exact original server acknowledgement. A plausible database row alone cannot become a signed already-issued status.

The handoff is `native-payment-resolution-status`, purpose `reconciliation-only`, bound to the current query challenge, original authority/key epoch/device and freeze ID/hash. Supported states are only `pending`, `conflict` and `already_issued`. `resolutionSha256` is always null. Only already-issued status has an issuance hash and paired original receipt/ACK. Unknown or terminal manager outcomes are rejected. The status is not a selling grant and must never reset an authority clock or clear a native freeze.

Response size is capped at 1,420,000 UTF-8 bytes. Individual signed payloads retain their protocol limits; duplicated reader wrappers are not treated as one signed payload. Tests include a large historical catalogue and a 200-line invoice with maximum-length multibyte product names.

Active signing configuration is checked before registration. A failure after SQL commits can leave custody saved but its response undelivered. The next attempt resubmits the same immutable freeze with a fresh query; it never repeats a charge, refund or manager decision. Native must keep its local hold until a future separately implemented terminal result is verified and durably stored.

## Verification and limits

Automated evidence covers actual PostgreSQL 16.15, independent sessions with observed lock waits, migration/backfill preservation, import/freeze in both orders, online order/document/cancellation collisions, cross-tenant identities, shift-close and renewal races, revocation/expiry, ACL/RLS and immutability. SQL-boundary tests intentionally use synthetic envelope signatures; separate actual-P256 production-service integration covers cryptographic verification and the real database together. Shift-close concurrency exercises the actual database guard through a synthetic competing shift update.

The unit suite checks signature/key/identity substitutions, mismatched ACKs, altered receipt/basket/tender, unknown status/schema fields, stale/changed query identity, signing interruption after registration, hidden conflicts and response bounds. These checks do not prove physical collection/return, customer hardware or manager acceptance.

An existing text-contract limitation remains a release gate: native/TypeScript buyer text can contain embedded U+0000, which PostgreSQL JSONB cannot represent. Such evidence fails decode without financial mutation; it is not reported registered. Before offline enablement, explicitly reject unsupported new inputs and define preservation/recovery for historical signed evidence. Never silently remove characters or rewrite its authenticated bytes.

Next work is current manager authorization, exact reviewed return/void evidence, serialized decision storage, signing/attachment recovery, HTTP limits and release gates, and native challenge-bound result acceptance. Retained-funds invoicing needs the separate accounting decision and implementation. Two-device end-to-end acceptance, physical printing, signed update preservation and supervised branch handover remain outstanding.
