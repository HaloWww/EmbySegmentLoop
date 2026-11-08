import tempfile
import unittest
import os
import subprocess
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
import remux_bad_mp4s as remux


class RollbackTests(unittest.TestCase):
    def test_long_utf8_basename_replaces_without_exceeding_name_max(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / ("测" * 80 + ".mp4")
            staged = Path(directory) / "staged.mp4"
            source.write_bytes(b"original video")
            staged.write_bytes(b"replacement")
            rename = os.replace
            destinations = []

            def checked_replace(src, dst):
                self.assertLessEqual(len(os.fsencode(Path(dst).name)), 255)
                destinations.append(Path(dst))
                rename(src, dst)

            with patch.object(remux.os, "replace", side_effect=checked_replace), \
                 patch.object(remux.os, "chown", create=True), \
                 patch.object(remux.os, "fsync"), \
                 patch.object(remux, "fsync_directory"), \
                 patch.object(remux, "sync_file_system"):
                remux.replace_from_staging(source, staged)
            self.assertEqual(source.read_bytes(), b"replacement")
            self.assertTrue(destinations[0].name.startswith(".segmentloop-backup-"))
            self.assertFalse(staged.exists())
            self.assertEqual(list(Path(directory).iterdir()), [source])

    def test_long_name_rollback_after_final_sync_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / ("测" * 80 + ".mp4")
            staged = Path(directory) / "staged.mp4"
            source.write_bytes(b"original video")
            staged.write_bytes(b"replacement")
            with patch.object(remux.os, "chown", create=True), \
                 patch.object(remux.os, "fsync"), \
                 patch.object(remux, "fsync_directory"), \
                 patch.object(remux, "sync_file_system", side_effect=[OSError("disk sync failed"), None]):
                with self.assertRaises(OSError):
                    remux.replace_from_staging(source, staged)
            self.assertEqual(source.read_bytes(), b"original video")
            self.assertEqual(list(Path(directory).iterdir()), [source])

    def test_backup_collision_never_overwrites_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "original.mp4"
            staged = Path(directory) / "staged.mp4"
            backup = Path(directory) / ".segmentloop-backup-test"
            source.write_bytes(b"original")
            staged.write_bytes(b"replacement")
            backup.write_bytes(b"existing backup")
            with patch.object(remux.uuid, "uuid4", return_value=SimpleNamespace(hex="test")):
                with self.assertRaises(remux.RemuxPreparationError):
                    remux.replace_from_staging(source, staged)
            self.assertEqual(source.read_bytes(), b"original")
            self.assertEqual(backup.read_bytes(), b"existing backup")
            self.assertTrue(staged.exists())

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
            with patch.object(remux.os, "fsync"), \
                 patch.object(remux, "fsync_directory", side_effect=[OSError("sync failed"), None]), \
                 patch.object(remux, "sync_file_system"):
                with self.assertRaises(OSError):
                    remux.replace_from_staging(source, staged)
            self.assertEqual(source.read_bytes(), b"original video")
            self.assertEqual(staged.read_bytes(), b"replacement")
            self.assertEqual(list(Path(directory).glob("*.segmentloop-backup-*")), [])


def media_metadata(*, missing_aac=False):
    audio = {"index": 1, "codec_type": "audio", "codec_name": "aac"}
    if not missing_aac:
        audio.update(profile="LC", extradata_size=5)
    return {
        "format": {"duration": "30", "tags": {"major_brand": "isom"}},
        "streams": [{"index": 0, "codec_type": "video", "codec_name": "h264"}, audio],
    }


def atom(name):
    return (8).to_bytes(4, "big") + name.encode("ascii")


class BrowserCompatibilityTests(unittest.TestCase):
    def test_fragmented_mp4_is_detected_with_front_moov_and_valid_aac(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "fragmented.mp4"
            source.write_bytes(atom("ftyp") + atom("moov") + atom("moof") + atom("mdat"))
            with patch.object(remux, "probe", return_value=media_metadata()), \
                 patch.object(remux, "first_packet_positions", return_value=(100, 200)):
                problematic, reasons, _ = remux.inspect_layout(source, "ffprobe", 8 * 1024**2)
            self.assertTrue(problematic)
            self.assertTrue(any("分片 MP4" in reason for reason in reasons))

    def test_missing_aac_configuration_is_detected_without_fragmentation(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "missing-config.mp4"
            source.write_bytes(atom("moov") + atom("mdat"))
            with patch.object(remux, "probe", return_value=media_metadata(missing_aac=True)), \
                 patch.object(remux, "first_packet_positions", return_value=(100, 200)):
                problematic, reasons, _ = remux.inspect_layout(source, "ffprobe", 8 * 1024**2)
            self.assertTrue(problematic)
            self.assertTrue(any("AAC" in reason for reason in reasons))

    def test_normal_mp4_with_valid_aac_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "normal.mp4"
            source.write_bytes(atom("moov") + atom("mdat"))
            with patch.object(remux, "probe", return_value=media_metadata()), \
                 patch.object(remux, "first_packet_positions", return_value=(100, 200)):
                problematic, _, _ = remux.inspect_layout(source, "ffprobe", 8 * 1024**2)
            self.assertFalse(problematic)

    def test_output_with_missing_aac_config_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output.mp4"
            output.write_bytes(atom("moov") + atom("mdat"))
            with patch.object(remux, "probe", return_value=media_metadata(missing_aac=True)):
                with self.assertRaisesRegex(RuntimeError, "AAC"):
                    remux.validate_remux(media_metadata(), output, "ffprobe")

    def test_fragmented_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output.mp4"
            output.write_bytes(atom("moov") + atom("moof") + atom("mdat"))
            with patch.object(remux, "probe", return_value=media_metadata()):
                with self.assertRaisesRegex(RuntimeError, "分片 MP4"):
                    remux.validate_remux(media_metadata(), output, "ffprobe")

    def check_copy_then_aac(self, copy_fixed_config):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"original")
            commands = []

            def execute(command, environment):
                commands.append(command)
                Path(command[-1]).write_bytes(atom("moov") + atom("mdat"))
                return subprocess.CompletedProcess(command, 0, stderr="")

            def inspect(path, ffprobe):
                transcoded = "-c:a" in commands[-1]
                return media_metadata(missing_aac=not (copy_fixed_config or transcoded))

            with patch.object(remux, "run_remux_command", side_effect=execute), \
                 patch.object(remux, "probe", side_effect=inspect), \
                 patch.object(remux.shutil, "disk_usage", return_value=SimpleNamespace(free=1024**3)), \
                 patch.object(remux, "replace_from_staging") as replace:
                remux.remux(source, media_metadata(missing_aac=True), "ffmpeg", "ffprobe", Path(directory), None)
            self.assertEqual(len(commands), 1 if copy_fixed_config else 2)
            self.assertNotIn("-c:a", commands[0])
            if not copy_fixed_config:
                self.assertEqual(commands[1][commands[1].index("-c:a") + 1], "aac")
                self.assertEqual(commands[1][commands[1].index("-c") + 1], "copy")
            replace.assert_called_once()
            self.assertEqual(source.read_bytes(), b"original")

    def test_successful_copy_with_missing_aac_config_retries_audio_only(self):
        self.check_copy_then_aac(copy_fixed_config=False)

    def test_copy_that_repairs_aac_config_does_not_transcode_audio(self):
        self.check_copy_then_aac(copy_fixed_config=True)

    def test_unsupported_pcm_audio_still_uses_aac_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"original")
            metadata = media_metadata()
            metadata["streams"][1]["codec_name"] = "pcm_f32le"
            commands = []

            def execute(command, environment):
                commands.append(command)
                Path(command[-1]).write_bytes(atom("moov") + atom("mdat"))
                if len(commands) == 1:
                    return subprocess.CompletedProcess(command, 1, stderr="Could not find tag for codec pcm_f32le")
                return subprocess.CompletedProcess(command, 0, stderr="")

            with patch.object(remux, "run_remux_command", side_effect=execute), \
                 patch.object(remux, "probe", return_value=media_metadata()), \
                 patch.object(remux.shutil, "disk_usage", return_value=SimpleNamespace(free=1024**3)), \
                 patch.object(remux, "replace_from_staging") as replace:
                remux.remux(source, metadata, "ffmpeg", "ffprobe", Path(directory), None)
            self.assertEqual(len(commands), 2)
            self.assertIn("-c:a", commands[1])
            replace.assert_called_once()

    def test_failed_aac_retry_never_replaces_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"original")
            calls = []

            def execute(command, environment):
                calls.append(command)
                Path(command[-1]).write_bytes(b"partial output")
                return subprocess.CompletedProcess(command, 0 if len(calls) == 1 else 1, stderr="encoding failed")

            with patch.object(remux, "run_remux_command", side_effect=execute), \
                 patch.object(remux, "probe", return_value=media_metadata(missing_aac=True)), \
                 patch.object(remux.shutil, "disk_usage", return_value=SimpleNamespace(free=1024**3)), \
                 patch.object(remux, "replace_from_staging") as replace:
                with self.assertRaises(remux.RemuxPreparationError):
                    remux.remux(source, media_metadata(missing_aac=True), "ffmpeg", "ffprobe", Path(directory), None)
            replace.assert_not_called()
            self.assertEqual(source.read_bytes(), b"original")
            self.assertEqual(list(Path(directory).iterdir()), [source])


if __name__ == "__main__":
    unittest.main()
