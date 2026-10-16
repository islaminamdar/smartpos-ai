# Kitchen dispatch before payment

This increment is a release candidate. Source code and local test results alone do not establish production deployment. The private deployment record holds the verified release and migration state.

## Restaurant flow

Save an unpaid order, review its current contents, then send it to the kitchen. The kitchen explicitly reviews the new-order notice and moves its quantities through queued, preparing, ready and served. A shift is required for taking payment, not for preparing food.

Later edits remain editable drafts until staff send the changes. Additions become new queued quantities; eight already served plus two added remains eight served and two queued. Removing quantities already preparing, ready or served requires a manager and a reason. The kitchen sees those withdrawals as instructions to review work already done, not evidence that food was physically unmade. Unit changes withdraw the old unit and queue the new unit. Name, table and note changes are visible notices; price-only changes do not repeat preparation.

Payment links the same preparation ticket to the invoice. It preserves the first dispatch time, current preparation buckets, notice history and earlier request acknowledgements. Payment rejects unsent kitchen changes. Orders paid without prior dispatch continue to use the existing paid-ticket board.

Voiding an unpaid order or fully refunding a paid order leaves a stop notice visible until acknowledged, even if everything was already served. Reopening a voided draft does not restart preparation. A manager explicitly reviews and sends it as a new preparation round.

## Scope and recovery

The new API family is `/api/pos/tab-kitchen`, with a separate durable browser journal and `/recovery`. Existing kitchen requests and acknowledgements retain their original shape and recovery path. The [database/API contract](../contracts/20261016-tab-kitchen-contract.md) specifies the exact commands, snapshot bounds and lock order.

All reads require an authenticated branch-bound device. Commands record exact original payloads and results. Lost-response recovery returns that original result or creates a durable cancellation that prevents a delayed unsaved command from taking effect. Disabled staff can recover their own committed result; they cannot make a new mutation. Replacement devices follow the existing same-actor, same-branch recovery rules.

Notice acknowledgements identify the exact ticket revision and visible sequence prefix. Each page shows at most 20 notices; later notices still block progression until separately reviewed. Active counts include every unresolved notice regardless of age, payment or cancellation. Recent completed tickets are limited to 50 and visibly labelled when truncated.

The counter rechecks the saved order's current kitchen status immediately before creating a payment request. Pending dispatch recovery blocks conflicting order edits, payments, sign-out, password changes and counter replacement. An unavailable journal fails closed. Physical kitchen printer delivery, courses and station routing are separate remaining work.

## Release evidence required

- Full unit suite and strict real-SQL response fixtures.
- Isolated SQL boundary checks, including many historical batches reduced into bounded readable notices.
- Real PostgreSQL concurrency checks for dispatch/edit, payment/stage, refund/stage, authority revocation and command/recovery races.
- Desktop and mobile rendered review, durable IndexedDB recovery and unchanged legacy request handling.
- Scoped static security review and independent review of database permissions and lock order.
- Verified database backup; exact guarded SQL016 migration ledger; hashed application artifact; public synthetic acceptance with cleanup.

Do not place test invoices in the restaurant ledger. Do not replay an uncertain deployment or public acceptance script without reconciling its durable record. If activation fails after new dispatch requests exist, preserve the new journal, API and historical recovery readers; an older frontend that cannot recover them is not a safe rollback.
