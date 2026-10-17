"""Shared, dependency-free contract for the public online-counter release."""
import hashlib
import datetime
import json
from pathlib import Path
import re

APPLICATION_ID = 'info.internext.pos.counter'
ORIGIN = 'https://pos.internext.info'
SIGNER_SHA256 = 'b8ea075db91eaa417947bca77d9e53e93ded76c594282fb2feafc7f7895a08f3'
MAX_APK_BYTES = 100 * 1024 * 1024
MAX_MANIFEST_BYTES = 16384


def digest(path):
    checksum = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(block)
    return checksum.hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field: ' + key)
        result[key] = value
    return result


def read_manifest(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError('Invalid manifest file or size')
    result = json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object)
    validate_manifest(result)
    return result


def validate_manifest(manifest):
    if not isinstance(manifest, dict):
        raise ValueError('Manifest must be an object')
    required = {'applicationId', 'name', 'version', 'versionCode', 'minimumAndroid', 'minSdk',
                'mode', 'offlineSalesEnabled', 'sha256', 'signingCertificateSha256', 'apkBytes',
                'sourceCommit', 'webRelease', 'preparedAt', 'download', 'counter'}
    if not required <= manifest.keys() or manifest.keys() - required - {'schemaVersion', 'releaseNotes'}:
        raise ValueError('Unexpected or missing release fields')
    version = manifest['version']
    if not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})', version):
        raise ValueError('Invalid version')
    for name, lower, upper in [('versionCode', 1, 2100000000), ('minSdk', 26, 100), ('apkBytes', 1, MAX_APK_BYTES)]:
        if type(manifest[name]) is not int or not lower <= manifest[name] <= upper:
            raise ValueError('Invalid ' + name)
    if manifest['applicationId'] != APPLICATION_ID or manifest['name'] != 'Internext Counter':
        raise ValueError('Wrong application identity')
    if manifest['mode'] != 'online' or manifest['offlineSalesEnabled'] is not False:
        raise ValueError('This release is online-only')
    if manifest['signingCertificateSha256'] != SIGNER_SHA256:
        raise ValueError('Unexpected release signing certificate')
    for name, length in [('sha256', 64), ('sourceCommit', 40), ('webRelease', 40)]:
        if not isinstance(manifest[name], str) or not re.fullmatch('[a-f0-9]{' + str(length) + '}', manifest[name]):
            raise ValueError('Invalid ' + name)
    if manifest['download'] != ORIGIN + '/downloads/' + apk_name(manifest) or manifest['counter'] != ORIGIN + '/counter':
        raise ValueError('Unexpected release URL')
    if 'schemaVersion' in manifest and (type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1):
        raise ValueError('Unknown release schema')
    for name, maximum in [('minimumAndroid', 30), ('preparedAt', 64), ('releaseNotes', 2000)]:
        if name in manifest and (not isinstance(manifest[name], str) or not manifest[name] or len(manifest[name]) > maximum
                                 or any(ord(char) < 32 and char not in '\n\t' for char in manifest[name])):
            raise ValueError('Invalid ' + name)
    if datetime.datetime.fromisoformat(manifest['preparedAt'].replace('Z', '+00:00')).tzinfo is None:
        raise ValueError('Release timestamp requires an explicit timezone')
    return manifest


def apk_name(manifest):
    return 'internext-pos-counter-' + manifest['version'] + '.apk'


def validate_progression(incoming, previous):
    if incoming['versionCode'] < previous['versionCode']:
        raise ValueError('Release downgrade refused')
    if incoming['versionCode'] == previous['versionCode']:
        if incoming != previous:
            raise ValueError('Same release code requires the identical manifest')
        return 'identical'
    if tuple(map(int, incoming['version'].split('.'))) <= tuple(map(int, previous['version'].split('.'))):
        raise ValueError('New release requires a higher version and versionCode')
    return 'forward'


def validate_stage(staging):
    staging = Path(staging)
    manifest = read_manifest(staging / 'release.json')
    # Publication order is a release invariant: clients see the manifest last.
    public_files = [apk_name(manifest), 'index.html', 'release.json']
    if set(path.name for path in staging.iterdir()) != set(public_files + ['downloads.conf']):
        raise ValueError('Unexpected staging content; only public release files allowed')
    for name in public_files + ['downloads.conf']:
        path = staging / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Staging requires regular files without symlinks')
    apk = staging / public_files[0]
    if apk.stat().st_size != manifest['apkBytes'] or digest(apk) != manifest['sha256']:
        raise ValueError('APK checksum or byte count mismatch')
    if not 1 <= (staging / 'index.html').stat().st_size <= 262144 or not 1 <= (staging / 'downloads.conf').stat().st_size <= 16384:
        raise ValueError('Unexpected public text file size')
    return manifest, public_files
