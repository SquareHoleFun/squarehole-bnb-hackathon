#!/usr/bin/env bash
# Compares the platform's own routes on two running stacks (SH-259: the launch page must not change a byte of them):
# status, content type, cache control and security policy (with each stack's own host name replaced by <host>), and
# whether the body is that stack's single-page app (the same bytes as its `/`).
#   bash hackathon/stack/test/compare-routes.sh <origin A> <origin B>     e.g. https://<host> https://127-0-0-1.sslip.io:18584
# An origin on 127-0-0-1.sslip.io is reached on 127.0.0.1 without checking its certificate (the trial's own).
set -euo pipefail
paths=(/ /launch /create/basics /box/97/0x5539280794dd81763afE9dCAf326EF6c52327863 /healthz /v2/feed /_headers /ipfs/ /settings)
fetch() { # fetch <origin> <path> -> "status|type|cache|policy|spa"
  local origin=$1 path=$2 host opts=() headers body root
  host=${origin#https://}; host=${host%%:*}
  case "$origin" in *127-0-0-1.sslip.io*) opts=(--insecure --resolve "${origin#https://}:127.0.0.1") ;; esac
  headers=$(curl -sS --max-time 15 "${opts[@]}" -D - -o /dev/null "$origin$path" | tr -d '\r' || true)
  body=$(curl -sS --max-time 15 "${opts[@]}" "$origin$path" | sha256sum | cut -c1-16 || true)
  root=$(curl -sS --max-time 15 "${opts[@]}" "$origin/" | sha256sum | cut -c1-16 || true)
  printf '%s|%s|%s|%s|%s\n' "$(sed -n '1s/^HTTP[^ ]* \([0-9]*\).*/\1/p' <<<"$headers")" \
    "$(grep -i '^content-type:' <<<"$headers" | cut -d' ' -f2- || true)" \
    "$(grep -i '^cache-control:' <<<"$headers" | cut -d' ' -f2- || true)" \
    "$(grep -i '^content-security-policy:' <<<"$headers" | cut -d' ' -f2- | sed "s#$host#<host>#g" || true)" \
    "$(if [ "$body" = "$root" ]; then echo spa; else echo own; fi)"
}
same=0 differ=0
for path in "${paths[@]}"; do
  a=$(fetch "$1" "$path"); b=$(fetch "$2" "$path")
  # A transport failure is never "the same": both sides must answer.
  if [ -z "${a%%|*}" ] || [ -z "${b%%|*}" ]; then differ=$((differ + 1)); printf 'NO ANSWER %s\n  A %s\n  B %s\n' "$path" "$a" "$b"; continue; fi
  if [ "$a" = "$b" ]; then same=$((same + 1)); printf 'same    %s  %s\n' "$path" "${a:0:60}"
  else differ=$((differ + 1)); printf 'DIFFERS %s\n  A %s\n  B %s\n' "$path" "$a" "$b"; fi
done
printf 'routes: %d the same, %d differ\n' "$same" "$differ"
[ "$differ" = 0 ]
