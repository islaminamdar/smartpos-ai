# Hosting-server backups

The customer requested automatic backups on the hosting server. The existing daily
systemd timer runs `backend-backup.py`; successful new archives use AES-256-GCM
authenticated encryption. The database and configuration are packaged together,
decrypted privately for a complete hash/inventory check, and only then published
through `daily-current`. Original staged plaintext from that new archive is removed
after successful verification. Existing historical archives are preserved.

Deploy `backend-backup.py` and `backup_crypto.py` together under
`/opt/internext-pos/backend/`. Python's `cryptography` library is required. Create a
32-byte random key once at `/etc/internext-pos/backup-encryption.key`, root-owned
mode 0600. Never replace an existing key, print it, put it in Git, or include it in
the archive. The backup directory and each archive must remain root-only. Losing
the key makes encrypted archives unusable; keep the key available during recovery.

The manifest identifies encryption, payload hashes and the encrypted file hash.
Failed work must never advance `daily-current`. A failed run can retain private
staging evidence; inspect and reconcile it before retrying. The timer's service
status and journal show failures; no external alert destination is configured.

## Recovery

Check the encrypted archive hash against its manifest. Use `backup_crypto.py`
with the encrypted archive path and a new private output `.tar` path. The helper
authenticates the complete file before publishing plaintext and refuses to
overwrite an existing path. Extract only into a newly created root-only directory,
then verify every payload hash recorded in the manifest. Never restore directly
over the running POS database. First restore the dump into a uniquely named,
access-restricted database and compare schema, migration ledger and data hashes.

The archive includes database, configuration, release identity and download
manifests. Exact application/runtime/APK binaries must be retained separately.
Backups on the same server do not protect against loss of that server. Encryption
protects a copied archive without its key; it does not protect against an attacker
who controls the server and can also read the key. Off-server replication and
external failure notifications remain separate, unconfigured work.

Local checks cover authenticated round trips, large payloads, altered/truncated
ciphertext, wrong keys, unsafe key permissions and refusal to overwrite restore
targets. Hosting deployment and actual isolated database restoration need their
own dated execution evidence before they can be reported verified.

## Verified on 17 October 2026

The hosting timer and both encryption helpers were installed after a verified
backup of the previous configuration. The new encrypted archive was authenticated,
decrypted, and restored with `pg_restore --single-transaction --exit-on-error` into
a uniquely named database with public connections revoked and connection limit
zero. All 32 migration hashes matched; 91 public tables restored. The owned test
database and decrypted staging files were removed after verification, and the
nightly timer remained active. Existing historical backups were preserved.
