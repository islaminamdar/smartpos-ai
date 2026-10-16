# Partial item and weight returns — candidate contract

Implementation target, not a deployment claim. Preserve existing invoices, v1/v2 full credit notes and exact `refund.full` replay. The new command is `refund.items`; managers/owners use their own current open shift and bound device. Partial returns never reprice a sale, reapply an offer, reinstate redemption limits, automatically restock food, physically return cash or initiate a card-provider refund.

## Monetary allocation

Use original invoice **lineNumber**, not product ID (older invoices may repeat products). For original quantity Q and cumulative returned quantity q, allocate saved before-discount B, discount D, gross G and tax T hierarchically: `b=floor(B*q/Q)`, `d=floor(D*b/B)`, `g=b-d`, `t=floor(T*g/G)`, `n=g-t`. Zero denominators yield zero for that component. For a return from q0 to q1, use the difference between these cumulative amounts. Validate original `B-D=G=N+T`; use exact integer arithmetic. This preserves original undiscounted whole-unit prices, nonnegative components, original caps and every final residual fils. For example, three undiscounted units at 101 fils return 101 fils each; original tax of 14 fils allocates 4, 5, 5. With B303 and D101, successive units carry discounts33,34,34 and gross68,67,67. Fractional-fils residuals for weight sales and discounts are carried into later returns. The receipt explains allocation of original billed totals; it must not imply current-price repricing or recomputation of VAT on the partial gross.

Whole piece/pack units use quantityMilli multiples of 1000; kg uses integer grams. Positive quantities only, unique sorted original line numbers, at most 200 selections. No amount, price, tax or discount is caller-controlled. Zero-value returns are supported: consume the selected quantities, create a v3 credit record with zero totals and no payment rows, and explicitly state that no refund is due. Never manufacture a one-fils payment.

Let R be cumulative returned gross and G the original invoice gross. Cumulative cash return is `floor(originalCash*R/G)`; cumulative card is `R-cash`. A command records the difference from prior cumulative amounts and omits zero payments. The total and each tender remain capped by the original invoice. Before writing, require sufficient cash in the manager's actual shift for the cash component.

## Shared shapes

All objects are strict and UUIDs canonical lowercase. Money uses integer fils 0..100000000; quantities 0..1000000. `Amounts` always has `{beforeDiscountFils,discountFils,grossFils,netFils,taxFils}`. `Payment` is `{method:'cash'|'card',amountFils:positive integer}`. Empty payments are permitted only for zero total. Revision is a nonnegative count of prior credit notes, capped below 2147483647.

`Selection = {lineNumber,quantityMilli}`. `ReturnLine` has consecutive credit `lineNumber`, `originalLineNumber`, original productId/name/unit/unitPriceFils/taxRateBps, returned quantityMilli, all five Amounts fields, `returnedBeforeQuantityMilli`, `returnedAfterQuantityMilli`, and `originalLine` (the exact original v1 or v2 line snapshot). The original line number is retained inside originalLine as well. This supplies independent allocation evidence without altering the old document contract.

`ReturnState = {schemaVersion:1,invoice,revision,returned,refundedPayments,adjustedTotals,fullyReturned}`. invoice is the complete original v1/v2 tax invoice. returned contains every original line in original order as `{lineNumber,quantityMilli}`, including zero quantities. refundedPayments contains positive cumulative cash/card amounts only. adjustedTotals are the original totals minus all previous credit deltas. fullyReturned is true only when every original quantity is returned, including zero-valued offer lines. Historical full credits map to all quantities returned. A legacy monetary refund without a fiscal credit cannot be guessed into line quantities: return an explicit unavailable state/error instead.

`ReturnRequest = {branchId,deviceId,shiftId,orderId,invoiceId,expectedRevision,lines:Selection[],reason}`. Reason is trimmed 1..240 characters, without NUL. Preview binds all these fields.

`ReturnPreview = {schemaVersion:1,branchId,deviceId,shiftId,orderId,invoiceId,expectedRevision,reason,lines:ReturnLine[],previousAdjustedTotals,totals,adjustedTotals,payments,fullyReturned,quoteHash}`. Hash is lowercase SHA256 of the server's exact canonical preview excluding quoteHash; it is opaque to clients. Client validation checks identity, selections and arithmetic against the selected authoritative ReturnState. Changing any request field discards preview and confirmation.

## HTTP / RPC

- `GET /api/pos/returns?branchId&deviceId&orderId` returns `{status:'ready',state:ReturnState}`. Manager/owner and active bound device required; no shift needed just to read. RPC `pos_return_state(p_branch,p_device,p_order,p_binding)`.
- `POST /api/pos/returns` receives `{request:ReturnRequest}` and returns `{status:'ready',preview:ReturnPreview}`. Same-origin, private/no-store, bounded request. RPC `pos_preview_return(p_request,p_binding)`. Authorizes current shift and current revision; it creates no financial rows.
- Existing `POST /api/pos/commands` accepts `{command:{id,type:'refund.items',...ReturnRequest,quoteHash}}`. RPC `pos_execute_live_command` uses the same global request lock/recovery journal as historical commands. It recalculates the exact preview under invoice/order and shift locks, compares quoteHash/revision, and atomically creates credit, tender return rows, command acknowledgement, audit and kitchen effects.
- Result remains `{status:'applied',commandId,replayed,creditNote}`. Credit contains quoteHash and request-matching selections. Existing `/api/pos/recovery` accepts the exact command, retrieves the immutable committed result after access changes, or tombstones an unsaved request with existing cancellation semantics. It never generates a replacement command or changes physical money.

Use `POS_RETURN_STALE` for revision/hash mismatch, `POS_RETURN_QUANTITY` for invalid/excess remaining quantities, `POS_RETURN_UNAVAILABLE` for unsupported/inconsistent legacy custody, and existing authority, cash and recovery error codes. New writes remain behind the financial gate; historical recovery remains available when writes are paused.

## Immutable v3 credit

Retain common fiscal identifiers/profile/customer/service/order/device/shift/actor/issuedAt. `schemaVersion:3`, `kind:'tax_credit_note'`, `reason`, `lines:ReturnLine[]`, `totals:Amounts`, `payments`, `paymentSettlement:'recorded'`, `originalInvoice:{documentId,documentNumber,issuedAt,schemaVersion:1|2,totalFils,taxFils,netFils,beforeDiscountFils,discountFils}`, `originalOffer` (exact original appliedOffer or null), `previousAdjustedTotals:Amounts`, `adjustedTotals:Amounts`, `returnRevision`, `fullyReturned`, `quoteHash`.

Consecutive notes show supply value before this adjustment, the reduction and remaining supply value, with VAT separately. This follows the FTA clarification that subsequent notes use the adjusted value from the previous credit note, not the initial invoice value: [VATP040, Article 60](https://tax.gov.ae/Datafolder/Files/Pdf/2025/VATP040%20-%20Amendments%20to%20VAT%20ER%20-%2014%2003%202025.pdf). The allocation method above is an engineering conservation policy, not a claim that FTA prescribes that algorithm.

Keep v1/v2 parsers unchanged and add a distinct strict v3 branch. Preserve immutable original offer metadata without requiring the returned subset to equal the entire offer quote. Validate original line amounts and returned deltas, totals, tender sum, original invoice bounds and previous-minus-current balances. Display zero-value returns clearly.

## Kitchen and operational effects

Partial returns must not silently cancel the entire paid or dispatched kitchen order. The kitchen receives the exact affected products/quantities and a reasoned return notice tied to the credit document; duplicate replay creates no second notice. Original preparation history and served quantities remain evidence. Final quantity return can cancel the remaining ticket using existing full-return behavior. Imported offline invoices retain their existing no-kitchen-replay rule. Precise station/bucket behavior is implemented and tested with the kitchen projection migration.

SQL030 uses immutable notices and acknowledgements shared by paid and dispatched kitchen boards. Partial returns leave preparation buckets unchanged because a financial line cannot identify whether the physical item was queued, cooking or already served. The notice shows the returned and remaining invoice quantities and requires staff to check the affected preparation. Stage changes remain blocked until every notice for that order is acknowledged. Acknowledgement records this operational check; it neither changes a financial record nor claims an automatic adjustment of unfinished cooking. The UI keeps this distinction explicit. Final quantity return retains the existing ticket cancellation behavior and its prior-stage audit history.

No automatic inventory restock: food may be wasted or unsafe to resell; explicit stock operations remain separate. Reports subtract the immutable credit's actual quantities, net, VAT and tender deltas on the credit date, including quantity-only zero-value returns.

## Verification required

Actual PostgreSQL: old populated documents unchanged; multiple partial/final returns; mixed tender; duplicates of one product on separate invoice lines; weight precision and one-fils residuals; discounted/free lines; repeated full-return compatibility; manager/tenant/device/shift revocation; cash caps; same/different request races, preview staleness, full-vs-partial and cancellation races; immutable evidence and no duplicate kitchen notices. Cross-language allocation vectors and exhaustive bounded partition checks must prove conservation and nonnegative deltas. UI: authoritative returned quantities, bound fresh confirmation, stale/read failures, lost response, exact recovery, printed credit detail, 320/375/1280px. Security scan, builds and existing regressions precede release. Customer acceptance and physical returns are not inferred from synthetic tests.
