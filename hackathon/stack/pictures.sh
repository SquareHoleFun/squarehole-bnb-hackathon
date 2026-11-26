#!/usr/bin/env bash
# Puts one kit's pictures into the stack's pictures service and checks each through the site (SH-259; runbook step 5).
#   SH_BNB_ETC=<etc> bash <release>/hackathon/stack/pictures.sh <folder>
# The folder holds the kit's export: CAR files (`*.car`, imported with their roots pinned) and/or single picture or model
# files (`*.png`, `*.jpg`, `*.jpeg`, `*.webp`, `*.glb`, in the folder or one level below, each put in as one raw
# block). Afterwards every root it pinned
# is asked at https://<host>/ipfs/<cid>: the site serves only raw CIDs whose bytes are a picture or a GLB model, so a
# CAR's metadata root can answer 404 or 415 while its pictures answer 200. Nothing outside the folder is read.
set -euo pipefail
die() { printf 'pictures: %s\n' "$*" >&2; exit 1; }
if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then die "usage: pictures.sh <folder of .car or picture files>"; fi
folder=$1
etc=${SH_BNB_ETC:-/etc/squarehole-bnb}
settings="$etc/stack.env"
[ -r "$settings" ] || die "no $settings"
value() { sed -n "s/^$1=//p" "$settings" | tail -n 1; }
srv=$(value SH_BNB_SRV)
host=$(value SH_BNB_HOST)
port=$(value SH_BNB_HTTPS_PORT)
listen=$(value SH_BNB_LISTEN)
release=$(readlink -f "$srv/current")
[ -f "$release/hackathon/stack/compose.yaml" ] || die "no shipped release at $srv/current"
SH_RELEASE=$(basename "$release")
export SH_RELEASE
[ -s "$release/.derived.env" ] || die "the serving release has no .derived.env (ship it with ship.sh)"
compose=(docker compose --project-name "${SH_BNB_PROJECT:-squarehole-bnb}" --env-file "$settings" --env-file "$release/.derived.env"
  --file "$release/hackathon/stack/compose.yaml")
cids=()
shopt -s nullglob nocaseglob
for car in "$folder"/*.car; do
  # Regular files only, no link followed (STEP B point 16).
  if [ -L "$car" ] || [ ! -f "$car" ]; then die "$car is not a regular file (links are not followed)"; fi
  # The import's own exit status decides (re-read point 14): a failed import stops here and says so.
  out=$("${compose[@]}" exec -T kubo ipfs dag import --pin-roots=true --stats=false < "$car") || die "the import of $(basename "$car") failed"
  while read -r word cid _; do
    [ "$word" = Pinned ] && [ -n "${cid:-}" ] && cids+=("$cid")
  done < <(printf '%s\n' "$out" | sed 's/^Pinned root\t/Pinned /')
  printf 'pictures: imported %s\n' "$(basename "$car")"
done
for file in "$folder"/*.png "$folder"/*.jpg "$folder"/*.jpeg "$folder"/*.webp "$folder"/*.glb \
  "$folder"/*/*.png "$folder"/*/*.jpg "$folder"/*/*.jpeg "$folder"/*/*.webp "$folder"/*/*.glb; do
  if [ -L "$file" ] || [ ! -f "$file" ]; then die "$file is not a regular file (links are not followed)"; fi
  cids+=("$("${compose[@]}" exec -T kubo ipfs block put --cid-codec raw --mhtype sha2-256 --pin=true < "$file")")
  printf 'pictures: put %s %s\n' "${file#"$folder"/}" "${cids[-1]}"
done
[ "${#cids[@]}" -gt 0 ] || die "nothing to import in $folder"
origin="https://$host"; [ "${port:-443}" = 443 ] || origin="https://$host:$port"
check=()
[ "${listen:-0.0.0.0}" = 127.0.0.1 ] && check=(--insecure --resolve "$host:${port:-443}:127.0.0.1")
ok=0
for cid in "${cids[@]}"; do
  answer=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "${check[@]}" "$origin/ipfs/$cid" || echo "none")
  printf '%s %s\n' "$cid" "$answer"
  case "$answer" in 200*) ok=$((ok + 1)) ;; esac
done
printf 'pictures: %d of %d roots answer 200 at %s/ipfs/<cid>\n' "$ok" "${#cids[@]}" "$origin"
