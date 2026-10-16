# Manager menu photos — 16 October 2026

Candidate SQL026 and server preprocessing provide bounded, immutable menu photos. They do not enable sales or change historical receipts. Deployment is a separate step.

## Processing boundary

The authenticated, same-origin server route confirms the current branch manager/owner and bound device before decoding. `pos_menu_media_context` consumes one of 30 admissions per actor/branch in each fixed UTC quarter-hour. The server additionally limits concurrent decodes. Its trusted Sharp pipeline accepts JPEG/PNG/WebP inputs up to 5 MiB and 16 megapixels, rejects multiple frames, re-encodes to WebP at no more than 1200 × 1200 and 256 KiB, and strips metadata.

SQL is not an image decoder. It checks the exact normalized registration envelope, standard canonical base64, length, SHA-256, and RIFF/WEBP header/file length. Dimensions and single-frame/metadata guarantees depend on the trusted service pipeline. SQL tests use explicitly synthetic RIFF bytes to test this boundary; server tests cover genuine decoding.

## RPC contract

All three media RPCs are executable only by `service_role`. Browser roles cannot call them or read/write their tables. Private helper functions and the former catalogue writer are not service-role entry points.

- `pos_menu_media_context(p_actor uuid, p_branch uuid, p_device uuid, p_binding text)` returns `{organizationId,branchId,deviceId,actorId}`. It authorizes and consumes an admission before decoding.
- `pos_menu_media_register(p_actor uuid, p_branch uuid, p_device uuid, p_binding text, p_media jsonb)` repeats current authorization without another admission. The exact media object is `{id,sha256,base64,width,height,byteLength}`. IDs are lowercase UUIDs, hashes lowercase SHA-256 hex, and dimensions/length are bounded integers. Returns `{status:'ready',image:{id,branchId,imageUrl,sha256,width,height,byteLength},replayed:boolean}`.
- `pos_menu_media_read(p_id uuid)` returns null or `{id,sha256,base64,width,height,byteLength}`. The server serves the bytes at `/pos-assets/menu/upload_<32 lowercase UUID hex>.webp`. The URL is public; the reader exposes no actor, branch, device, or binding metadata.

## Storage and permissions

`pos_menu_media` retains normalized bytes, hash, dimensions, originating actor/device/branch, and timestamp. Update/delete triggers reject mutation. No deletion endpoint exists: historical catalogue snapshots may retain the URL. No original image or metadata is stored. Unattached uploads count toward limits.

Authorization holds shared staff gate15, rechecks/locks the active branch, then takes shared device and binding row locks. The actor must currently be an active owner/manager assigned to this branch or all branches. The device and exact actor-bound cookie binding must currently be active. Financial epoch holds do not grant or deny catalogue permissions.

Registration takes identity advisory37 then branch advisory35. Existing IDs cannot move branches or change bytes. Same-branch SHA dedup returns the original row, including its original ID, before quotas but after current authorization. Identical images in different branches receive different identities. Limits are 512 images per branch (at most 128 MiB normalized bytes) and 100 new rows per UTC day. Concurrent checks and insertion share the branch lock. Admission counters are one row per authorized actor/branch, not one row per request/window.

## Catalogue compatibility

The SQL026 wrapper preserves shared staff15 → command8 → product9 lock order and delegates financial/catalogue semantics to the existing writer. An existing command is replayed through that writer before checking the new media URL policy, preserving historical command results and normal idempotency conflicts.

For new commands, the case-insensitive `upload_` namespace is reserved. Only the exact lowercase URL format is accepted, and the referenced immutable row must belong to the same branch. Malformed/uppercase variants cannot fall back to legacy archived filenames. Existing archived menu paths and null remain supported. Uploading alone creates no product change, receipt, payment, shift mutation, or catalogue audit event; saving the product retains the existing `catalogue.updated` audit.

## Errors

Authorization uses `POS_ACCESS_DENIED`, `POS_MANAGER_REQUIRED`, and `POS_DEVICE_INVALID`. Media failures use `POS_MEDIA_INVALID`, `POS_MEDIA_CONFLICT`, `POS_MEDIA_SCOPE`, `POS_MEDIA_CAPACITY`, `POS_MEDIA_DAILY_LIMIT`, and `POS_MEDIA_RATE_LIMIT`. Quota and registration errors leave no partial image row. Invalid uploads may consume their predecode admission, deliberately bounding work.

## Verification scope

`tests/integration/pos-menu-media.mjs` creates/drops an isolated synthetic PostgreSQL database and permits only a `/tmp/pos-qa-pg-*` Unix socket. It tests authorization, immutable storage, strict input/header/hash/size checks, branch separation, historical catalogue replay, limits, ACLs, and real two-session observed lock waits. Root service tests separately validate actual image processing and production-route integration. No production data or real credentials are used.
