#!/usr/bin/python3
"""Private same-server POS archive. A successful archive is not an offsite backup."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from backup_crypto import seal_archive

BASE = Path('/var/lib/internext-pos-backups')
CURRENT = Path('/opt/internext-pos/current')
RELEASES = Path('/opt/internext-pos/releases')
DOWNLOADS = Path('/var/www/internext-pos-downloads')
SYSTEMD = Path('/etc/systemd/system')
LOCK = Path('/run/lock/internext-pos-backup.lock')
REQUIRED_CONFIG = [
    Path('/etc/internext-pos/backend'),
    Path('/opt/internext-pos/backend'),
    Path('/var/lib/internext-pos/backend/postgres-config'),
    Path('/etc/tmpfiles.d/internext-pos-backend.conf'),
    Path('/etc/internext-pos/runtime.env'),
    SYSTEMD / 'internext-pos.service',
    SYSTEMD / 'internext-pos-backup.service',
    SYSTEMD / 'internext-pos-backup.timer',
    Path('/etc/apache2/conf.d/userdata/ssl/2_4/internext/pos.internext.info/pos.conf'),
    DOWNLOADS / 'release.json',
    DOWNLOADS / 'index.html',
]


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def write_sync(path, data):
    with path.open('xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    path.chmod(0o600)


def capture(directory, name, args):
    partial = directory / (name + '.partial')
    with partial.open('xb') as f:
        result = subprocess.run(args, stdout=f, stderr=subprocess.PIPE, timeout=300)
        f.flush()
        os.fsync(f.fileno())
    if result.returncode:
        (directory / 'error.private.log').write_bytes(result.stderr)
        raise RuntimeError('Backup command failed; private error retained')
    partial.rename(directory / name)


def check_command(directory, args, stdin=None):
    result = subprocess.run(args, stdin=stdin, capture_output=True, timeout=300)
    if result.returncode:
        (directory / 'error.private.log').write_bytes(result.stderr)
        raise RuntimeError('Archive verification failed; private error retained')


def create_backup():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    directory = BASE / ('daily-' + stamp)
    directory.mkdir(mode=0o700)
    # Do not follow the current symlink when archiving; record and validate its exact target.
    if not CURRENT.is_symlink():
        raise RuntimeError('Current release pointer must be a symlink')
    release = CURRENT.resolve(strict=True)
    if release.parent != RELEASES or not re.fullmatch('[a-f0-9]{40}', release.name):
        raise RuntimeError('Unexpected current release target')
    paths = [*REQUIRED_CONFIG, CURRENT, release / 'release.json', release / 'SHA256SUMS']
    for pattern in ['container-internext-pos-*.service', 'internext-pos-api.*']:
        paths.extend(sorted(SYSTEMD.glob(pattern)))
    paths = list(dict.fromkeys(paths))
    if any(not p.exists() for p in paths):
        raise RuntimeError('Required configuration is missing; daily-current was not advanced')
    before = {str(p): digest(p) for p in paths if p.is_file() and not p.is_symlink()}
    capture(directory, 'postgres.dump', ['podman', 'exec', 'internext-pos-db', 'pg_dump', '-U', 'supabase_admin', '-d', 'postgres', '-Fc'])
    capture(directory, 'globals.sql', ['podman', 'exec', 'internext-pos-db', 'pg_dumpall', '-U', 'supabase_admin', '--globals-only'])
    capture(directory, 'config-secrets.tgz', ['tar', '-czf', '-'] + [str(p) for p in paths])
    with (directory / 'postgres.dump').open('rb') as f:
        check_command(directory, ['podman', 'exec', '-i', 'internext-pos-db', 'pg_restore', '--list'], stdin=f)
    check_command(directory, ['tar', '-tzf', str(directory / 'config-secrets.tgz')])
    check_command(directory, ['tar', '-dzf', str(directory / 'config-secrets.tgz'), '-C', '/'])
    if CURRENT.resolve(strict=True) != release or before != {str(p): digest(p) for p in paths if p.is_file() and not p.is_symlink()}:
        raise RuntimeError('Configuration changed during backup; daily-current was not advanced')
    inventory = {
        'createdAt': stamp, 'currentRelease': release.name, 'currentReleasePath': str(release),
        'configurationRoots': [str(p) for p in paths], 'regularFileSha256': before,
        'database': 'postgres', 'databaseFormat': 'pg_dump custom',
        'limitations': ['Same-server archive only; no offsite transfer.',
                        'Archive validation is not an isolated restore drill.',
                        'Application binaries, Node runtime and APK bytes are not duplicated here; restore the exact release artifact and APK named by their archived manifests.',
                        'Root config includes credentials and must remain private; never restore over a running production database.'],
    }
    write_sync(directory / 'restore-inventory.json', (json.dumps(inventory, indent=2) + '\n').encode())
    encryption = seal_archive(directory)
    hashes = {p.name: digest(p) for p in directory.iterdir() if p.is_file()}
    write_sync(directory / 'manifest.json', (json.dumps({'createdAt': stamp, 'sha256': hashes, 'encryption': encryption, 'retention': 'No automatic deletion; private daily archives retained.', 'scopeVersion': 3}, indent=2) + '\n').encode())
    if not all(digest(directory / name) == expected for name, expected in hashes.items()):
        raise RuntimeError('Archive checksum verification failed')
    # Persist the archive's child entries before making the durable root pointer refer to it.
    archive_fd = os.open(directory, os.O_DIRECTORY)
    try:
        os.fsync(archive_fd)
    finally:
        os.close(archive_fd)
    pending = BASE / ('daily-current.' + str(os.getpid()) + '.tmp')
    write_sync(pending, (str(directory) + '\n').encode())
    os.replace(pending, BASE / 'daily-current')
    fd = os.open(BASE, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return directory


def main():
    os.umask(0o077)
    os.environ['PODMAN_IGNORE_CGROUPSV1_WARNING'] = '1'
    with LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = create_backup()
    print('Private POS database and backend/web configuration archive verified:', result.name)


if __name__ == '__main__':
    main()
