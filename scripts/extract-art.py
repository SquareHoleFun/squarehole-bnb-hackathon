#!/usr/bin/env python3
"""Deterministically crop platform-cast and demo artwork from the approved reference PNGs.

Reads packages/design/art/manifest.json, verifies the handoff sources, crops each asset at its native pixel
size (never resized, never upscaled), encodes WebP without metadata and records sha256/size back into the
manifest. `--check` re-derives every crop in memory and fails if a committed file or manifest field differs.

Usage (from the repository root):
    python3 scripts/extract-art.py            # write crops + update derived manifest fields
    python3 scripts/extract-art.py --check    # verify only; exit 1 on any mismatch

Policy (ADR-0004): crops are presentation assets for mock data only. Brand look-alikes listed under
`excluded` in the manifest must never intersect an asset crop; the script enforces that.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
from pathlib import Path

from PIL import Image, features

REPO = Path(__file__).resolve().parent.parent
MANIFEST = REPO / 'packages' / 'design' / 'art' / 'manifest.json'


class ManifestError(Exception):
    """Raised when the manifest is inconsistent or violates the art policy."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_box(box: object, width: int, height: int, label: str) -> tuple[int, int, int, int]:
    """Half-open [x0, x1) x [y0, y1) integer box inside the source image."""
    if not isinstance(box, list) or len(box) != 4 or not all(isinstance(v, int) for v in box):
        raise ManifestError(f'{label}: box must be four integers, got {box!r}')
    x0, y0, x1, y1 = box
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise ManifestError(f'{label}: box {box} outside {width}x{height} source or empty')
    return x0, y0, x1, y1


def boxes_intersect(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def encode_webp(image: Image.Image, encoding: dict) -> bytes:
    buffer = io.BytesIO()
    image.save(
        buffer,
        format='WEBP',
        quality=int(encoding['quality']),
        method=int(encoding['method']),
        lossless=bool(encoding['lossless']),
        exact=False,
        exif=b'',
        icc_profile=None,
    )
    return buffer.getvalue()


def load_sources(manifest: dict) -> dict[str, Image.Image]:
    source_dir = REPO / manifest['sourceDir']
    images: dict[str, Image.Image] = {}
    for name in manifest['sources']:
        path = source_dir / name
        if not path.is_file():
            raise ManifestError(f'missing source {path}')
        data = path.read_bytes()
        with Image.open(io.BytesIO(data)) as opened:
            image = opened.convert('RGB')
        manifest['sources'][name] = {'sha256': sha256_bytes(data), 'width': image.width, 'height': image.height}
        images[name] = image
    return images


def build(manifest: dict) -> tuple[dict, dict[str, bytes]]:
    """Return an updated manifest (new object) and the encoded bytes per output file."""
    updated = json.loads(json.dumps(manifest))
    images = load_sources(updated)
    output_dir = (REPO / updated['outputDir']).resolve()

    excluded = []
    for entry in updated.get('excluded', []):
        src = entry['source']
        if src not in images:
            raise ManifestError(f'excluded region references unknown source {src}')
        box = validate_box(entry['box'], images[src].width, images[src].height, f"excluded {entry['what']}")
        excluded.append((src, box, entry['what']))

    seen_ids: set[str] = set()
    seen_outputs: set[str] = set()
    outputs: dict[str, bytes] = {}
    for asset in updated['assets']:
        asset_id = asset['id']
        if asset_id in seen_ids:
            raise ManifestError(f'duplicate asset id {asset_id}')
        seen_ids.add(asset_id)
        src = asset['source']
        if src not in images:
            raise ManifestError(f'{asset_id}: unknown source {src}')
        image = images[src]
        box = validate_box(asset['box'], image.width, image.height, asset_id)
        for ex_src, ex_box, what in excluded:
            if ex_src == src and boxes_intersect(box, ex_box):
                raise ManifestError(f'{asset_id}: crop {list(box)} intersects excluded region "{what}"')
        output_path = (output_dir / asset['output']).resolve()
        if output_path.parent != output_dir or output_path.suffix != '.webp':
            raise ManifestError(f'{asset_id}: output must be a .webp file directly inside {output_dir}')
        if asset['output'] in seen_outputs:
            raise ManifestError(f'{asset_id}: duplicate output {asset["output"]}')
        seen_outputs.add(asset['output'])

        crop = image.crop(box)  # native pixels only: no resize, no upscale
        encoded = encode_webp(crop, updated['encoding'])
        with Image.open(io.BytesIO(encoded)) as check:
            if check.size != crop.size:
                raise ManifestError(f'{asset_id}: encoded size {check.size} differs from crop {crop.size}')
        asset['width'], asset['height'] = crop.size
        asset['bytes'] = len(encoded)
        asset['sha256'] = sha256_bytes(encoded)
        outputs[asset['output']] = encoded

    for pending in updated.get('pending', []):
        if pending['id'] in seen_ids:
            raise ManifestError(f"pending id {pending['id']} collides with an extracted asset")

    updated['toolchain'] = {'pillow': Image.__version__, 'libwebp': features.version('webp')}
    return updated, outputs


def serialize(manifest: dict) -> str:
    """Stable JSON with integer arrays (crop boxes) kept on one line for reviewable diffs."""
    text = json.dumps(manifest, indent=2, ensure_ascii=False)
    text = re.sub(r'\[\s*(-?\d+(?:\s*,\s*-?\d+)*)\s*\]', _inline_ints, text)
    return text + '\n'


def _inline_ints(match: re.Match[str]) -> str:
    return '[' + ', '.join(value.strip() for value in match.group(1).split(',')) + ']'


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--check', action='store_true', help='verify committed crops and manifest; write nothing')
    args = parser.parse_args(argv)

    try:
        manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
        updated, outputs = build(manifest)
    except (ManifestError, KeyError, ValueError, OSError) as error:
        print(f'extract-art: {error}', file=sys.stderr)
        return 2

    output_dir = REPO / updated['outputDir']
    if args.check:
        problems = []
        for name, data in outputs.items():
            path = output_dir / name
            if not path.is_file() or path.read_bytes() != data:
                problems.append(f'{name} differs from a fresh crop')
        if serialize(updated) != MANIFEST.read_text(encoding='utf-8'):
            problems.append('manifest derived fields are stale (run without --check)')
        for problem in problems:
            print(f'extract-art --check: {problem}', file=sys.stderr)
        if not problems:
            print(f'extract-art --check: {len(outputs)} crops match manifest')
        return 1 if problems else 0

    output_dir.mkdir(parents=True, exist_ok=True)
    for name, data in outputs.items():
        (output_dir / name).write_bytes(data)
    MANIFEST.write_text(serialize(updated), encoding='utf-8')
    total = sum(len(d) for d in outputs.values())
    print(f'extract-art: wrote {len(outputs)} crops ({total} bytes) and updated {MANIFEST.relative_to(REPO)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
