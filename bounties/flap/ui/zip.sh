#!/usr/bin/env bash
# Builds the ZIP Flap's Workbench takes for one launcher UI source folder: exactly Component.tsx, manifest.json and
# i18n.json at the ZIP's root (examples/launcher-runtime/README.md, "Preview and publish", in Flap's template).
# Reproducible: the three files go in a fixed order, each with one fixed time and mode and plain deflate, so the same
# three files give the same bytes and the same sha256 on any machine.
# usage: bash bounties/flap/ui/zip.sh <source folder> <output .zip>
#   e.g. bash bounties/flap/ui/zip.sh bounties/flap/ui/rules-bnb ../rules-bnb.zip
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: zip.sh <source folder> <output .zip>" >&2; exit 2; }
src=$1
out=$2
case "$out" in *.zip) ;; *) echo "zip.sh: the output ends in .zip" >&2; exit 2 ;; esac
[ ! -e "$out" ] || { echo "zip.sh: $out exists; give a new name" >&2; exit 2; }
for f in Component.tsx manifest.json i18n.json; do [ -f "$src/$f" ] || { echo "zip.sh: $src/$f is missing" >&2; exit 1; }; done
[ "$(find "$src" -mindepth 1 | wc -l)" -eq 3 ] || { echo "zip.sh: $src must hold exactly the three files" >&2; exit 1; }
python3 -I - "$src" "$out" <<'EOF'
import sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in ("Component.tsx", "manifest.json", "i18n.json"):
        info = zipfile.ZipInfo(name, date_time=(2026, 11, 26, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        with open(src + "/" + name, "rb") as f:
            z.writestr(info, f.read(), compresslevel=9)
EOF
sha256sum "$out"
