import os
from pathlib import Path
import tempfile
import unittest

from cryptography.exceptions import InvalidTag
from backup_crypto import decrypt, encrypt, load_key, seal_archive


class BackupEncryptionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key = os.urandom(32)
        self.key_path = self.root / 'key'
        self.key_path.write_bytes(self.key)
        self.key_path.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def test_archive_round_trip_and_plaintext_removal(self):
        archive = self.root / 'backup'
        archive.mkdir(mode=0o700)
        (archive / 'postgres.dump').write_bytes(os.urandom(2 * 1024 * 1024 + 37))
        (archive / 'config-secrets.tgz').write_bytes(b'private configuration')
        result = seal_archive(archive, self.key_path)
        self.assertTrue(result['authenticatedRoundTripVerified'])
        self.assertFalse(result['keyIncluded'])
        self.assertEqual([p.name for p in archive.iterdir()], ['archive.tar.aes256gcm'])
        self.assertEqual(load_key(self.key_path), self.key)

    def test_tamper_wrong_key_and_truncation_never_publish_plaintext(self):
        source = self.root / 'source'
        source.write_bytes(os.urandom(3 * 1024 * 1024 + 31))
        encrypted = self.root / 'encrypted'
        encrypt(source, encrypted, self.key)
        original = encrypted.read_bytes()
        cases = [(original, os.urandom(32)), (original[:-1], self.key),
                 (original[:70] + bytes([original[70] ^ 1]) + original[71:], self.key),
                 (b'bad header', self.key)]
        for index, (data, key) in enumerate(cases):
            with self.subTest(case=index):
                encrypted.write_bytes(data)
                output = self.root / ('out-' + str(index))
                with self.assertRaises((InvalidTag, ValueError)):
                    decrypt(encrypted, output, key)
                self.assertFalse(output.exists())
                self.assertEqual(list(self.root.glob('.pos-restore-*')), [])

    def test_existing_restore_target_and_unsafe_key_refused(self):
        source = self.root / 'source'
        source.write_bytes(b'data')
        encrypted = self.root / 'encrypted'
        encrypt(source, encrypted, self.key)
        with self.assertRaises(FileExistsError):
            decrypt(encrypted, source, self.key)
        self.assertEqual(source.read_bytes(), b'data')
        self.key_path.chmod(0o644)
        with self.assertRaises(RuntimeError):
            load_key(self.key_path)
        link = self.root / 'link'
        link.symlink_to(self.key_path)
        with self.assertRaises(RuntimeError):
            load_key(link)


if __name__ == '__main__':
    unittest.main()
