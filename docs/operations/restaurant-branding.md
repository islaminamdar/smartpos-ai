# Restaurant identity on Internext POS

The public website and staff sign-in remain Internext POS. After sign-in, the counter uses the verified identity of the selected restaurant branch. The first verified identity is Suleman Usman Mithaiwala, Bur Dubai.

## What is branded

- Counter header: authentic restaurant emblem, display name, branch and a small Internext attribution.
- Counter actions: the logo's magenta accent, with a white working surface and restrained pink background.
- Kitchen screen: restaurant identity and branch above the preparation boards.
- Receipt preview and browser printing: the restaurant logo above the immutable legal name, address, phone and TRN. The printed logo uses grayscale at 18 mm for thermal receipts. Amounts, document numbers and legal snapshots are unchanged.

The existing authentic `public/pos-assets/brand/mithaiwala.webp` asset is reused. No replacement or generated logo is introduced.

## Tenant boundaries

`lib/pos/server/branding.ts` resolves a verified registry entry only when organization, branch and immutable receipt-profile identifiers all match. This registry is server-only. The authenticated bootstrap includes presentation metadata, with a strict local-asset path and theme enum. No match, missing profile or a new profile version gives the generic Internext counter until branding is explicitly verified for that scope.

Receipt decoration checks the supplied brand against the saved document's organization, branch and profile, independently of the currently selected screen. Unknown or historical unmatched profiles retain their original legal receipt without an added logo. Branding does not edit fiscal JSON, change prices, grant access, or identify a tenant through name matching.

A future branch or another restaurant needs its own verified registry entry. This release is not a customer-editable theme or logo-upload system.

## Visual choices and acceptance

The identity comes from the original magenta/black emblem. Palette: magenta `#b80066`, ink `#201822`, white `#ffffff`, pale pink `#fff7fb`, separator `#e7dce3`, muted text `#65515e`. Existing Arial counter typography is retained for fast operation. Left-aligned identity, distinct branch status and existing navigation avoid moving sales controls for returning staff.

Review the actual counter at 375 px and 1280 px, including Sell, Kitchen, Receipts and expanded sign-in help. Verify the local logo loads, legal fields stay unchanged, pages do not overflow, and receipt PDF retains its 80 mm layout. Browser PDF verification does not establish physical printer compatibility.
