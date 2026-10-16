# Manager menu photos

## Design and scope

The existing counter menu editor is the starting point. A manager needs to recognise the dish, review a replacement and understand when it will reach the counter. The photo belongs beside the item details rather than in a separate media-management screen.

The palette preserves counter navy `#142d4e`, blue `#165dcc`, white `#ffffff`, page grey `#f4f7fb`, muted text `#526176` and confirmation green `#14543e`. Arial inherits the counter's established type scale. A compact heading, quiet state label and a contained 4:3 photo area carry the hierarchy; no additional decorative cards, generated images or new typography are introduced. Content remains left aligned. Authentic source images are contained without cropping so the manager can see the whole photograph.

The initial plan was checked against the existing counter. A separate large upload panel would have displaced the item form on small screens. The implementation instead uses one section within the existing editor, with a dividing rule, wrapped actions and full-width controls at narrow widths. This is a food-item editing tool, not a general asset library.

## Interaction

1. **Choose item photo** shows a local preview. No upload is sent. Save stays disabled while a selected file has not been uploaded or discarded.
2. **Upload photo** explicitly stores the processed public photo. Before this action, the UI discloses that uploaded photos are public and that replacing or removing an assignment does not delete the public link.
3. The confirmed URL becomes a draft. The confirmation says **Save the menu item to use it at the counter**. The existing catalogue save persists the assignment with its usual revision, reason and immutable request journal.
4. **Remove photo** changes the draft to no photo. **Restore saved photo** returns to the saved assignment. Neither operation uploads or changes the database by itself.

The editor labels saved, selected and unsaved states. Upload errors retain the selected file for retry and do not imply that the menu changed. A lost upload response can safely retry the same file through server deduplication. A lost catalogue-save response instead uses the existing exact saved-command recovery; only the confirmed image URL enters that journal, never image bytes, file contents or local preview URLs.

During upload, item selection, adding, refreshing and saving are disabled; browser unload prompts preserve the in-progress interaction. Leaving the manager screen aborts the client request and ignores a late response. Branch/device changes remount the scoped editor. Reselecting an item resets its local photo draft together with its form. Existing account, connection and financial holds remain inputs to all mutation controls.

## Accessibility and responsive review

The file chooser has a visible label and format/size guidance. Preview images have descriptive alt text. Feedback uses status and alert roles; the photo section exposes busy state. Photo action buttons are at least 48 px tall and remain visible in normal document flow. The browser's native file chooser is retained for Android and desktop compatibility.

The actual `CatalogueManager` and `MenuPhotoEditor` components were reviewed at 320, 375 and 1280 px using synthetic API replies and the existing archived Maska Pav photograph. There was no horizontal overflow: document scroll/client widths matched at 305/305, 360/360 and 1280/1280 px respectively (mobile scrollbar space accounts for the difference from viewport width). Final 375 px photo dimensions were 284 × 212.5 px; 320 px dimensions were 229 × 171.25 px. Images loaded successfully and all measured photo action buttons were 48 px tall.

Visual review caught two CSS interactions with the counter's global styles: photo action height was initially overridden, and intrinsic image sizing stretched the preview. More specific local selectors and an absolutely positioned contained image fixed both before the final screenshots. Full desktop screenshot capture timed out once; a subsequent supported capture succeeded.

Browser checks exercised local selection, explicit upload, lost upload response and retry, staged assignment, lost menu-save response and exact saved retry, ending with one confirmed synthetic menu change. Root independently reviewed desktop removal/retry and the 320/375 px screenshots. Synthetic browser responses do not prove production storage or image decoding; server/SQL integration verification is separate.

## Verification and cleanup

- 19 new photo UI cases and 3 existing catalogue UI cases passed.
- Scoped ESLint and TypeScript checks passed.
- Semgrep ran 210 applicable rules across the two changed UI components with zero findings and no reported errors. This is a scoped scan, not a platform audit.
- Private screenshots and metrics are under the task evidence folder's `menu-photo-ui/` directory; they are not published site assets.
- The temporary Vite preview, HTML/config fixtures and owned browser tab were removed/stopped. The temporary viewport override was reset. No live customer or financial records were changed.

This feature covers the web manager editor. Native signed offline menus do not yet carry photos; no offline photo delivery claim is made.
