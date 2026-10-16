#!/usr/bin/env python3
"""Publish public counter APK files on the POS host without replacing the web app.

Run as root with an uploaded staging directory containing the three public files
and downloads.conf. Signing credentials must never enter this directory.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def atomic_copy(source, target):
    temporary = target.with_name(target.name + '.candidate')
    shutil.copyfile(source, temporary)
    temporary.chmod(0o644)
    os.replace(temporary, target)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise SystemExit('Run as root: publish-counter-downloads.py STAGING_DIRECTORY')
    staging = Path(sys.argv[1]).resolve(strict=True)
    manifest = json.loads((staging / 'release.json').read_text())
    version = manifest['version']
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise SystemExit('Invalid version')
    apk_name = 'internext-pos-counter-' + version + '.apk'
    public_files = ['index.html', 'release.json', apk_name]
    if set(p.name for p in staging.iterdir()) != set(public_files + ['downloads.conf']):
        raise SystemExit('Unexpected staging content; only public release files allowed')
    if any((staging / name).is_symlink() for name in public_files + ['downloads.conf']):
        raise SystemExit('Staging symlinks not allowed')
    if manifest['applicationId'] != 'info.internext.pos.counter':
        raise SystemExit('Wrong application identity')
    if digest(staging / apk_name) != manifest['sha256']:
        raise SystemExit('APK checksum mismatch')
    if manifest['mode'] != 'online' or manifest['offlineSalesEnabled'] is not False:
        raise SystemExit('This release is online-only')

    configuration = Path('/etc/apache2/conf.d/userdata/ssl/2_4/internext/pos.internext.info/pos.conf')
    web_release = Path('/opt/internext-pos/current').resolve()
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
    if (public_root / apk_name).exists() and digest(public_root / apk_name) != manifest['sha256']:
        raise SystemExit('Published APK version is immutable; increment version')
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
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
        for name in public_files:
            atomic_copy(staging / name, public_root / name)
            if digest(staging / name) != digest(public_root / name):
                raise RuntimeError('Public file readback mismatch')
        candidate = configuration.with_name(configuration.name + '.candidate')
        candidate.write_bytes(new_configuration)
        shutil.copymode(configuration, candidate)
        os.replace(candidate, configuration)
        run('/sbin/apachectl', 'configtest')
        run('/sbin/apachectl', 'graceful')
        if Path('/opt/internext-pos/current').resolve() != web_release:
            raise RuntimeError('Live web release changed unexpectedly')
        result = {'published': True, 'version': version, 'sha256': manifest['sha256'],
                  'backup': str(backup), 'webReleaseUnchanged': web_release.name,
                  'publicVerification': 'pending'}
        (backup / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except Exception:
        shutil.copy2(backup / 'pos.conf', configuration)
        for name in public_files:
            if name in prior:
                atomic_copy(backup / name, public_root / name)
            else:
                (public_root / name).unlink(missing_ok=True)
        run('/sbin/apachectl', 'configtest')
        run('/sbin/apachectl', 'graceful')
        raise


if __name__ == '__main__':
    main()
