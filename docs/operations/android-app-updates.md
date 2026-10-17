# Android counter update releases

The customer package is `info.internext.pos.counter`. Updates retain that identity and the existing private signing key. This is the **online** counter; publishing an updater does not enable the separate offline engineering candidate or certify a physical printer.

Version 1.0.0 has no update checker. Its users must install the first updater-capable APK over the existing installation once. Subsequent releases can be discovered by that app through `https://pos.internext.info/downloads/release.json`. Staff decide when to update and Android can require installation permission and confirmation. Finish sales, reconcile uncertain payments, close the shift and return to Sell first. The authenticated counter must report a safe idle state before installation can proceed; a fresh login screen or guarded sign-out can also qualify. Never uninstall or clear storage to update. Actual device installation and storage-preservation acceptance must be recorded separately from the build.

## Prepare a release

1. Build and test the signed release with Java 21 and the installed Android SDK. Keep all signing files outside the repository. Use a new semantic version and a strictly higher Android version code.
2. Run `python3 scripts/prepare-counter-downloads.py --apk APK_PATH --output NEW_PRIVATE_STAGE --source-commit SOURCE_SHA --web-release LIVE_WEB_SHA`. Supply `ANDROID_HOME`, or `--sdk`; `--build-tools` can select an installed build-tools directory. The output must be a new directory outside the repository. Retain that directory unchanged for an exact retry.
3. The preparer verifies a frozen private copy with `apksigner verify` and `aapt dump badging`. It requires the existing single signing certificate, application identity, version/code, Android 8.0 minimum, non-debuggable packaging and installation permission. It produces only the versioned APK, landing page, release manifest and Apache snippet. The shared contract validates URLs, field bounds, hashes and sizes.
4. Verify the actual signed APK on an isolated device/emulator, including an in-place upgrade from the prior version, retained session/storage, update prompt, cancellation, Android permission/installer handling and tampered download rejection. Keep fixture releases private; never publish a fake higher production version just to trigger an update test.

## Publish and independently verify

Upload the private staging directory plus `scripts/publish-counter-downloads.py` and its sibling `scripts/counter_downloads.py` using direct SSH. The publisher runs as root on the POS host. It validates staging again, checks the expected current web release and rejects downgrades or changed content under an existing release code. An identical manifest permits an idempotent retry.

The server checks the APK byte length/hash and pinned signing-certificate declaration. **It does not cryptographically parse the APK.** Cryptographic verification occurs in the local preparer, and the installed client independently validates its downloaded APK before handing it to Android. This workflow trusts the authorized release operator and the secured upload; the manifest declaration alone is not a signature attestation.

The publisher takes verified configuration/public-file backups and holds an exclusive release lock. It retains existing versioned APKs, writes the new immutable APK first, then the landing page, and atomically replaces the manifest last. Existing matching Apache configuration is left untouched. On an exception, the old manifest is restored first; a successfully published immutable APK can remain available for clients that already started downloading it. This is publication rollback, not permission to downgrade an installed Android app.

After publication, independently fetch `/downloads/`, `/downloads/release.json` and the exact APK. Compare their bytes to staging, verify content types and security headers, then rerun signature verification against the downloaded APK. Check HEAD, blocked write methods and private/non-whitelisted paths; verify counter health and the expected unchanged web release. Preserve those results before reporting the release as deployed. A successful publisher result explicitly leaves public verification pending.

The Apache snippet already admits semantic-version APK filenames. Preserve the explicit `/downloads/` landing-page alias; removing it can make the download page fail even while an individual APK URL still works. Do not place credentials, signing keys, test APKs or private reports in the public directory.
