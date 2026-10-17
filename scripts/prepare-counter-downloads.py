#!/usr/bin/env python3
"""Prepare private public-release staging after real Android SDK verification.

The SDK verifies the APK signature locally. The server publisher rechecks the
uploaded byte hash and pinned metadata; it does not repeat APK signature parsing.
Keep the output directory outside this repository and retain it for exact retries.
"""
import argparse
import datetime
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from counter_downloads import APPLICATION_ID, ORIGIN, SIGNER_SHA256, apk_name, digest, validate_manifest, validate_stage

ROOT = Path(__file__).resolve().parent.parent


def verify_apk(apk, build_tools):
    signature = subprocess.run([str(build_tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)],
                               check=True, capture_output=True, text=True).stdout
    signers = re.findall(r'^Signer #[0-9]+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$', signature, re.MULTILINE)
    if [signer.lower() for signer in signers] != [SIGNER_SHA256]:
        raise ValueError('APK must have the established single release signer')
    badging = subprocess.run([str(build_tools / 'aapt'), 'dump', 'badging', str(apk)],
                             check=True, capture_output=True, text=True).stdout
    package = re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging, re.MULTILINE)
    minimum = re.search(r"^sdkVersion:'([0-9]+)'$", badging, re.MULTILINE)
    if not package or not minimum or package.group(1) != APPLICATION_ID:
        raise ValueError('Unexpected APK identity or missing version metadata')
    if re.search(r'^application-debuggable', badging, re.MULTILINE):
        raise ValueError('Refusing a debuggable APK')
    # This distribution channel currently supports Android 8.0+. Any minimum
    # version change needs a deliberate landing-page/support contract change.
    if int(minimum.group(1)) != 26:
        raise ValueError('Unexpected minimum SDK; review Android support before publishing')
    if int(package.group(2)) < 2 or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', package.group(3)) or tuple(map(int, package.group(3).split('.'))) < (1, 1, 0):
        raise ValueError('This landing page requires the updater-capable release, version 1.1.0/code 2 or newer')
    if "uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'" not in badging:
        raise ValueError('APK is missing the update installation permission')
    return {'applicationId': package.group(1), 'versionCode': int(package.group(2)),
            'version': package.group(3), 'minSdk': int(minimum.group(1)), 'signingCertificateSha256': SIGNER_SHA256}


def find_build_tools(sdk):
    candidates = [path for path in (sdk / 'build-tools').iterdir()
                  if re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', path.name)
                  and (path / 'aapt').is_file() and (path / 'apksigner').is_file()]
    if not candidates:
        raise ValueError('No complete Android SDK build-tools installation found')
    return max(candidates, key=lambda path: tuple(map(int, path.name.split('.'))))


def prepare(apk, output, source_commit, web_release, build_tools, notes):
    apk = apk.resolve(strict=True)
    if output.is_symlink():
        raise ValueError('Output must not be a symbolic link')
    output = output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError('Release staging must be outside the source repository')
    if output.exists() or output.is_symlink():
        raise ValueError('Output must be a new private staging directory; retain prior staging for exact retry')
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Verify a private frozen copy, then publish that same copy into staging.
    temporary = Path(tempfile.mkdtemp(prefix='.counter-release-', dir=output.parent))
    try:
        frozen = temporary / 'candidate.apk'
        shutil.copyfile(apk, frozen)
        metadata = verify_apk(frozen, build_tools)
        manifest = {
            'schemaVersion': 1, 'name': 'Internext Counter', **metadata,
            'minimumAndroid': '8.0', 'mode': 'online', 'offlineSalesEnabled': False,
            'sha256': digest(frozen), 'apkBytes': frozen.stat().st_size,
            'sourceCommit': source_commit, 'webRelease': web_release,
            'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'counter': ORIGIN + '/counter', 'releaseNotes': notes,
        }
        manifest['download'] = ORIGIN + '/downloads/' + apk_name(manifest)
        validate_manifest(manifest)
        frozen.rename(temporary / apk_name(manifest))
        template = (ROOT / 'deployment/android-counter-downloads.html').read_text(encoding='utf-8')
        rendered = template.replace('{{VERSION}}', html.escape(manifest['version'])).replace('{{APK_NAME}}', html.escape(apk_name(manifest)))
        if '{{' in rendered:
            raise ValueError('Unresolved landing-page template placeholder')
        (temporary / 'index.html').write_text(rendered, encoding='utf-8')
        (temporary / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        shutil.copyfile(ROOT / 'deployment/apache/downloads.conf', temporary / 'downloads.conf')
        validate_stage(temporary)
        for path in temporary.iterdir():
            path.chmod(0o600)
        temporary.rename(output)
        return {'status': 'prepared', 'staging': str(output), 'version': manifest['version'],
                'versionCode': manifest['versionCode'], 'sha256': manifest['sha256'],
                'apkSdkVerification': 'signature, single pinned signer, package, version, minimum SDK, non-debuggable',
                'publication': 'not attempted'}
    except Exception:
        shutil.rmtree(temporary)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--web-release', required=True)
    parser.add_argument('--build-tools', type=Path)
    parser.add_argument('--sdk', type=Path, default=Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Android/Sdk'))))
    parser.add_argument('--release-notes', default='Check for app updates from Internext, download a verified update and install it after finishing counter work. Online sales still require internet.')
    args = parser.parse_args()
    print(json.dumps(prepare(args.apk, args.output, args.source_commit, args.web_release,
                             args.build_tools or find_build_tools(args.sdk), args.release_notes), indent=2))


if __name__ == '__main__':
    main()
