#!/usr/bin/env python3
"""Publish public counter APK files on the POS host without replacing the web app.

Run as root with an uploaded staging directory containing the three public files
and downloads.conf. Signing credentials must never enter this directory.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from counter_downloads import digest, read_manifest, validate_progression, validate_stage


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def atomic_copy(source, target):
    descriptor, temporary_name = tempfile.mkstemp(prefix='.' + target.name + '.', dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'wb') as output, source.open('rb') as incoming:
            shutil.copyfileobj(incoming, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise SystemExit('Run as root: publish-counter-downloads.py STAGING_DIRECTORY')
    staging = Path(sys.argv[1]).resolve(strict=True)
    manifest, public_files = validate_stage(staging)
    # Serialize operator releases so progression checks and rollback remain valid.
    with open('/var/lock/internext-counter-downloads.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        publish(staging, manifest, public_files)


def publish(staging, manifest, public_files):
    version = manifest['version']
    apk_name = public_files[0]
    configuration = Path('/etc/apache2/conf.d/userdata/ssl/2_4/internext/pos.internext.info/pos.conf')
    web_release = Path('/opt/internext-pos/current').resolve()
    if web_release.name != manifest['webRelease']:
        raise SystemExit('Manifest web release differs from the current deployment')
    old_configuration = configuration.read_bytes()
    marker = b'ProxyPass / http://127.0.0.1:3046/'
    if old_configuration.count(marker) != 1:
        raise SystemExit('Unexpected existing POS proxy configuration')
    snippet = (staging / 'downloads.conf').read_bytes()
    if b'ProxyPass /downloads/' in old_configuration:
        if snippet not in old_configuration:
            raise SystemExit('Existing downloads configuration differs; reconcile first')
        new_configuration = old_configuration
    else:
        position = old_configuration.index(marker)
        new_configuration = old_configuration[:position] + snippet + b'\n' + old_configuration[position:]

    public_root = Path('/var/www/internext-pos-downloads')
    if public_root.is_symlink():
        raise SystemExit('Unexpected public directory symlink')
    if (public_root / 'release.json').exists():
        validate_progression(manifest, read_manifest(public_root / 'release.json'))
    for name in public_files:
        if (public_root / name).is_symlink():
            raise SystemExit('Unexpected public file symlink')
    if (public_root / apk_name).exists() and digest(public_root / apk_name) != manifest['sha256']:
        raise SystemExit('Published APK version is immutable; increment version')
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = Path('/var/lib/internext-pos-backups') / ('counter-downloads-' + timestamp)
    backup.mkdir(mode=0o700)
    shutil.copy2(configuration, backup / 'pos.conf')
    if digest(configuration) != digest(backup / 'pos.conf'):
        raise SystemExit('Configuration backup verification failed')
    prior = []
    for name in public_files:
        path = public_root / name
        if path.exists():
            if path.is_symlink() or not path.is_file():
                raise SystemExit('Unexpected existing download path')
            shutil.copy2(path, backup / name)
            if digest(path) != digest(backup / name):
                raise SystemExit('Download backup verification failed')
            prior.append(name)
    (backup / 'manifest.json').write_text(json.dumps({
        'previousWebRelease': str(web_release), 'priorFiles': prior,
        'incoming': manifest, 'configurationSha256': digest(configuration),
    }, indent=2) + '\n')
    try:
        public_root.mkdir(mode=0o755, parents=True, exist_ok=True)
        if new_configuration != old_configuration:
            candidate = backup / 'new-pos.conf'
            candidate.write_bytes(new_configuration)
            atomic_copy(candidate, configuration)
            run('/sbin/apachectl', 'configtest')
            run('/sbin/apachectl', 'graceful')
        # The staged artifact was verified by local SDK tools before upload.
        # This host independently checks byte integrity, not APK cryptography.
        for name in public_files:
            if name == 'release.json' and Path('/opt/internext-pos/current').resolve() != web_release:
                raise RuntimeError('Live web release changed before publication')
            atomic_copy(staging / name, public_root / name)
            if digest(staging / name) != digest(public_root / name):
                raise RuntimeError('Public file readback mismatch')
        if Path('/opt/internext-pos/current').resolve() != web_release:
            raise RuntimeError('Live web release changed unexpectedly')
        result = {'published': True, 'version': version, 'sha256': manifest['sha256'],
                  'backup': str(backup), 'webReleaseUnchanged': web_release.name,
                  'publicVerification': 'pending'}
        (backup / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except Exception:
        # Withdraw the newly advertised release first. Retain a verified new APK
        # for clients already downloading it; immutable versioned files are safe.
        for name in reversed(public_files):
            if name in prior:
                atomic_copy(backup / name, public_root / name)
            elif name != apk_name:
                (public_root / name).unlink(missing_ok=True)
        if new_configuration != old_configuration:
            atomic_copy(backup / 'pos.conf', configuration)
            run('/sbin/apachectl', 'configtest')
            run('/sbin/apachectl', 'graceful')
        raise


if __name__ == '__main__':
    main()
