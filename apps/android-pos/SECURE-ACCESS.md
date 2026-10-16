# Native staff access candidate

This candidate adds Android-owned staff sign-in, an encrypted session vault and explicit counter enrollment. It is not yet released to the restaurant. Offline sale issuance remains disabled. The preparation bridge can explicitly open a shift after the operator confirms its opening cash; it cannot issue a sale or record a payment.

## Credentials and transport

`NativeLedger.signIn()` opens an Android dialog. The JavaScript caller cannot pass or read the email/password fields. The password field is masked, excluded from saved view state/autofill, and shown in a secure window; native character buffers are cleared on cancellation, completion or failed work submission. The password necessarily exists temporarily as a Java string for the HTTPS request. No password is written into the session vault or logs.

The session vault is an AtomicFile in Android's no-backup directory, encrypted with a nonexportable Android Keystore AES-256-GCM key and a fixed authenticated format identifier. A missing vault with a surviving key, missing key with a surviving vault, failed authentication, or oversized file fails closed. Sign-out retains the counter identity, opaque binding, pending enrollment and all financial custody. These are not factory-reset tools.

HTTPS is restricted to the fixed `https://pos.internext.info` origin and an explicit method/path allowlist. Platform TLS verification remains enabled. Redirects, global Java cookie handlers, unexpected content types/encodings, malformed UTF-8, duplicate JSON fields and oversized bodies are rejected. Native session cookies are not copied into WebView storage. Cookie rotations are saved before response-body parsing so a truncated response does not discard a rotated token. Connect/read timeouts are 15 seconds; additional elapsed-time checkpoints bound streaming body reads. This is not a strict total deadline for a server that trickles headers inside the platform connection call.

## Recovery and custody

The native session owner serializes access. Access responses must match the authenticated actor, allowed branches and retained counter identity. Once enrolled, this installation uses the original actor; a different account cannot silently adopt its records. Controlled staff handoff is future work.

Before the first enrollment POST, Android persists a cryptographically random 32-byte binding and the exact actor/branch/name request. The server passes its SHA-256 hash to the existing transaction-locked `pos_enroll_device` function. A lost response is recovered by the next access read, or an explicit retry with the same binding and request. A pending request cannot be retargeted to another branch/name, and a revoked binding is never replaced automatically.

The HTTP route checks active manager/owner membership. The existing SQL function independently checks current actor and active branch membership and serializes binding reuse; its existing authorization is not a new atomic manager-only policy. Offline key registration and authority issuance have separate server checks and are connected through the native preparation coordinator.

Sign-out saves its intent before contacting the server. Locally the UI then reports signed out, even if the network fails. It retains only the encrypted material needed to retry remote sign-out and offers **Finish sign-out**. New sign-in is blocked until that explicit recovery completes. A process killed between login cookie delivery and actor validation is treated the same way; the app does not adopt an unidentified session.

## Validation boundaries and remaining work

Unit tests cover server membership filters, scope changes, strict route methods/origins/bounds and persisted binding use. Android instrumentation uses synthetic HTTPS responses with real Android Keystore, AtomicFile and SQLite, including lost responses, token rotation, actor mismatch, malformed payloads and deletion/corruption. Native dialog inspection is performed on the isolated QA emulator without merchant credentials or live enrollment. These checks are not live endpoint acceptance or a full platform security audit.

`NativeStaffUnlock` and `NativeClockSource` provide the separate internal local-PIN and OS-clock implementations described in `LOCAL-UNLOCK.md`. Their provisioning is connected through a native-only PIN confirmation dialog after verified online identity and device enrollment. Sign-out and backgrounding lock the guard. PINs and trusted clock readings cannot be supplied through JavaScript.

The preparation candidate verifies challenge-bound signed context and prepared handoffs against bundled server public keys. It persists exact shift, key-enrollment and reservation requests before submission, verifies the returned menu and authority, and anchors trusted time using native elapsed time. Encrypted vault schema 2 adds preparation state while retaining existing session and counter custody. Status reads do not make network requests.

Still required before offline release: native sale/payment/recovery UI, missing-bundle retrieval after access removal or issuance disablement, subsequent-shift renewal, controlled PIN/clock recovery, real two-device restart/reconnect tests, printer testing and supervised manager acceptance. The matching server signing key and endpoints are not yet deployed. The server SQL017 candidate must not be applied merely because this native preparation increment passes.

Historical uploads, explicit terminal declarations and definitive enrollment-proof recovery are now connected in the candidate. See [RECONCILIATION.md](RECONCILIATION.md) for their evidence boundaries and remaining release gates.
