# Daily sales launch

The immediate release is the existing hosted online counter plus a signed, separate **Internext Counter** Android app (`info.internext.pos.counter`). The app opens the same live counter and branch records. Customer transactions continue using hosted release `2de794a`; this delivery does not activate SQL031–032 or the offline financial issuer.

Entry points:

- [Live sales counter](https://pos.internext.info/counter)
- [Android installation and first-shift instructions](https://pos.internext.info/downloads/)
- [Detailed manager guide](manager-counter-quickstart.md)

The manager signs in, registers the actual device, reviews approved menu prices, and opens a shift with the actual counted drawer cash. Staff should enter the first real customer sale only after that setup. Do not populate the customer's ledger with practice sales. Card entries record payments confirmed separately on the card terminal.

## Release verification

Hosted acceptance uses a separate synthetic branch and real browser authentication, enrollment, opening cash, a paid bill, VAT/change, receipt retrieval after reload, PDF generation, reports, a credit note and a balanced shift close. Desktop 1280px and phone 375px checks cover the actual sale and receipt screens. Customer financial records remain separate.

Android release acceptance must verify the signed APK itself, fixed HTTPS origin, saved session and storage persistence, offline refusal, receipt printing through Android and a hosted synthetic sale. Keep the production signing key private and backed up outside the repository. Future APK updates must use the same package identity and signing key, with a higher version code. Never tell staff to clear app data or uninstall while a payment request is unresolved.

The public APK is served by a narrow Apache static alias. Publishing it does not replace the Next application or change the database. The publisher verifies configuration/artifact backups, runs the Apache configuration check, and retains rollback evidence. Independently check the downloaded APK hash, response MIME type, blocked write methods and unchanged live counter health after publication. The release manifest identifies the exact APK and signing certificate.

## Deferred work

The larger roadmap remains recorded in [launch readiness](../plans/2026-10-16-launch-readiness.md). The immediate next work after daily counter adoption is:

1. Verify the restaurant's actual POS device and receipt/kitchen printers.
2. Commission and release offline Android selling, including real-device interruption and reconnect acceptance.
3. Deploy the tested kitchen-station candidate through its controlled database and hosted acceptance steps.
4. Continue inventory recipes/purchasing/transfers, remaining restaurant features and operational refinements.
5. Commission recurring PayPal billing separately from restaurant customer payments.

The online APK does not provide offline selling or direct USB/Bluetooth thermal-printer support. Standard Android printing depends on an installed compatible print service. Emulator/PDF acceptance does not prove physical paper output. Subscription agreements are unchanged by this launch.
