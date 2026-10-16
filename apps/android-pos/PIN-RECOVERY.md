# Original staff PIN recovery

Candidate implementation, 2026-10-16. This recovers a local Android PIN; it does not change the account password, repair the clock or authorize new sales. The customer APK and server migration025 are not deployed.

In Device setup, **Recover forgotten PIN** checks the local saved status first. The original staff member confirms recovery and enters their current account password plus the new PIN twice in a secure Android dialog. Passwords and PINs never pass through the JavaScript bridge. The original device signing key, authenticated credential store and healthy device clock must still exist.

Before contacting the server, Android saves the candidate credential and original credential commitment in its authenticated PIN database. Pending recovery pauses new payments, preparation and credential changes. Historical uploads and saved payment review remain available. The server checks the registered device signature, current original account, its password and device binding. It signs one immutable approval for that exact request and credential generation.

After an interruption, **Check / retry saved PIN recovery** retains the same request ID and candidate. Android first retrieves any existing approval without a password. Only an unaccepted request requires password confirmation again. A specific server response bound to the exact proof permits refreshing an expired proof timestamp; a timeout or ordinary missing result cannot do so. The device retains every proof version.

Android verifies and stores the approval before atomically replacing the original credential and recording its consumed approval. The old complete credential row must still match. Repeated results cannot restore an earlier PIN or clear later failed attempts. Backgrounding the app invalidates pending consent: a late approval can be saved but requires foreground confirmation before application.

**Successful recovery leaves the counter locked.** The staff member must explicitly unlock using the new PIN. Invoice ranges, expired authorities, payment holds, receipts, clock fences and financial records remain unchanged. A financial conflict does not prevent PIN recovery needed to inspect historical records.

Missing/corrupt stores or keys and a blocked clock require a separate recovery procedure. Never clear app data or reinstall to bypass them. Device loss, staff reassignment and clock repair remain separate pending product workflows.

The financial SQLite journal remains version7. Only the PIN database moves from version1 to version2, adding authenticated immutable request, proof, expiry, approval and applied-audit tables. Existing credentials and failed attempts are preserved. See the [server/native contract](../../docs/contracts/20261016-native-pin-recovery.md) for signature, authorization and persistence boundaries.

Verification separates real P256/server/PostgreSQL tests, native SQLite/Keystore tests, native secure-dialog tests and responsive UI fixtures. These do not establish complete two-device operation, physical printer compatibility or manager acceptance. Exact run evidence and internal APK hashes are recorded privately.
