#!/usr/bin/env bash
# Checks the preview at https://alpha.squarehole.fun from outside the droplet, through public DNS and Cloudflare (no SSH
# or origin bypass). ship-alpha.sh runs it after the switch with the files it shipped; by hand, with a commit's files:
#
#   d=$(mktemp -d) && git archive <commit> apps/landing/public | tar -x -C "$d" && bash infra/server/smoke-alpha.sh "$d/apps/landing/public"
#
# Every answer must carry the preview's own security headers (the /* block of its _headers), X-Robots-Tag: noindex,
# nofollow and Cache-Control: no-cache, and no redirect; the page and a few files must be the expected bytes; robots.txt
# must disallow all robots; a missing page, /_headers and /_routes.json must get the 404 page with status 404.
set -euo pipefail
for tool in curl awk cmp mktemp date rm; do
  case $tool in curl) arch=curl;; awk) arch=gawk;; cmp) arch=diffutils;; *) arch=coreutils;; esac
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'smoke-alpha: missing tool: %s; Arch package: %s; macOS provider: macOS base utilities\n' "$tool" "$arch" >&2
    exit 1
  }
done

public=${1:?usage: smoke-alpha.sh <expected public directory>}
work=$(mktemp -d "${TMPDIR:-/tmp}/sh-alpha-smoke.XXXXXX")
# Cloudflare Access guards alpha. SH_ACCESS_HEADERS names a file of two header lines (a service token's
# CF-Access-Client-Id and CF-Access-Client-Secret); curl reads it directly, so the token is never an argument. A
# response could reflect the token, so with it in use no response value is printed and the response files are removed.
access=()
diagnose=true
# curl's own error messages can quote response bytes, so they are shown only without the token.
show_error=(--show-error)
if [[ -n ${SH_ACCESS_HEADERS:-} ]]; then
  access=(--header "@$SH_ACCESS_HEADERS")
  diagnose=false
  show_error=()
  trap 'rm -rf "$work"' EXIT
fi
# Without the token, retain a failed response for diagnosis.
fail() {
  if $diagnose; then printf 'smoke-alpha: %s (response files: %s)\n' "$*" "$work" >&2
  else printf 'smoke-alpha: %s (response files removed: Access token in use)\n' "$*" >&2; fi
  exit 1
}
for file in _headers index.html 404.html; do
  [[ -s $public/$file ]] || fail "the expected public directory $public has no $file"
done
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
  if [[ $actual != "$2" ]]; then
    if $diagnose; then fail "$url: $1 was '$actual', expected '$2'"; else fail "$url: $1 differs from '$2'"; fi
  fi
}
request() {
  url=https://alpha.squarehole.fun$1
  local status
  # -q first: no ~/.curlrc, so no ambient redirect following (custom headers cross hosts on a redirect) or tracing.
  status=$(curl -q --silent ${show_error[@]+"${show_error[@]}"} --path-as-is --proto '=https' --max-time 20 --retry 2 \
    --header 'Cache-Control: no-cache' ${access[@]+"${access[@]}"} --dump-header "$work/headers" --output "$work/body" \
    --write-out '%{http_code}' "$url") || fail "$url: request failed"
  [[ $(header_value Location) != *.cloudflareaccess.com/* ]] || fail "$url: Cloudflare Access answered; set SH_ACCESS_HEADERS to the service token header file"
  [[ $status == "$2" ]] || fail "$url: status $status, expected $2"
  expect_header Location ''
}
preview_headers() {
  local name value
  while IFS=: read -r name value; do
    expect_header "$name" "${value# }"
  done < <(awk '/^\/\*/ { all = ($0 == "/*"); next } /^\// { all = 0 } all && /^  / { sub(/^  /, ""); print }' "$public/_headers")
  expect_header X-Robots-Tag 'noindex, nofollow'
  expect_header Cache-Control 'no-cache'
}
check() {
  request "$1?sh-alpha-check=$nonce" "$2"
  preview_headers
  cmp -s "$work/body" "$3" || fail "$url: body differs from $3"
}

check / 200 "$public/index.html"
check /index.html 200 "$public/index.html"
checked=2
for file in styles.css pager.js brand/mark.svg art/card-1200x630.jpg; do
  if [[ -f $public/$file ]]; then
    check "/$file" 200 "$public/$file"
    checked=$((checked + 1))
  fi
done
request "/robots.txt?sh-alpha-check=$nonce" 200
preview_headers
expect_header Content-Type 'text/plain; charset=utf-8'
printf 'User-agent: *\nDisallow: /\n' >"$work/robots.txt"
cmp -s "$work/body" "$work/robots.txt" || fail "$url: robots.txt does not disallow all robots"
for path in /__alpha-missing-"$nonce" /art/__alpha-missing-"$nonce" /_headers /_routes.json; do
  check "$path" 404 "$public/404.html"
done
printf 'smoke-alpha: https://alpha.squarehole.fun passed: %s files byte for byte, the preview'"'"'s headers with noindex and no-cache, robots.txt disallowing all, 4 missing paths answered 404, no redirect\n' "$checked"
