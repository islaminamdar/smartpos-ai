#!/usr/bin/python3
"""Versioned authenticated backup envelope. Keys are kept outside archived roots."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b'INTERNEXT-POS-BACKUP\x00\x01'
KEY = Path('/etc/internext-pos/backup-encryption.key')
CHUNK = 1024 * 1024


def load_key(path=KEY):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise RuntimeError('Backup key must be an owner-only regular file')
    key = path.read_bytes()
    if len(key) != 32:
        raise RuntimeError('Backup key must contain exactly 32 bytes')
    return key


def hash_file(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(CHUNK), b''):
            h.update(chunk)
    return h.hexdigest()


def encrypt(source, destination, key):
    nonce = os.urandom(12)
    header = MAGIC + nonce
    cipher = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    cipher.authenticate_additional_data(header)
    with source.open('rb') as src, destination.open('xb') as dst:
        os.fchmod(dst.fileno(), 0o600)
        dst.write(header)
        for chunk in iter(lambda: src.read(CHUNK), b''):
            dst.write(cipher.update(chunk))
        dst.write(cipher.finalize())
        dst.write(cipher.tag)
        dst.flush()
        os.fsync(dst.fileno())


def decrypt(source, destination, key):
    # Unauthenticated plaintext is never published at the requested destination.
    if destination.exists():
        raise FileExistsError('Refusing to overwrite restore output')
    temporary = None
    try:
        with source.open('rb') as src:
            header = src.read(len(MAGIC) + 12)
            size = source.stat().st_size - len(header) - 16
            if not header.startswith(MAGIC) or len(header) != len(MAGIC) + 12 or size < 0:
                raise ValueError('Invalid encrypted archive header')
            src.seek(-16, os.SEEK_END)
            tag = src.read(16)
            src.seek(len(header))
            cipher = Cipher(algorithms.AES(key), modes.GCM(header[-12:], tag)).decryptor()
            cipher.authenticate_additional_data(header)
            with tempfile.NamedTemporaryFile(prefix='.pos-restore-', dir=destination.parent, delete=False) as dst:
                temporary = Path(dst.name)
                remaining = size
                while remaining:
                    chunk = src.read(min(CHUNK, remaining))
                    if not chunk:
                        raise ValueError('Truncated encrypted archive')
                    dst.write(cipher.update(chunk))
                    remaining -= len(chunk)
                dst.write(cipher.finalize())
                dst.flush()
                os.fsync(dst.fileno())
        # Atomic exclusive publication, also refuses symlink/late-existing targets.
        os.link(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def seal_archive(directory, key_path=KEY):
    """Encrypt and authenticate a fresh archive, then remove only its staged plaintext."""
    key = load_key(key_path)
    files = sorted(directory.iterdir())
    if any(not p.is_file() or p.is_symlink() for p in files):
        raise RuntimeError('Unexpected archive input')
    hashes = {p.name: hash_file(p) for p in files}
    payload = directory / 'archive.tar'
    with payload.open('xb') as output:
        os.fchmod(output.fileno(), 0o600)
        with tarfile.open(fileobj=output, mode='w') as archive:
            for path in files:
                archive.add(path, arcname=path.name, recursive=False)
        output.flush()
        os.fsync(output.fileno())
    encrypted = directory / 'archive.tar.aes256gcm'
    encrypt(payload, encrypted, key)
    restored = directory / 'verified-restore.tar'
    decrypt(encrypted, restored, key)
    if hash_file(payload) != hash_file(restored):
        raise RuntimeError('Encrypted archive round-trip did not match')
    with tarfile.open(restored, 'r:') as archive:
        members = archive.getmembers()
        if sorted(m.name for m in members) != sorted(hashes) or any(not m.isfile() for m in members):
            raise RuntimeError('Encrypted archive inventory mismatch')
        for member in members:
            stream = archive.extractfile(member)
            h = hashlib.sha256()
            for chunk in iter(lambda: stream.read(CHUNK), b''):
                h.update(chunk)
            if h.hexdigest() != hashes[member.name]:
                raise RuntimeError('Encrypted archive payload mismatch')
    # Only delete files just created by this backup, after authenticated readback.
    for path in [*files, payload, restored]:
        path.unlink()
    return {
        'algorithm': 'AES-256-GCM', 'formatVersion': 1,
        'keyFile': str(key_path), 'keyIncluded': False,
        'authenticatedRoundTripVerified': True,
        'payloadSha256': hashes,
    }


def main():
    parser = argparse.ArgumentParser(description='Decrypt a POS archive into a NEW private tar file; never restores over a database.')
    parser.add_argument('archive', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--key', type=Path, default=KEY)
    args = parser.parse_args()
    decrypt(args.archive, args.output, load_key(args.key))
    print(json.dumps({'authenticated': True, 'output': str(args.output), 'sha256': hash_file(args.output)}))


if __name__ == '__main__':
    main()
