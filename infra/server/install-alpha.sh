#!/usr/bin/env bash
# Puts one commit's static landing in place as the preview at alpha.squarehole.fun, on the droplet, as root
# (ship-alpha.sh sends this file over SSH and runs it with sudo; docs/runbooks/server.md):
#
#   sudo bash install-alpha.sh <payload tarball> <commit>
#
# The tarball is `git archive <commit> apps/landing/public`. It is unpacked once per commit into
# /srv/squarehole/landing-alpha/releases/<commit>. An upload tar cannot read to its end (cut short or empty), a landing
# without index.html, 404.html, _headers or styles.css (or with one of them empty), or one holding anything but plain
# files and folders (a link could lead Caddy to a file outside the preview), is refused and changes nothing; so is a
# second run while one is at work (a lock, .lock beside `current`). Then `current`, a relative link, is switched to it
# by one rename: Caddy serves alpha from /srv/landing-alpha/current through the read-only mount of the folder
# (compose.yaml), so the running container sees the new preview at once, and each request gets the old preview or the
# new one. The current preview and the two before it stay (going back: ship-alpha.sh <older commit>, which reuses the
# folder); older ones are removed. Nothing else is touched: no image, container, unit, release or other folder.
# The indexer and squarehole-indexer-heal units belong to install.sh's stack release, not this static-only archive.
set -euo pipefail
umask 022

tarball=${1:?usage: install-alpha.sh <payload tarball> <commit>}
commit=${2:?usage: install-alpha.sh <payload tarball> <commit>}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "install-alpha.sh: the commit must be 40 hex characters" >&2; exit 2; }
# The folder compose.yaml mounts at /srv/landing-alpha (install.sh makes it); the tests point this at a scratch folder.
base=${SH_ALPHA_BASE:-/srv/squarehole/landing-alpha}
release=$base/releases/$commit
log() { printf 'install-alpha.sh: %s\n' "$*"; }
refuse() { log "$*; alpha unchanged" >&2; exit 1; }

[[ -d $base ]] || refuse "no $base: ship a release with SH-LANDING-ALPHA first (its install.sh makes the folder)"
# One run at a time, the lock taken before the trap below: two runs share the .new names, and a refused run's exit must
# not remove the other's. The kernel drops the lock when this process ends, however it ends. Caddy serves `current`
# only, so .lock is never public.
exec 9>"$base/.lock"
flock -n 9 || refuse "another install-alpha.sh is running"
trap 'rm -rf "$release.new" "$base/.current.new"' EXIT
install -d -m 0755 "$base/releases"

if [[ -d $release ]]; then
  log "$commit was unpacked before; reused"
else
  rm -rf "$release.new"
  mkdir "$release.new"
  # tar's status, not the files found, decides: from an upload one byte short GNU tar unpacks every file intact and
  # only then fails, and from one cut anywhere it leaves every file before the cut.
  tar -xzf "$tarball" -C "$release.new" --strip-components=3 --no-same-owner --no-same-permissions apps/landing/public ||
    refuse "the upload is not a complete landing archive"
  for file in index.html 404.html _headers styles.css; do
    [[ -f $release.new/$file && -s $release.new/$file ]] || refuse "landing file missing or empty: $file"
  done
  odd=$(find "$release.new" ! -type f ! -type d -print -quit)
  [[ -z $odd ]] || refuse "not a plain file or folder: ${odd#"$release.new"/}"
  mv "$release.new" "$release"
  log "unpacked $commit ($(du -sh "$release" | cut -f1))"
fi

# The newest folder is the one served: the three newest stay.
touch "$release"
ln -sfn "releases/$commit" "$base/.current.new"
mv -T "$base/.current.new" "$base/current"
log "current -> $commit"

kept=0
while IFS= read -r name; do
  [[ $name =~ ^[0-9a-f]{40}$ ]] || continue
  kept=$((kept + 1))
  if ((kept > 3)); then
    rm -rf "${base:?}/releases/$name"
    log "removed the older preview $name"
  fi
done < <(ls -1t "$base/releases")
