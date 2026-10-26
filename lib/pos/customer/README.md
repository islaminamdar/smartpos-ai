# Customer and loyalty foundation

`20261026000400_pos_customer_loyalty_foundation.sql` adds branch-scoped customer profiles, explicit marketing-consent records, an inactive-by-default points programme, and an append-only loyalty ledger.

It intentionally does **not** add a money wallet, credit balance, messages, offers, automatic marketing, or a public customer lookup. Points can only be created when a future authenticated counter payload includes an explicitly selected `customer.loyaltyCustomerId`; a credit note reverses its linked invoice's points proportionally. Existing invoices, offline signed receipts, and anonymous sales remain unchanged.

Customer registration requires a normalized E.164 phone number. Customer details and loyalty history are not directly readable by branch staff; future staff screens must use a narrowly scoped, audited server action. Until an audited counter workflow exists, only managers can call `pos_upsert_customer`, and it returns only an opaque customer ID. It can create a manager-approved initial opt-in or correct a name; it cannot change an existing marketing decision.

Before enabling the programme, the owner must choose a published programme policy, activate the branch row in `pos_loyalty_programs`, and complete a counter integration and fiscal-document migration rehearsal. Points have no cash value in this release.
