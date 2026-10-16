# Unsupported historical buyer text: candidate custody

This local candidate prevents new customer name/address input containing U+0000 and preserves already-signed evidence containing it. PostgreSQL jsonb cannot store that character. Do not remove it, replace it, change a signed request, fabricate an invoice or acknowledge an unimported sale.

## New actions and historical reads

The web counter and new sync submission schema reject the character before a new sale. The native counter shows field guidance; Java rechecks before a new quote, payment intent or issuance. The native guard runs after an existing intent's exact replay and an already-issued receipt's exact replay. Existing historical parsers, saved request display, receipt display and permanent freeze signing remain unchanged. Arabic, emoji, a literal backslash followed by `u0000`, and supported embedded tabs/newlines remain valid.

An older unissued intent with this character remains readable and freezable but cannot newly issue. A previously issued invoice retains its original signature and can be replayed without allocating another number. No silent normalization occurs at any layer.

## Verified service and SQL019

The service verifies the enrolled historical device signature, canonical payload, full historical schema, authority/snapshot bindings and arithmetic before calling `pos_offline_retain_unsupported(p_authority,p_envelope)`. Invalid signatures, duplicate JSON keys and noncanonical bytes cannot reach this custody write. SQL does not perform ECDSA verification and cannot be called directly by ordinary users.

SQL019 retains the original ASCII signed envelope, its exact payload hash and safe routing identities in a private immutable ledger. Exact payload replay returns the first retained envelope even if its valid ECDSA signature differs. The SQL reader extracts bounded raw member tokens without decoding the full NUL-bearing object. No whole-payload cast to jsonb and no textual replacement is permitted.

Retained evidence places an unresolved hold on the incoming authority's key epoch. Identity claims and additional own-scope checks prevent alternate financial records using its original intent/order/document IDs. Existing committed receipts and seals remain replayable. A foreign collision retains the incoming evidence without revealing another customer's receipt or placing a hold on the victim authority.

The RPC returns `{status:'reconciliation_required',exceptionId,code:'unsupported_text'}`. Receipt import returns this exception without generating an acknowledgement. Freeze registration signs only `conflict`, bound to the fresh query challenge and original freeze hash, with receipt, acknowledgement and resolution all null. Neither outcome clears the native pending payment or enables selling.

## Release boundary

SQL001–018 are unchanged. SQL017–019 are candidate migrations, not live. SQL019 consumes the number formerly discussed for a future replacement-invoice design; manager decisions and replacement invoices need later migrations. Manager resolution, authenticated evidence review, native submission/acceptance and full operational acceptance remain pending. No production offline feature is enabled by this change.
