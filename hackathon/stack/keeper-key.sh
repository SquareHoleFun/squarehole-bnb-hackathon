#!/usr/bin/env bash
# Installs the keeper's key file from a Foundry (v3) keystore, on the machine (SH-259 review points 1 and 11).
#   SH_BNB_ETC=<etc> bash <srv>/current/hackathon/stack/keeper-key.sh <keystore file> <password file>
# The decryption runs in a throwaway container of the shipped keeper image, with no network, a read-only file system
# and no capabilities, as uid 1000 (the keeper's user): packages/keeper/scripts/install-key.ts reads the password from
# its FILE (never an environment variable or a command line), checks that the key belongs to SH_KEEPER_ADDRESS of
# keeper.env, writes a private temporary file beside <etc>/keeper/gas.key and renames it over the target. The rename is
# the commit point: a failure before it (a wrong password, a wrong key, a write error) leaves the previous key file (or
# none) untouched; after it the new, complete key is in place even if a later step (Docker's answer, the final check)
# reports a failure, and the last line says what is there. Nothing secret is printed.
set -euo pipefail
die() { printf 'keeper-key: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 2 ] || die "usage: keeper-key.sh <keystore file> <password file>"
keystore=$(readlink -f "$1") password=$(readlink -f "$2")
for file in "$keystore" "$password"; do
  if [ ! -f "$file" ]; then die "$file is not a regular file"; fi
done
etc=$(readlink -f "${SH_BNB_ETC:-/etc/squarehole-bnb}")
settings="$etc/stack.env"
[ -r "$settings" ] || die "no $settings"
srv=$(readlink -f "$(sed -n 's/^SH_BNB_SRV=//p' "$settings" | tail -n 1)")
release=$(readlink -f "$srv/current")
# Secrets never inside a build root (re-read point 11): by resolved path, neither the settings folder nor either input
# may lie inside the deployment root (every release is a build context) or inside a git checkout.
inside_build_root() {
  case "$1/" in "$srv"/*) return 0 ;; esac
  local d=$1; [ -d "$d" ] || d=$(dirname "$d")
  git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1
}
# The key folder itself: a real folder (never a symlink), resolved, and that resolved folder is the one mounted.
if [ -L "$etc/keeper" ] || [ ! -d "$etc/keeper" ]; then die "$etc/keeper must be a real folder, not a symlink"; fi
out=$(readlink -f "$etc/keeper")
[ "$out" = "$etc/keeper" ] || die "$etc/keeper resolves elsewhere ($out); refused"
for path in "$out" "$keystore" "$password"; do
  if inside_build_root "$path"; then die "$path lies inside a release or a checkout; keep secrets outside every build root"; fi
done
# One installer at a time per settings folder.
exec 8>"$etc/.keeper-key.lock"
flock -n 8 || die "another keeper-key.sh is running; nothing changed"
[ -f "$release/packages/keeper/scripts/install-key.ts" ] || die "no shipped release at $srv/current"
address=$(sed -n 's/^SH_KEEPER_ADDRESS=//p' "$etc/keeper.env" | tail -n 1)
[[ $address =~ ^0x[0-9a-fA-F]{40}$ ]] || die "SH_KEEPER_ADDRESS in $etc/keeper.env is not an address"
[ "$(stat -c %u "$out")" = 1000 ] || die "$out must be a folder of uid 1000"
image="squarehole-bnb-keeper:$(basename "$release")"
docker image inspect "$image" >/dev/null 2>&1 || die "no image $image: ship the release first"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount "type=bind,src=$keystore,dst=/in/keystore.json,readonly" \
  --mount "type=bind,src=$password,dst=/in/password,readonly" \
  --mount "type=bind,src=$out,dst=/out" \
  --mount "type=bind,src=$release/packages/keeper/scripts/install-key.ts,dst=/app/packages/keeper/scripts/install-key.ts,readonly" \
  --workdir /app/packages/keeper --entrypoint node "$image" \
  --experimental-transform-types --no-warnings=ExperimentalWarning --import ./scripts/register-ts.mjs \
  scripts/install-key.ts --keystore /in/keystore.json --password-file /in/password --address "$address" --out /out/gas.key
# The installer said "installed" only after its rename; this reads the result and says exactly what is there.
if [ "$(stat -c '%a %u %s' "$out/gas.key" 2>/dev/null)" = "400 1000 67" ]; then
  printf 'keeper-key: %s/keeper/gas.key is in place for %s (0400, uid 1000)\n' "$etc" "$address"
else
  die "the installer finished, but $out/gas.key is not 0400, uid 1000, 67 bytes: do not start the keeper live; look at it"
fi
