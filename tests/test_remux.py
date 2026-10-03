import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import remux_bad_mp4s as remux


class RollbackTests(unittest.TestCase):
    def test_changed_source_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "original.mp4"
            staged = Path(directory) / "staged.mp4"
            source.write_bytes(b"original")
            expected = source.stat()
            source.write_bytes(b"new contents from another process")
            staged.write_bytes(b"outdated replacement")
            with self.assertRaises(remux.RemuxPreparationError):
                remux.replace_from_staging(source, staged, expected)
            self.assertEqual(source.read_bytes(), b"new contents from another process")
            self.assertTrue(staged.exists())

    def test_directory_sync_failure_after_backup_restores_original(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "original.mp4"
            staged = Path(directory) / "staged.mp4"
            source.write_bytes(b"original video")
            staged.write_bytes(b"replacement")
            with patch.object(remux, "fsync_directory", side_effect=[OSError("sync failed"), None]), \
                 patch.object(remux, "sync_file_system"):
                with self.assertRaises(OSError):
                    remux.replace_from_staging(source, staged)
            self.assertEqual(source.read_bytes(), b"original video")
            self.assertEqual(staged.read_bytes(), b"replacement")
            self.assertEqual(list(Path(directory).glob("*.segmentloop-backup-*")), [])


if __name__ == "__main__":
    unittest.main()
