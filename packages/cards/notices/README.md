# Card image decoder notices

This image is built on the project's own server from the lockfile. It is not distributed: no registry push, no download and no copy for another operator.

The image carries our records in `/app/notices/`. It also carries these intact
files copied from the packages installed by the frozen lockfile:

| Folder in `/app/notices/` | Package | Files |
| --- | --- | --- |
| `sharp/` | sharp 0.35.5 | `LICENSE`, `README.md` |
| `sharp-linux-x64/` | @img/sharp-linux-x64 0.35.5 | `LICENSE`, `README.md` |
| `sharp-libvips-linux-x64/` | @img/sharp-libvips-linux-x64 1.3.4 | `README.md`, `versions.json` |

Sharp and its addon use Apache-2.0. The libvips bundle declares LGPL-3.0-or-later.
Its README names the terms for each bundled library. The versions list identifies
libvips 8.18.7 and libwebp 1.6.0. Our `sharp-Apache-2.0.txt`,
`sharp-libvips-linux-x64-1.3.4.md` and `sharp-libvips-versions.json` are also intact
copies of the installed files. `libwebp-BSD-3-Clause.txt` records a gap; it is not
a licence text.

**Before this image or these binaries are ever given to anyone outside (a registry,
a download, another operator), the full texts and a source offer for the LGPL parts
must be complete; that is a release blocker.** Include matching source, build and
relinking material and preserve the recipient's ability to replace the LGPL parts.
The start check verifies that the shipped files are present and match the installed
packages. It does not approve external distribution or clear these gaps.

## Known gaps

The bundle ships no full component copyright/licence texts, including the GPLv3
and LGPLv3 texts. It ships no matching source, build or relinking material.
Every row below is a missing full-text notice. These upstream locations identify
where to obtain the source; they are not a source offer. No text was invented or
copied from a different installed system version.

| Component | Terms listed by the bundle | Upstream source |
| --- | --- | --- |
| aom | BSD-2-Clause and AOM Patent License 1.0 | https://aomedia.googlesource.com/aom/ |
| cairo | MPL-1.1 | https://gitlab.freedesktop.org/cairo/cairo |
| cgif | MIT | https://github.com/dloebl/cgif |
| expat | MIT | https://github.com/libexpat/libexpat |
| fontconfig | fontconfig licence (BSD-like) | https://gitlab.freedesktop.org/fontconfig/fontconfig |
| freetype | FreeType licence (BSD-like) | https://gitlab.freedesktop.org/freetype/freetype |
| fribidi | LGPLv3 | https://github.com/fribidi/fribidi |
| glib | LGPLv3 | https://gitlab.gnome.org/GNOME/glib |
| harfbuzz | MIT | https://github.com/harfbuzz/harfbuzz |
| highway | BSD-3-Clause | https://github.com/google/highway |
| lcms | MIT | https://github.com/mm2/Little-CMS |
| libarchive | BSD-2-Clause | https://github.com/libarchive/libarchive |
| libexif | LGPLv3 | https://github.com/libexif/libexif |
| libffi | MIT | https://github.com/libffi/libffi |
| libheif | LGPLv3 | https://github.com/strukturag/libheif |
| libimagequant | BSD-2-Clause | https://github.com/lovell/libimagequant |
| libnsgif | MIT | https://git.netsurf-browser.org/libnsgif.git/ |
| libpng | libpng licence | https://github.com/pnggroup/libpng |
| librsvg | LGPLv3 | https://gitlab.gnome.org/GNOME/librsvg |
| libtiff | libtiff licence (BSD-like) | https://gitlab.com/libtiff/libtiff |
| libultrahdr | MIT | https://github.com/google/libultrahdr |
| libvips | LGPLv3 | https://github.com/libvips/libvips/tree/v8.18.7 |
| libwebp | New BSD License (BSD-3-Clause) | https://github.com/webmproject/libwebp/tree/v1.6.0 |
| libxml2 | MIT | https://gitlab.gnome.org/GNOME/libxml2 |
| mozjpeg | zlib, IJG and BSD-3-Clause | https://github.com/mozilla/mozjpeg |
| pango | LGPLv3 | https://gitlab.gnome.org/GNOME/pango |
| pixman | MIT | https://gitlab.freedesktop.org/pixman/pixman |
| proxy-libintl | LGPLv3 | https://github.com/frida/proxy-libintl |
| zlib-ng | zlib | https://github.com/zlib-ng/zlib-ng |

The bundle says LGPLv3 use follows the “any later version” clause of LGPLv2 or
LGPLv2.1. Its README lists libnsgif, but its versions.json has no libnsgif version.
That version is another known gap. Bundle source and build recipes:
https://github.com/lovell/sharp-libvips/tree/v1.3.4.
Sharp source: https://github.com/lovell/sharp/tree/v0.35.5.
