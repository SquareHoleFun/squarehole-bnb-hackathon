#!/usr/bin/env bash
# Regenerates the landing page's pictures in public/art/. Not needed to deploy: the outputs are committed.
#
# Sources (one render, two sizes; see docs/evidence/SH-landing.md):
#   - docs/design/misfits-v2/banner/final/misfits-banner-a-1600x400.png on main (the approved 1600 x 400 file)
#   - its 2800 x 700 master, banner-a-stage-2800.png at commit ea7e6353 (same render, read with git show)
#
# Tools: ImageMagick 7 (magick), cwebp (libwebp 1.6), avifenc (libavif 1.4), and for the link-preview card Node 24
# with the workspace installed (pnpm install; Playwright's Chromium from apps/web). Run from anywhere:
#   bash apps/landing/scripts/art.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
OUT="$HERE/../public/art"
FINAL="$REPO/docs/design/misfits-v2/banner/final/misfits-banner-a-1600x400.png"
FINAL_SHA=a8202b6917194146c6d2c9ddb53529dd9f064089d9019d9989dfb722dd921afe
MASTER_REF=ea7e6353:docs/design/misfits-v2/banner/banner-a-stage-2800.png
MASTER_SHA=c6b293abb47c0dcfc92661a91b5496c19e30b645dc1797e8a995da036c1548e2

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

check_sha() {
  local got
  # shasum on macOS; GNU coreutils' sha256sum where perl's shasum is not on PATH (Linux).
  if command -v shasum > /dev/null; then got="$(shasum -a 256 "$1" | cut -d' ' -f1)"; else got="$(sha256sum "$1" | cut -d' ' -f1)"; fi
  if [ "$got" != "$2" ]; then
    echo "unexpected sha256 for $1: $got" >&2
    exit 1
  fi
}

check_sha "$FINAL" "$FINAL_SHA"
git -C "$REPO" show "$MASTER_REF" > "$TMP/master.png"
check_sha "$TMP/master.png" "$MASTER_SHA"

webp() { cwebp -quiet -q 90 -m 6 -sharp_yuv -metadata none "$1" -o "$2"; }
avif() { avifenc -q 80 -s 4 -y 444 --ignore-exif --ignore-xmp "$1" "$2" > /dev/null; }
lanczos() { magick "$1" -filter Lanczos -resize "$2" -strip "PNG24:$3"; }

# Wide picture, 4:1: the approved file as it is, plus the master for screens with two device pixels per CSS pixel.
cp "$FINAL" "$OUT/stage-1600x400.png"
webp "$FINAL" "$OUT/stage-1600x400.webp"
avif "$FINAL" "$OUT/stage-1600x400.avif"
webp "$TMP/master.png" "$OUT/stage-2800x700.webp"
avif "$TMP/master.png" "$OUT/stage-2800x700.avif"

# The phone picture and the link preview are cut from the centre of the master between the shapes, so no shape is
# cut in half: the triangle on the left ends near x 762 and the heart starts near x 810; the star on the right ends near
# x 1990 and the arch starts near x 2044. Both crops run from x 784 to 2016 (1232 wide, centred on the box).

# Phones, 2:1: 1232 x 616 from y 34 (the box's bottom edge, near y 634, stays inside), at 1200 x 600 and 800 x 400.
magick "$TMP/master.png" -crop 1232x616+784+34 +repage -strip "PNG24:$TMP/crop.png"
lanczos "$TMP/crop.png" 1200x600 "$TMP/crop-1200.png"
lanczos "$TMP/crop.png" 800x400 "$TMP/crop-800.png"
webp "$TMP/crop-1200.png" "$OUT/stage-crop-1200x600.webp"
avif "$TMP/crop-1200.png" "$OUT/stage-crop-1200x600.avif"
cp "$TMP/crop-800.png" "$OUT/stage-crop-800x400.png"
webp "$TMP/crop-800.png" "$OUT/stage-crop-800x400.webp"
avif "$TMP/crop-800.png" "$OUT/stage-crop-800x400.avif"

# Link previews, 1200 x 630 (1.91:1): 1232 x 647 from y 26, brought down, with the horizontal lockup and the slogan
# over the darker sky at the top left (card.mjs, the workspace's Playwright Chromium), so a timeline that shows only the
# picture still names the site. JPEG, because some chat apps skip preview pictures over about 300 KB (a PNG would be
# about 500 KB).
magick "$TMP/master.png" -crop 1232x647+784+26 +repage -filter Lanczos -resize '1200x630!' -strip "PNG24:$TMP/card-bg.png"
node "$HERE/card.mjs" "$TMP/card-bg.png" "$TMP/card.png"
magick "$TMP/card.png" -strip -sampling-factor 4:4:4 -quality 90 -interlace JPEG "$OUT/card-1200x630.jpg"

ls -l "$OUT"
