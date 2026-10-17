# Tap-to-select counter controls

Daily cashier choices use visible native radio tiles instead of dropdowns: order type, payment, menu category, branch registration, cash in/out and dine-in table selection. The selected tile is filled with the restaurant accent colour, targets are at least 48 px high, and keyboard radio navigation remains available.

The menu has 18 categories. Its category row scrolls horizontally to keep products visible on a narrow screen; other choices wrap so their options remain visible. Search remains available. Choosing a tile does not submit a sale or cash movement. Existing locks, pending-request recovery, offer scope, monetary calculations and save confirmations are preserved. Table choices still exclude inactive/occupied tables and retain an existing order's own table; refreshing availability is required after stale or offline reads.

This is a cashier-flow change. Manager configuration selectors elsewhere are unchanged. Product prices, item availability, photos and historical bills are not modified. See [the photo coverage audit](menu-photo-coverage-2026-10-17.md) for the eight records that require approved images.
