#!/usr/bin/env bash
# Activate an already checked, extracted app artifact. Founder only; see docs/runbooks/app-hosting.md.
set -euo pipefail
umask 022
fail() { printf 'app-install: %s\n' "$*" >&2; exit 1; }
artifact=${1:?usage: install.sh <artifact directory> <reviewed commit> [--dry-run]}
commit=${2:?reviewed commit required}
mode=${3:-}
[[ $# -le 3 && ( -z $mode || $mode == --dry-run ) ]] || fail 'invalid arguments'
[[ $commit =~ ^[a-f0-9]{40}$ ]] || fail 'invalid reviewed commit'
artifact=$(cd "$artifact" && pwd)
[[ -s $artifact/SHA256SUMS && -s $artifact/release.json && -s $artifact/public/index.html && -s $artifact/app.site.caddy && -s $artifact/app.cors.caddy ]] || fail 'incomplete artifact'
[[ -z $(find "$artifact" ! -type f ! -type d -print -quit) ]] || fail 'non-regular files and symlinks refused'
# Never let checksum paths escape the artifact, or feed options/escaped names to sha256sum.
while IFS= read -r line; do
  [[ $line =~ ^[a-f0-9]{64}\ \ (public/[A-Za-z0-9_./-]+|release.json|app.site.caddy|app.cors.caddy)$ && $line != *'..'* ]] || fail 'invalid checksum path'
done < "$artifact/SHA256SUMS"
(cd "$artifact" && sha256sum --check --status SHA256SUMS) || fail 'artifact checksum mismatch'
listed=$(cut -c67- "$artifact/SHA256SUMS" | LC_ALL=C sort)
actual=$(cd "$artifact" && find . -type f ! -path ./SHA256SUMS | sed 's#^./##' | LC_ALL=C sort)
[[ $listed == "$actual" ]] || fail 'checksum inventory differs from artifact files'
jq -e --arg commit "$commit" '.commit == $commit and .chain == "11155111" and (.id | test("^[a-f0-9]{64}$")) and (.mainHost != .testHost)' "$artifact/release.json" >/dev/null || fail 'release identity refused (G08)'
id=$(jq -r '.id' "$artifact/release.json")
if [[ $mode == --dry-run ]]; then
  printf 'app-install: dry run; artifact verified; would validate Caddy, activate and reload\n'
  exit 0
fi
[[ $(id -u) -eq 0 ]] || fail 'run as root'
base=${SH_APP_BASE:-/srv/squarehole/app}
stack=${SH_STACK_DIR:-/srv/squarehole/current/infra/server}
# These are filesystem roots, never Docker or shell arguments provided by the artifact.
[[ $base == /* && $stack == /* ]] || fail 'absolute state and stack directories required'
grep -Fq 'import /srv/app/current/*.site.caddy' "$stack/Caddyfile" || fail 'install the app-capable stack first'
grep -Fq 'import /srv/app/current/*.cors.caddy' "$stack/Caddyfile" || fail 'stack lacks app CORS support'
install -d -m 0755 "$base/releases" "$base/immutable/assets"
exec 9>"$base/install.lock"
flock -n 9 || fail 'another app activation is running'
release=$base/releases/$id
if [[ -e $release ]]; then
  cmp -s "$artifact/SHA256SUMS" "$release/SHA256SUMS" || fail 'release identity collision'
  (cd "$release" && sha256sum --check --status SHA256SUMS) || fail 'stored release corrupted'
else
  cp -R "$artifact" "$release"
fi
# Retain every immutable hash for tabs opened before the switch. Never overwrite a different file at the same URL.
for asset in "$release"/public/assets/*; do
  name=${asset##*/}
  if [[ -f $asset && $name =~ ^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$ ]]; then
    kept=$base/immutable/assets/$name
    if [[ -e $kept ]]; then cmp -s "$asset" "$kept" || fail 'immutable asset collision'; else cp "$asset" "$kept"; fi
  fi
done
# Full active stack plus candidate imports, with no network. No running container or current symlink changes yet.
if ! docker run --rm --pull never --network none \
  -v "$stack/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$release:/srv/app/current:ro" \
  -v "$base/releases:/srv/app/releases:ro" \
  -v "$base/immutable:/srv/app/immutable:ro" \
  squarehole-caddy:2.11.6-ratelimit caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  >"$base/validation-$id.log" 2>&1; then fail 'candidate Caddy validation failed; current unchanged'; fi
compose=(docker compose --project-directory "$stack")
"${compose[@]}" exec -T caddy test -d "/srv/app/releases/$id" || fail 'Caddy lacks the stable app mount; apply compose first'
previous=$(readlink "$base/current" || true)
[[ ! -e $base/current || -L $base/current ]] || fail 'current must be a symlink'
ln -s "releases/$id" "$base/.current-$$"
mv -Tf "$base/.current-$$" "$base/current"
if ! "${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  if [[ -n $previous ]]; then
    ln -s "$previous" "$base/.rollback-$$"
    mv -Tf "$base/.rollback-$$" "$base/current"
  else
    mv "$base/current" "$base/failed-current-$id-$$"
  fi
  "${compose[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || fail 'reload and rollback reload failed; operator recovery required'
  fail 'reload failed; previous app selection restored'
fi
printf 'app-install: activated %s from %s; run external smoke next\n' "$id" "$commit"
