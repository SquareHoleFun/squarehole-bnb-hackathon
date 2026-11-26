#!/usr/bin/env bash
# Run on the deploying machine, outside the droplet, after DNS cutover and install. No SSH or origin bypass.
# Usage: bash infra/server/smoke-landing.sh [<expected public directory>]
# ship.sh supplies files extracted from the exact release; manual checks default to this checkout.
set -euo pipefail
# Kept self-contained: ship.sh extracts this checker from the requested commit, including older releases.
for tool in curl awk cmp mktemp date dirname; do
  case $tool in curl) arch=curl;; awk) arch=gawk;; cmp) arch=diffutils;; *) arch=coreutils;; esac
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'smoke-landing: missing tool: %s; Arch package: %s; macOS provider: macOS base utilities\n' "$tool" "$arch" >&2
    exit 1
  }
done

public=${1:-$(cd "$(dirname "$0")/../../apps/landing/public" && pwd)}
work=$(mktemp -d "${TMPDIR:-/tmp}/sh-landing-smoke.XXXXXX")
# Retain a failed response for diagnosis; this also avoids destroying earlier smoke evidence.
fail() { printf 'smoke-landing: %s (response files: %s)\n' "$*" "$work" >&2; exit 1; }
[[ -s $public/_headers ]] || fail "expected public directory is missing _headers"
nonce=$(date +%s)-$$

header_value() {
  awk -v name="$1" 'index($0, ":") {
    at = index($0, ":")
    if (tolower(substr($0, 1, at - 1)) == tolower(name)) {
      value = substr($0, at + 1); sub(/^[ \t]+/, "", value); sub(/\r$/, "", value)
    }
  } END { print value }' "$work/headers"
}
expect_header() {
  local actual
  actual=$(header_value "$1")
  [[ $actual == "$2" ]] || fail "$url: $1 was '$actual', expected '$2'"
}
request() {
  url=$1
  local status
  status=$(curl --silent --show-error --path-as-is --proto '=https' --max-time 20 --retry 2 \
    --header 'Cache-Control: no-cache' --dump-header "$work/headers" --output "$work/body" \
    --write-out '%{http_code}' "$url") || fail "$url: request failed"
  [[ $status == "$2" ]] || fail "$url: status $status, expected $2"
}
security_headers() {
  local name value
  while IFS=: read -r name value; do
    value=${value# }
    expect_header "$name" "$value"
  done < <(awk '/^\/\*/ { all = ($0 == "/*"); next } /^\// { all = 0 } all && /^  / { sub(/^  /, ""); print }' "$public/_headers")
}
check_file() {
  local path=$1 file=$2 cache=$3 status=${4:-200}
  request "https://squarehole.fun$path?sh-landing-check=$nonce" "$status"
  security_headers
  expect_header Cache-Control "$cache"
  cmp -s "$work/body" "$public/$file" || fail "$url: body differs from the release's $file"
}

check_file / index.html no-cache
check_file /index.html index.html no-cache
check_file /styles.css styles.css no-cache
for asset in art/card-1200x630.jpg brand/mark.svg fonts/plus-jakarta-sans-latin-wght-normal.woff2; do
  check_file "/$asset" "$asset" 'public, max-age=604800'
done
for path in /__landing-missing-"$nonce" /art/__landing-missing-"$nonce" /_headers /_routes.json; do
  check_file "$path" 404.html no-cache 404
done
request "https://squarehole.fun/nft/the-misfits/1.json?sh-landing-check=$nonce" 404
security_headers
expect_header Cache-Control 'public, max-age=86400'
[[ ! -s $work/body ]] || fail "$url: NFT rejection must have an empty body"
printf 'smoke-landing: squarehole.fun static files, headers, caches and 404s passed\n'

for host in www.squarehole.fun squarehole.xyz www.squarehole.xyz squarehole.fit www.squarehole.fit; do
  for path in "/?sh-landing-check=$nonce" "//landing%2Fcheck?sh-landing-check=$nonce&keep=1" "/nft/the-misfits/1.json?sh-landing-check=$nonce"; do
    request "https://$host$path" 301
    expect_header Location "https://squarehole.fun$path"
    expect_header Cache-Control 'public, max-age=86400'
  done
  printf 'smoke-landing: %s redirects passed\n' "$host"
done
