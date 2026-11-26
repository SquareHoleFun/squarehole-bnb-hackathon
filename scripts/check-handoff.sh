#!/bin/sh
# pnpm check:handoff: both handoff folders against their committed MANIFEST.sha256 (the folders are never edited).
# shasum where it exists (macOS; Linux with perl's core tools on PATH), else GNU coreutils' sha256sum: both check the
# same "<sha256>  <path>" lines with -c and stay silent on success with --quiet.
set -eu
cd "$(dirname "$0")/.."
if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$@"; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$@"; }
else
  echo 'check:handoff: neither shasum nor sha256sum is on PATH' >&2
  exit 1
fi
for dir in square-hole-handoff square-hole-core-v2; do
  (cd "$dir" && sha256 -c MANIFEST.sha256 --quiet)
done
