#!/usr/bin/env python3
"""Build pristine and Segment Loop-injected Emby dashboard files from a DEB."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
from pathlib import Path


DEB_MEMBERS = {
    "dashboard-ui/index.html": "./opt/emby-server/system/dashboard-ui/index.html",
    "dashboard-ui/item/item.js": "./opt/emby-server/system/dashboard-ui/item/item.js",
}
HOOK = b"\n;if(window.EmbySegLoop)setTimeout(function(){window.EmbySegLoop.render()},500);\n"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def read_ar_member(path: Path, wanted: str) -> bytes:
    with path.open("rb") as stream:
        if stream.read(8) != b"!<arch>\n":
            raise ValueError(f"Not a Debian ar archive: {path}")
        while True:
            header = stream.read(60)
            if not header:
                break
            if len(header) != 60 or header[58:60] != b"`\n":
                raise ValueError("Invalid ar member header")
            name = header[:16].decode("ascii").strip().rstrip("/")
            size = int(header[48:58].decode("ascii").strip())
            data = stream.read(size)
            if size % 2:
                stream.read(1)
            if name == wanted:
                return data
    raise FileNotFoundError(f"{wanted} was not found in {path}")


def inject_index(original: bytes, client_script: bytes) -> bytes:
    text = original.decode("utf-8")
    if "</body>" not in text:
        raise ValueError("Original index.html has no </body> marker")
    injection = (
        "<!-- SegmentLoop:start -->\n"
        "<script>\n"
        'window.EmbySegmentLoopConfig={startKey:"[",endKey:"]",captureKey:"P"};\n'
        + client_script.decode("utf-8").rstrip()
        + "\n</script>\n"
        "<!-- SegmentLoop:end -->\n"
    )
    return text.replace("</body>", injection + "</body>", 1).encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("deb", type=Path, help="Path to emby-server-deb_4.9.5.0_amd64.deb")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("linux-dashboard/4.9.5.0"),
        help="Directory that receives original and injected trees",
    )
    args = parser.parse_args()

    deb_path = args.deb.resolve()
    output = args.output.resolve()
    client_text = Path(__file__).with_name("segmentloop.js").read_text(encoding="utf-8")
    client_script = client_text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    data_tar = read_ar_member(deb_path, "data.tar.xz")

    originals: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(data_tar), mode="r:xz") as archive:
        for relative, member_name in DEB_MEMBERS.items():
            member = archive.getmember(member_name)
            extracted = archive.extractfile(member)
            if extracted is None:
                raise FileNotFoundError(member_name)
            originals[relative] = extracted.read()

    injected = {
        "dashboard-ui/index.html": inject_index(
            originals["dashboard-ui/index.html"], client_script
        ),
        "dashboard-ui/item/item.js": (
            originals["dashboard-ui/item/item.js"].rstrip() + HOOK
        ),
    }

    manifest: dict[str, object] = {
        "sourceFile": deb_path.name,
        "sourceSha256": sha256(deb_path.read_bytes()),
        "files": {},
    }
    file_manifest = manifest["files"]
    assert isinstance(file_manifest, dict)

    for variant, files in (("original", originals), ("injected", injected)):
        for relative, data in files.items():
            destination = output / variant / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            file_manifest[f"{variant}/{relative}"] = {
                "size": len(data),
                "sha256": sha256(data),
            }

    manifest_path = output / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Generated {output}")


if __name__ == "__main__":
    main()
