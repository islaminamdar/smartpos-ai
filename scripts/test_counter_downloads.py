"""Focused release-contract, SDK-verification, publish-order and rollback tests.

All files are temporary; fake APK bytes only exercise server transport integrity.
Cryptographic verification is covered by the preparer's real SDK invocation in QA.
"""
import builtins
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import counter_downloads as contract


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


publisher = module('counter_publisher', 'publish-counter-downloads.py')
preparer = module('counter_preparer', 'prepare-counter-downloads.py')


def manifest(version='1.1.0', code=2, body=b'new APK bytes'):
    return {
        'applicationId': contract.APPLICATION_ID, 'name': 'Internext Counter', 'version': version,
        'versionCode': code, 'minimumAndroid': '8.0', 'minSdk': 26, 'mode': 'online',
        'offlineSalesEnabled': False, 'sha256': hashlib.sha256(body).hexdigest(),
        'signingCertificateSha256': contract.SIGNER_SHA256, 'apkBytes': len(body),
        'sourceCommit': 'a' * 40, 'webRelease': 'b' * 40, 'preparedAt': '2026-10-17T00:00:00+00:00',
        'download': contract.ORIGIN + '/downloads/internext-pos-counter-' + version + '.apk',
        'counter': contract.ORIGIN + '/counter',
    }


def stage(root, release=None):
    root.mkdir()
    release = release or manifest()
    (root / contract.apk_name(release)).write_bytes(b'new APK bytes')
    (root / 'release.json').write_text(json.dumps(release))
    (root / 'index.html').write_text('New landing')
    (root / 'downloads.conf').write_text('ProxyPass /downloads/ !\n')
    return root


class ContractTests(unittest.TestCase):
    def test_current_and_new_manifest(self):
        contract.validate_manifest(manifest('1.0.0', 1))
        current = manifest()
        current.update(schemaVersion=1, releaseNotes='Update after finishing the shift.')
        contract.validate_manifest(current)

    def test_malformed_release_rejected(self):
        changes = [('versionCode', True), ('versionCode', 0), ('versionCode', 2100000001),
                   ('minSdk', 25), ('apkBytes', contract.MAX_APK_BYTES + 1),
                   ('applicationId', 'other'), ('signingCertificateSha256', '0' * 64),
                   ('sha256', '0' * 63), ('sourceCommit', '../file'), ('offlineSalesEnabled', 0),
                   ('download', 'https://attacker.example/update.apk'), ('version', '../x'),
                   ('version', '01.1.0'), ('schemaVersion', True), ('releaseNotes', 'x' * 2001)]
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                contract.validate_manifest({**manifest(), key: value})

    def test_exact_url_rejects_query_fragment_port_and_wrong_version(self):
        for url in [manifest()['download'] + '?x=1', manifest()['download'] + '#x',
                    manifest()['download'].replace('.info/', '.info:443/'),
                    manifest()['download'].replace('1.1.0', '1.2.0')]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                contract.validate_manifest({**manifest(), 'download': url})

    def test_progression_and_exact_retry(self):
        self.assertEqual('forward', contract.validate_progression(manifest(), manifest('1.0.0', 1)))
        self.assertEqual('identical', contract.validate_progression(manifest(), manifest()))
        for incoming in [manifest('0.9.0', 1), manifest('1.1.0', 1), manifest('1.0.0', 3),
                         {**manifest(), 'preparedAt': '2026-10-17T01:00:00+00:00'}]:
            with self.subTest(incoming=incoming['version']), self.assertRaises(ValueError):
                contract.validate_progression(incoming, manifest())

    def test_duplicate_json_and_oversized_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            path.write_text(json.dumps(manifest())[:-1] + ',"versionCode":2}')
            with self.assertRaises(ValueError):
                contract.read_manifest(path)
            path.write_text(' ' * (contract.MAX_MANIFEST_BYTES + 1))
            with self.assertRaises(ValueError):
                contract.read_manifest(path)

    def test_stage_order_integrity_extras_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = stage(Path(directory) / 'stage')
            self.assertEqual([contract.apk_name(manifest()), 'index.html', 'release.json'], contract.validate_stage(root)[1])
            apk = root / contract.apk_name(manifest())
            apk.write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                contract.validate_stage(root)
            apk.write_bytes(b'new APK bytes')
            extra = root / 'signing.properties'
            extra.write_text('not a real credential')
            with self.assertRaises(ValueError):
                contract.validate_stage(root)
            extra.unlink()
            index = root / 'index.html'
            index.unlink()
            index.symlink_to(root / 'release.json')
            with self.assertRaises(ValueError):
                contract.validate_stage(root)


class SdkTests(unittest.TestCase):
    signature = 'Signer #1 certificate SHA-256 digest: ' + contract.SIGNER_SHA256 + '\n'
    badging = "package: name='info.internext.pos.counter' versionCode='2' versionName='1.1.0'\nsdkVersion:'26'\nuses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'\n"

    def verify(self, signature=None, badging=None):
        outputs = [subprocess.CompletedProcess([], 0, self.signature if signature is None else signature),
                   subprocess.CompletedProcess([], 0, self.badging if badging is None else badging)]
        with mock.patch.object(preparer.subprocess, 'run', side_effect=outputs) as execute:
            result = preparer.verify_apk(Path('/private/test.apk'), Path('/sdk/build-tools/36.0.0'))
            self.assertEqual('verify', execute.call_args_list[0].args[0][1])
            self.assertEqual(['dump', 'badging'], execute.call_args_list[1].args[0][1:3])
            return result

    def test_verified_metadata(self):
        self.assertEqual(2, self.verify()['versionCode'])

    def test_wrong_extra_or_missing_signer_rejected(self):
        for signature in ['', self.signature.replace(contract.SIGNER_SHA256, '0' * 64),
                          self.signature + self.signature.replace('#1', '#2')]:
            with self.subTest(signature=signature), self.assertRaises(ValueError):
                self.verify(signature=signature)

    def test_wrong_identity_debug_min_sdk_or_old_release(self):
        for badging in [self.badging.replace('info.internext.pos.counter', 'other.app'),
                        self.badging + 'application-debuggable\n', self.badging.replace("sdkVersion:'26'", "sdkVersion:'28'"),
                        self.badging.replace("versionCode='2'", "versionCode='1'"),
                        self.badging.replace('REQUEST_INSTALL_PACKAGES', 'OTHER_PERMISSION')]:
            with self.subTest(badging=badging), self.assertRaises(ValueError):
                self.verify(badging=badging)

    def test_sdk_failure_stops_preparation(self):
        with mock.patch.object(preparer.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['apksigner'])):
            with self.assertRaises(subprocess.CalledProcessError):
                preparer.verify_apk(Path('/test.apk'), Path('/tools'))

    def test_preparation_outputs_only_public_files_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            apk = root / 'input.apk'
            apk.write_bytes(b'new APK bytes')
            metadata = {key: manifest()[key] for key in ['applicationId', 'versionCode', 'version', 'minSdk', 'signingCertificateSha256']}
            with mock.patch.object(preparer, 'verify_apk', return_value=metadata):
                result = preparer.prepare(apk, root / 'stage', 'a' * 40, 'b' * 40, root, 'Verified update')
                self.assertEqual('prepared', result['status'])
                contract.validate_stage(root / 'stage')
                self.assertNotIn('{{', (root / 'stage/index.html').read_text())
                self.assertEqual(0o700, (root / 'stage').stat().st_mode & 0o777)
                with self.assertRaises(ValueError):
                    preparer.prepare(apk, root / 'stage', 'a' * 40, 'b' * 40, root, 'Verified update')


class PublicationTests(unittest.TestCase):
    def exercise(self, fail=False, identical=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incoming = stage(root / 'stage')
            public = root / 'var/www/internext-pos-downloads'
            public.mkdir(parents=True)
            old = manifest() if identical else manifest('1.0.0', 1, b'old APK bytes')
            (public / 'release.json').write_text(json.dumps(old))
            (public / 'index.html').write_text('Old landing')
            (public / contract.apk_name(old)).write_bytes(b'new APK bytes' if identical else b'old APK bytes')
            config = root / 'etc/apache2/conf.d/userdata/ssl/2_4/internext/pos.internext.info/pos.conf'
            config.parent.mkdir(parents=True)
            config.write_text('ProxyPass /downloads/ !\nProxyPass / http://127.0.0.1:3046/\n')
            release = root / ('opt/internext-pos/releases/' + 'b' * 40)
            release.mkdir(parents=True)
            (root / 'opt/internext-pos/current').symlink_to(release)
            (root / 'var/lib/internext-pos-backups').mkdir(parents=True)
            calls = []
            real_atomic = publisher.atomic_copy

            def record(source, target):
                calls.append(target.name)
                real_atomic(source, target)
                if fail and target.name == 'release.json' and len(calls) == 3:
                    raise RuntimeError('Injected failure after manifest replacement')

            def mapped(path):
                path = str(path)
                return root / path.lstrip('/') if path.startswith(('/var/', '/etc/', '/opt/')) else Path(path)

            with mock.patch.object(publisher, 'Path', side_effect=mapped), \
                 mock.patch.object(publisher.os, 'geteuid', return_value=0), \
                 mock.patch.object(publisher, 'open', side_effect=lambda *args: builtins.open(root / 'lock', 'a'), create=True), \
                 mock.patch.object(publisher.sys, 'argv', ['publish', str(incoming)]), \
                 mock.patch.object(publisher, 'atomic_copy', side_effect=record), \
                 mock.patch.object(publisher, 'run') as commands, mock.patch('builtins.print'):
                if fail:
                    with self.assertRaises(RuntimeError):
                        publisher.main()
                else:
                    publisher.main()
                commands.assert_not_called()  # Existing Apache config remains untouched.
            self.assertEqual([contract.apk_name(manifest()), 'index.html', 'release.json'], calls[:3])
            self.assertEqual(old if fail else manifest(), json.loads((public / 'release.json').read_text()))
            self.assertEqual('Old landing' if fail else 'New landing', (public / 'index.html').read_text())
            self.assertTrue((public / contract.apk_name(old)).is_file())
            self.assertTrue((public / contract.apk_name(manifest())).is_file())
            if fail:
                self.assertEqual('release.json', calls[3])

    def test_publish_artifact_then_landing_then_manifest(self):
        self.exercise()

    def test_identical_retry(self):
        self.exercise(identical=True)

    def test_rollback_withdraws_manifest_first_and_preserves_apks(self):
        self.exercise(fail=True)


if __name__ == '__main__':
    unittest.main()
