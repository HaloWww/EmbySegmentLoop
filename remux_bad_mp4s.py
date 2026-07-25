#!/usr/bin/env python3
"""Detect problematic video containers and remux them using RAM-first staging."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path


VIDEO_SUFFIXES = {
    ".mp4",
    ".m4v",
    ".mov",
    ".mkv",
    ".webm",
    ".avi",
    ".ts",
    ".m2ts",
    ".mts",
}
MP4_SUFFIXES = {".mp4", ".m4v", ".mov"}
DEFAULT_GAP_BYTES = 8 * 1024 * 1024
RAM_RESERVE_BYTES = 256 * 1024 * 1024
CACHE_COMMIT_INTERVAL = 500
CACHE_POLICY_VERSION = 2
AAC_FALLBACK_BITRATE = "320k"
UNSUPPORTED_CONTAINER_CODEC_MARKERS = (
    "could not find tag for codec",
    "not currently supported in container",
    "incorrect codec parameters",
)


class RemuxPreparationError(RuntimeError):
    """The RAM-side remux/validation failed before the source was replaced."""


class ScanCache:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=DELETE")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA temp_store=MEMORY")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS scanned_files (
                path TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                device INTEGER NOT NULL,
                inode INTEGER NOT NULL,
                policy TEXT NOT NULL,
                status TEXT NOT NULL,
                detail TEXT NOT NULL,
                checked_at_ns INTEGER NOT NULL
            )
            """
        )
        self.connection.commit()
        self.pending = 0

    def matched_status(self, path: Path, stat: os.stat_result, policy: str) -> str | None:
        row = self.connection.execute(
            """
            SELECT status, size, mtime_ns, device, inode, policy
            FROM scanned_files WHERE path = ?
            """,
            (str(path),),
        ).fetchone()
        if not row:
            return None
        status, size, mtime_ns, device, inode, saved_policy = row
        if (
            size == stat.st_size
            and mtime_ns == stat.st_mtime_ns
            and device == stat.st_dev
            and inode == stat.st_ino
            and saved_policy == policy
        ):
            return str(status)
        return None

    def record(
        self,
        path: Path,
        stat: os.stat_result,
        policy: str,
        status: str,
        detail: str = "",
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO scanned_files
                (path, size, mtime_ns, device, inode, policy, status, detail, checked_at_ns)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                size=excluded.size,
                mtime_ns=excluded.mtime_ns,
                device=excluded.device,
                inode=excluded.inode,
                policy=excluded.policy,
                status=excluded.status,
                detail=excluded.detail,
                checked_at_ns=excluded.checked_at_ns
            """,
            (
                str(path),
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_dev,
                stat.st_ino,
                policy,
                status,
                detail[:4000],
                time.time_ns(),
            ),
        )
        self.pending += 1
        if self.pending >= CACHE_COMMIT_INTERVAL:
            self.commit()

    def commit(self) -> None:
        if self.pending:
            self.connection.commit()
            self.pending = 0

    def close(self) -> None:
        try:
            self.commit()
        finally:
            self.connection.close()

    def failures_under(self, directory: Path) -> list[tuple[str, str, int]]:
        rows = self.connection.execute(
            """
            SELECT path, detail, checked_at_ns
            FROM scanned_files
            WHERE status = 'failed'
            ORDER BY path
            """
        ).fetchall()
        result: list[tuple[str, str, int]] = []
        for saved_path, detail, checked_at_ns in rows:
            try:
                if Path(saved_path).is_relative_to(directory):
                    result.append((str(saved_path), str(detail), int(checked_at_ns)))
            except (OSError, ValueError):
                continue
        return result


def run(command: list[str], *, capture: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        detail = stderr if stderr else "命令没有输出错误详情"
        raise RuntimeError(
            f"命令退出码 {result.returncode}: {subprocess.list2cmdline(command)}\n"
            f"    {detail}"
        )
    return result


def probe(path: Path, ffprobe: str) -> dict:
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            (
                "format=format_name,duration,size:"
                "format_tags=major_brand:"
                "stream=index,codec_type,codec_name"
            ),
            "-of",
            "json",
            str(path),
        ]
    )
    return json.loads(result.stdout)


def inspect_bif_timing_compatibility(
    path: Path,
    ffprobe: str,
    metadata: dict,
    moov_after_mdat: bool,
) -> tuple[bool, list[str]]:
    """Detect the QuickTime layout that makes Emby BIF use opening frames.

    The confirmed bad sample advertises the QuickTime ``qt`` major brand while
    keeping ``moov`` behind ``mdat``. Emby 4.9.5 generated 10-second BIF labels
    from consecutive opening frames for that layout. Normal ISO MP4 files and
    QuickTime files with a front-loaded index are not included in this rule.
    """

    if path.suffix.lower() not in MP4_SUFFIXES:
        return False, []

    format_info = metadata.get("format", {})
    tags = format_info.get("tags") or {}
    major_brand = str(tags.get("major_brand") or "").strip().lower()
    if major_brand != "qt" or not moov_after_mdat:
        return False, []

    result = run(
        [
            ffprobe,
            "-v",
            "warning",
            "-show_entries",
            "format=format_name",
            "-of",
            "json",
            str(path),
        ]
    )
    reasons = [
        (
            "QuickTime qt 容器且 moov 尾置，可能导致 Emby 4.9.5 BIF "
            "把开头连续帧错误标记为每 10 秒缩略图"
        )
    ]
    warnings = (result.stderr or "").lower()
    warning_names: list[str] = []
    if "unknown dref type" in warnings:
        warning_names.append("异常 dref")
    if "unknown cover type" in warnings:
        warning_names.append("异常封面类型")
    if warning_names:
        reasons.append("FFprobe 同时报告：" + "、".join(warning_names))
    return True, reasons


def top_level_atoms(path: Path) -> dict[str, tuple[int, int]]:
    atoms: dict[str, tuple[int, int]] = {}
    total = path.stat().st_size
    position = 0
    with path.open("rb") as stream:
        while position + 8 <= total:
            stream.seek(position)
            header = stream.read(16)
            size = int.from_bytes(header[:4], "big")
            atom_type = header[4:8].decode("latin1")
            header_size = 8
            if size == 1:
                size = int.from_bytes(header[8:16], "big")
                header_size = 16
            elif size == 0:
                size = total - position
            if size < header_size or position + size > total:
                break
            atoms.setdefault(atom_type, (position, size))
            position += size
    return atoms


def first_packet_positions(
    path: Path,
    ffprobe: str,
    start_seconds: float,
    video_index: int,
    audio_index: int,
) -> tuple[int, int] | None:
    result = run(
        [
            ffprobe,
            "-v",
            "error",
            "-read_intervals",
            f"{start_seconds:.3f}%+2",
            "-show_packets",
            "-show_entries",
            "packet=stream_index,pos",
            "-of",
            "csv=p=0",
            str(path),
        ]
    )
    positions: dict[int, int] = {}
    for line in result.stdout.splitlines():
        fields = line.split(",")
        if len(fields) < 2:
            continue
        try:
            stream_index = int(fields[0])
            position = int(fields[-1])
        except ValueError:
            continue
        if stream_index in (video_index, audio_index):
            positions.setdefault(stream_index, position)
        if video_index in positions and audio_index in positions:
            return positions[video_index], positions[audio_index]
    return None


def inspect_layout(
    path: Path,
    ffprobe: str,
    gap_limit: int,
    fix_moov_only: bool = False,
) -> tuple[bool, list[str], dict]:
    metadata = probe(path, ffprobe)
    reasons: list[str] = []
    packet_gap_problem = False
    atoms = top_level_atoms(path) if path.suffix.lower() in MP4_SUFFIXES else {}
    moov = atoms.get("moov")
    mdat = atoms.get("mdat")
    moov_problem = bool(moov and mdat and moov[0] > mdat[0])
    if moov_problem:
        reasons.append(f"moov 位于 mdat 之后（moov offset={moov[0]}）")
    bif_timing_problem, bif_reasons = inspect_bif_timing_compatibility(
        path,
        ffprobe,
        metadata,
        moov_problem,
    )
    reasons.extend(bif_reasons)

    streams = metadata.get("streams", [])
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    duration = float(metadata.get("format", {}).get("duration") or 0)
    if video and audio and duration > 4:
        gaps: list[tuple[float, int]] = []
        for ratio in (0.25, 0.50, 0.75):
            sample_time = duration * ratio
            positions = first_packet_positions(
                path,
                ffprobe,
                sample_time,
                int(video["index"]),
                int(audio["index"]),
            )
            if positions:
                gaps.append((sample_time, abs(positions[0] - positions[1])))
        if gaps:
            worst_time, worst_gap = max(gaps, key=lambda item: item[1])
            if worst_gap > gap_limit:
                packet_gap_problem = True
                reasons.append(
                    f"音视频包未正常交错（{worst_time:.1f}s 位置差 {worst_gap / 1024 / 1024:.1f} MiB）"
                )

    return (
        bif_timing_problem
        or packet_gap_problem
        or (fix_moov_only and moov_problem)
    ), reasons, metadata


def validate_remux(
    source_metadata: dict,
    output: Path,
    ffprobe: str,
    allow_audio_transcode: bool = False,
) -> None:
    output_metadata = probe(output, ffprobe)
    source_duration = float(source_metadata.get("format", {}).get("duration") or 0)
    output_duration = float(output_metadata.get("format", {}).get("duration") or 0)
    tolerance = max(1.0, source_duration * 0.001)
    if abs(source_duration - output_duration) > tolerance:
        raise RuntimeError(
            f"重封装前后时长不一致: {source_duration:.3f}s -> {output_duration:.3f}s"
        )

    source_streams = source_metadata.get("streams", [])
    output_streams = output_metadata.get("streams", [])
    source_summary = [
        (item.get("codec_type"), item.get("codec_name")) for item in source_streams
    ]
    output_summary = [
        (item.get("codec_type"), item.get("codec_name")) for item in output_streams
    ]
    if len(source_streams) != len(output_streams):
        raise RuntimeError(f"重封装前后流数量不一致: {source_summary} -> {output_summary}")
    for source_stream, output_stream in zip(source_streams, output_streams):
        source_type = source_stream.get("codec_type")
        output_type = output_stream.get("codec_type")
        source_codec = source_stream.get("codec_name")
        output_codec = output_stream.get("codec_name")
        if source_type != output_type:
            raise RuntimeError(
                f"重封装前后流类型不一致: {source_summary} -> {output_summary}"
            )
        if allow_audio_transcode and source_type == "audio":
            if output_codec != "aac":
                raise RuntimeError(
                    f"音频回退输出不是 AAC: {source_summary} -> {output_summary}"
                )
        elif source_codec != output_codec:
            raise RuntimeError(f"重封装前后编码发生变化: {source_summary} -> {output_summary}")

    if output.suffix.lower() in MP4_SUFFIXES:
        atoms = top_level_atoms(output)
        if atoms.get("moov") and atoms.get("mdat") and atoms["moov"][0] > atoms["mdat"][0]:
            raise RuntimeError("输出文件的 moov 仍位于 mdat 之后")
        bif_problem, bif_reasons = inspect_bif_timing_compatibility(
            output,
            ffprobe,
            output_metadata,
            bool(
                atoms.get("moov")
                and atoms.get("mdat")
                and atoms["moov"][0] > atoms["mdat"][0]
            ),
        )
        if bif_problem:
            raise RuntimeError("重封装后 BIF 时间戳异常仍存在：" + "；".join(bif_reasons))


def fsync_directory(directory: Path) -> None:
    directory_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def sync_file_system(path: Path) -> None:
    sync_command = shutil.which("sync")
    if not sync_command:
        raise RuntimeError("找不到 sync 命令，无法确认数据已经写入硬盘")
    run([sync_command, "-f", str(path)])


def replace_from_staging(source: Path, staged_output: Path) -> None:
    token = uuid.uuid4().hex
    backup = source.with_name(f".{source.name}.segmentloop-backup-{token}")
    original_stat = source.stat()
    if original_stat.st_nlink != 1:
        raise RuntimeError(f"原文件存在 {original_stat.st_nlink} 个硬链接，为避免破坏链接关系已跳过")

    staged_fd = os.open(staged_output, os.O_RDONLY)
    try:
        os.fsync(staged_fd)
    finally:
        os.close(staged_fd)
    same_filesystem = staged_output.stat().st_dev == source.parent.stat().st_dev

    os.replace(source, backup)
    fsync_directory(source.parent)
    try:
        if same_filesystem:
            os.replace(staged_output, source)
            fsync_directory(source.parent)
        else:
            with staged_output.open("rb") as reader, source.open("xb") as writer:
                shutil.copyfileobj(reader, writer, length=8 * 1024 * 1024)
                writer.flush()
                os.fsync(writer.fileno())
        os.chown(source, original_stat.st_uid, original_stat.st_gid, follow_symlinks=False)
        shutil.copystat(backup, source, follow_symlinks=False)
        source_fd = os.open(source, os.O_RDONLY)
        try:
            os.fsync(source_fd)
        finally:
            os.close(source_fd)
        fsync_directory(source.parent)

        # This is deliberately blocking. The next media file must not start until
        # the filesystem containing the replacement confirms all writes.
        sync_file_system(source)
        backup.unlink()
        fsync_directory(source.parent)
    except BaseException:
        if backup.exists():
            source.unlink(missing_ok=True)
            os.replace(backup, source)
            fsync_directory(source.parent)
            sync_file_system(source)
        raise


def should_retry_audio_as_aac(path: Path, metadata: dict, ffmpeg_error: str) -> bool:
    if path.suffix.lower() not in MP4_SUFFIXES:
        return False
    error_text = ffmpeg_error.lower()
    if not any(marker in error_text for marker in UNSUPPORTED_CONTAINER_CODEC_MARKERS):
        return False
    audio_codecs = {
        str(stream.get("codec_name") or "").lower()
        for stream in metadata.get("streams", [])
        if stream.get("codec_type") == "audio"
    }
    audio_codecs.discard("")
    return any(codec in error_text for codec in audio_codecs)


def build_remux_command(
    ffmpeg: str,
    path: Path,
    staged_output: Path,
    transcode_audio: bool,
) -> list[str]:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        str(path),
        "-map",
        "0",
        "-c",
        "copy",
    ]
    if transcode_audio:
        command.extend(["-c:a", "aac", "-b:a", AAC_FALLBACK_BITRATE])
    if path.suffix.lower() in MP4_SUFFIXES:
        command.extend(["-movflags", "+faststart"])
    command.append(str(staged_output))
    return command


def run_remux_command(
    command: list[str], environment: dict[str, str]
) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        check=False,
        env=environment,
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def remux(
    path: Path,
    metadata: dict,
    ffmpeg: str,
    ffprobe: str,
    ram_dir: Path,
    fallback_temp_dir: Path | None,
) -> None:
    required = path.stat().st_size + RAM_RESERVE_BYTES
    ram_available = shutil.disk_usage(ram_dir).free
    work_dir = ram_dir
    if ram_available < required:
        if fallback_temp_dir is None:
            raise RemuxPreparationError(
                f"内存临时目录空间不足，需要约 {required / 1024**3:.2f} GiB，"
                f"当前可用 {ram_available / 1024**3:.2f} GiB；"
                "可使用 --fallback-temp-dir 指定磁盘临时目录"
            )
        fallback_temp_dir.mkdir(parents=True, exist_ok=True)
        fallback_available = shutil.disk_usage(fallback_temp_dir).free
        if fallback_available < required:
            raise RemuxPreparationError(
                f"内存和备用临时目录空间都不足；备用目录需要约 "
                f"{required / 1024**3:.2f} GiB，当前可用 "
                f"{fallback_available / 1024**3:.2f} GiB: {fallback_temp_dir}"
            )
        work_dir = fallback_temp_dir
        print(f"  内存不足，改用磁盘临时目录：{work_dir}", flush=True)

    staged_output = work_dir / f"segmentloop-remux-{uuid.uuid4().hex}{path.suffix.lower()}"
    environment = os.environ.copy()
    environment.update({"TMPDIR": str(work_dir), "TMP": str(work_dir), "TEMP": str(work_dir)})
    try:
        try:
            audio_transcoded = False
            result = run_remux_command(
                build_remux_command(ffmpeg, path, staged_output, False),
                environment,
            )
            if result.returncode != 0:
                detail = (result.stderr or "FFmpeg 没有输出错误详情").strip()
                if not should_retry_audio_as_aac(path, metadata, detail):
                    raise RemuxPreparationError(detail)
                staged_output.unlink(missing_ok=True)
                print(
                    "  源音频编码不受 MP4 容器支持；保持视频及其他流复制，"
                    f"仅将音频转为 AAC {AAC_FALLBACK_BITRATE}……",
                    flush=True,
                )
                audio_transcoded = True
                result = run_remux_command(
                    build_remux_command(ffmpeg, path, staged_output, True),
                    environment,
                )
                if result.returncode != 0:
                    retry_detail = (
                        result.stderr or "FFmpeg 音频 AAC 回退没有输出错误详情"
                    ).strip()
                    raise RemuxPreparationError(
                        "无损复制失败后，音频 AAC 回退也失败：\n" + retry_detail
                    )
            validate_remux(
                metadata,
                staged_output,
                ffprobe,
                allow_audio_transcode=audio_transcoded,
            )
        except RemuxPreparationError:
            raise
        except (subprocess.CalledProcessError, OSError, ValueError, RuntimeError) as error:
            raise RemuxPreparationError(str(error)) from error
        replace_from_staging(path, staged_output)
    finally:
        staged_output.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "检查并优先无损重封装常见视频容器；MP4 不支持源音频编码时仅将音频"
            "转为 AAC。优先使用内存，可配置磁盘备用目录。"
        )
    )
    parser.add_argument("directory", type=Path, help="要递归检查的目录")
    parser.add_argument("--dry-run", action="store_true", help="只检查，不修改文件")
    parser.add_argument("--ffmpeg", default="/usr/bin/ffmpeg")
    parser.add_argument("--ffprobe", default="/usr/bin/ffprobe")
    parser.add_argument("--ram-dir", type=Path, default=Path("/dev/shm"))
    parser.add_argument(
        "--fallback-temp-dir",
        type=Path,
        help="内存不足时使用的磁盘临时目录；不指定则内存不足的文件记为失败",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=Path("/var/lib/segmentloop-remux/scan-cache.sqlite3"),
        help="扫描记录数据库，默认位于系统盘 /var/lib/segmentloop-remux/scan-cache.sqlite3",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="重新检查和处理文件未变化的历史失败项",
    )
    parser.add_argument(
        "--recheck-all",
        "--global-recheck",
        dest="recheck_all",
        action="store_true",
        help="忽略扫描缓存，重新检查指定目录下的全部视频（仍严格逐个处理）",
    )
    parser.add_argument(
        "--list-failures",
        action="store_true",
        help="显示指定目录下记录的失败文件和原因，然后退出",
    )
    parser.add_argument(
        "--gap-mib",
        type=float,
        default=8.0,
        help="音视频包位置差超过多少 MiB 时判定为异常，默认 8",
    )
    parser.add_argument(
        "--fix-moov-only",
        action="store_true",
        help="同时修复仅有 moov 尾置、但未发现音视频包间距异常的文件",
    )
    args = parser.parse_args()

    directory = args.directory.resolve()
    ram_dir = args.ram_dir.resolve()
    state_file = args.state_file.resolve()
    fallback_temp_dir = args.fallback_temp_dir.resolve() if args.fallback_temp_dir else None
    if not directory.is_dir():
        parser.error(f"目录不存在: {directory}")

    if args.list_failures:
        try:
            cache = ScanCache(state_file)
            failures = cache.failures_under(directory)
        except (OSError, sqlite3.Error) as error:
            parser.error(f"无法打开扫描记录数据库 {state_file}: {error}")
        finally:
            if "cache" in locals():
                cache.close()
        if not failures:
            print(f"没有记录到失败文件：{directory}")
            return 0
        for index, (saved_path, detail, checked_at_ns) in enumerate(failures, 1):
            checked_at = datetime.fromtimestamp(
                checked_at_ns / 1_000_000_000
            ).astimezone().isoformat(timespec="seconds")
            indented_detail = detail.replace("\n", "\n    ") or "未记录错误详情"
            print(f"\n[{index}] {saved_path}\n  时间：{checked_at}\n  原因：{indented_detail}")
        print(f"\n失败文件共 {len(failures)} 个；记录库：{state_file}")
        return 0

    if not ram_dir.is_dir():
        parser.error(f"RAM 目录不存在: {ram_dir}")
    try:
        ram_fs_type = run(["stat", "-f", "-c", "%T", str(ram_dir)]).stdout.strip()
    except (subprocess.CalledProcessError, OSError, RuntimeError) as error:
        parser.error(f"无法确认 RAM 目录的文件系统类型: {error}")
    if ram_fs_type != "tmpfs":
        parser.error(f"RAM 目录必须位于 tmpfs，当前为 {ram_fs_type}: {ram_dir}")
    if not args.dry_run and os.geteuid() != 0:
        parser.error("替换原视频时必须使用 sudo；可先用 --dry-run 检查")

    lock_handle = None
    if not args.dry_run:
        try:
            import fcntl

            lock_handle = (ram_dir / "segmentloop-remux.lock").open("w")
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            lock_handle.write(f"pid={os.getpid()}\n")
            lock_handle.flush()
        except (ImportError, OSError, BlockingIOError) as error:
            parser.error(f"无法取得独占运行锁，可能已有另一个实例正在处理视频: {error}")

    try:
        cache = ScanCache(state_file)
    except (OSError, sqlite3.Error) as error:
        parser.error(f"无法打开扫描记录数据库 {state_file}: {error}")

    gap_bytes = int(args.gap_mib * 1024 * 1024)
    policy = (
        f"v{CACHE_POLICY_VERSION};gap={gap_bytes};"
        f"fix_moov_only={int(args.fix_moov_only)};"
        "fix_bif_timing=1"
    )
    discovered = 0
    checked = 0
    skipped = 0
    skipped_failed = 0
    problematic = 0
    replaced = 0
    failed = 0
    stopped_after_write_failure = False
    if args.recheck_all:
        print("全局重新检查已启用：本次忽略正常、已替换和失败缓存。", flush=True)
    try:
        for path in sorted(directory.rglob("*")):
            if path.is_symlink() or not path.is_file() or path.suffix.lower() not in VIDEO_SUFFIXES:
                continue
            discovered += 1
            try:
                before_stat = path.stat()
            except OSError as error:
                failed += 1
                print(f"\n[失败] {path}\n  无法读取文件属性：{error}", file=sys.stderr)
                continue

            cached_status = None if args.recheck_all else cache.matched_status(
                path, before_stat, policy
            )
            if cached_status in ("normal", "replaced"):
                skipped += 1
                continue
            if cached_status == "failed" and not args.retry_failed:
                skipped += 1
                skipped_failed += 1
                continue

            checked += 1
            print(f"\n[检查] {path}", flush=True)
            modification_started = False
            try:
                is_problematic, reasons, metadata = inspect_layout(
                    path,
                    args.ffprobe,
                    gap_bytes,
                    args.fix_moov_only,
                )
                if not is_problematic:
                    cache.record(path, before_stat, policy, "normal")
                    print(
                        "  正常：未发现音视频包间距、MP4 索引或 BIF 时间戳兼容异常"
                    )
                    continue
                problematic += 1
                print("  异常：" + "；".join(reasons))
                if args.dry_run:
                    continue
                print("  正在优先无损重封装（优先使用内存）……", flush=True)
                modification_started = True
                remux(
                    path,
                    metadata,
                    args.ffmpeg,
                    args.ffprobe,
                    ram_dir,
                    fallback_temp_dir,
                )
                replaced += 1
                cache.record(path, path.stat(), policy, "replaced")
                print("  已验证、完整写入硬盘并替换原视频", flush=True)
            except RemuxPreparationError as error:
                failed += 1
                cache.record(path, path.stat(), policy, "failed", str(error))
                print(f"  失败：{error}", file=sys.stderr)
                print(
                    "  失败发生在临时重封装阶段，原视频未修改，继续下一个文件。",
                    file=sys.stderr,
                )
            except (subprocess.CalledProcessError, OSError, ValueError, RuntimeError) as error:
                failed += 1
                if path.exists():
                    cache.record(path, path.stat(), policy, "failed", str(error))
                print(f"  失败：{error}", file=sys.stderr)
                if modification_started:
                    stopped_after_write_failure = True
                    print(
                        "  原视频替换阶段失败，批处理立即停止，不再处理后续文件。",
                        file=sys.stderr,
                    )
                    break
    finally:
        cache.close()

    print(
        f"\n完成：发现视频 {discovered}，实际检查 {checked}，缓存跳过 {skipped}"
        f"（其中历史失败 {skipped_failed}），发现异常 {problematic}，"
        f"替换 {replaced}，失败 {failed}，记录库 {state_file}"
    )
    return 2 if stopped_after_write_failure else (1 if failed else 0)


if __name__ == "__main__":
    raise SystemExit(main())
