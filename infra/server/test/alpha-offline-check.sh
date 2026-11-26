#!/usr/bin/env bash
# SH-LANDING-ALPHA's runtime check, offline and opt-in (not part of `pnpm verify`; docs/evidence/SH-LANDING-ALPHA.md):
#
#   infra/server/test/alpha-offline-check.sh <control ref> <preview commit> <older preview commit>
#
# On the integration line the control is 7d8c429ec, its head before SH-TA-01 brought the alpha site over.
# <control ref> is a commit whose Caddyfile has no alpha site (6ab62f64d, main before SH-LANDING-ALPHA); the candidate is
# this checkout's infra/server as it is on disk. Stock Caddy (caddy:2-alpine) runs both Caddyfiles, the rate_limit block
# removed from both alike (the module is not in stock Caddy); install-alpha.sh runs as root in Debian (GNU coreutils and
# tar, util-linux flock, curl); the real smoke-alpha.sh runs there too, through a curl wrapper to Caddy's plain HTTP port.
# It shows: other hosts answer the same with and without the alpha site (status, every header but Date, body sha256);
# alpha's answers; uploads cut short or empty and a second run under the lock refused with nothing changed; a switch
# under load with every request answered and no Caddy restart. Every container has --network none (loopback only) and
# nothing is pulled: the images must be here already (SH_OFFLINE_CADDY, SH_OFFLINE_DEBIAN, SH_OFFLINE_PYTHON override
# them). The alpha folder is a Docker volume, as the droplet's is one Linux file system for the installer and Caddy: a
# folder shared from a Mac (Docker Desktop's file sharing) answered a few of 89,562 requests 404 or 400 while its link
# was renamed, where the volume answered 238,448 of 238,448 with 200 (evidence, review round). The lab folder (printed)
# is kept for reading; remove it when done. The volume and the containers are removed at the end.
set -euo pipefail
# Resolve bare names and relative symlink targets without platform-specific realpath flags.
script=${BASH_SOURCE[0]}
while [[ -L $script ]]; do
  command -v readlink >/dev/null 2>&1 || { printf '%s: missing tool: readlink; Arch package: coreutils; macOS provider: macOS readlink\n' "${0##*/}" >&2; exit 1; }
  parent=${script%/*}
  [[ $parent != "$script" ]] || parent=.
  link=$(readlink "$script")
  if [[ $link == /* ]]; then script=$link; else script=$parent/$link; fi
done
here=${script%/*}
[[ $here != "$script" ]] || here=.
here=$(cd "$here" && pwd)
# shellcheck source=infra/server/app/tools.sh
source "$here/../app/tools.sh"
sh_require_tools bash git node docker python3 mkdir mktemp grep tail head wc tr chmod cat sleep seq tar diff

usage='usage: alpha-offline-check.sh <control ref> <preview commit> <older preview commit>'
WT=$(git rev-parse --show-toplevel)
cd "$WT"
CONTROL=$(git rev-parse --verify "${1:?$usage}^{commit}")
NEW=$(git rev-parse --verify "${2:?$usage}^{commit}")
OLD=$(git rev-parse --verify "${3:?$usage}^{commit}")
CADDY=${SH_OFFLINE_CADDY:-caddy:2-alpine}
DEB=${SH_OFFLINE_DEBIAN:-wordpress:php8.5-apache}
PY=${SH_OFFLINE_PYTHON:-python:3.11-alpine}
for image in "$CADDY" "$DEB" "$PY"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "alpha-offline-check: image $image is not here (nothing is pulled)" >&2; exit 2; }
done
LAB=$(mktemp -d "${TMPDIR:-/tmp}/sh-alpha-offline.XXXXXX")
VOL=sh-alpha-offline-$$
cleanup() {
  docker rm -f sh-alpha-control sh-alpha-candidate sh-alpha-load >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker volume create "$VOL" >/dev/null
mkdir -p "$LAB/curlwrap" "$LAB/expect-new" "$LAB/expect-old"
echo "lab $LAB; candidate: the working tree at $(git rev-parse HEAD); control $CONTROL; preview new $NEW, old $OLD"

echo "== 1. config: the candidate's files against the control's"
git show "$CONTROL:infra/server/Caddyfile" >"$LAB/Caddyfile.control"
python3 - "$WT/infra/server/Caddyfile" "$LAB/Caddyfile.control" <<'PY'
import sys
cand, control = (open(p).read() for p in sys.argv[1:3])
start = cand.index('# The preview of the next landing at alpha.squarehole.fun')
end = cand.index('# Any other host on :80')
print('Caddyfile without the alpha section is the control\'s byte for byte:', cand[:start] + cand[end:] == control,
      '(%d lines inserted before the catch-all)' % cand[start:end].count('\n'))
PY
git diff --stat "$CONTROL" -- infra/server
git diff "$CONTROL" -- infra/server/compose.yaml infra/server/install.sh | grep -E '^[-+][^-+]' || true

echo "== 2. both Caddyfiles validated by $CADDY (rate_limit removed alike)"
strip() { python3 -c 'import sys; s = open(sys.argv[1]).read(); a = s.index("\trate_limit {\n"); b = s.index("\n\t}\n", a) + 4; open(sys.argv[2], "w").write(s[:a] + s[b:])' "$1" "$2"; }
strip "$LAB/Caddyfile.control" "$LAB/control.Caddyfile"
strip "$WT/infra/server/Caddyfile" "$LAB/candidate.Caddyfile"
for f in control candidate; do
  # Caddy's log lines and its verdict share the output, in no fixed order: look for the verdict itself.
  out=$(docker run --rm --network none -v "$LAB/$f.Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) ||
    { printf '%s\n' "$out" | tail -5; echo "$f: REFUSED"; exit 1; }
  grep -qx 'Valid configuration' <<<"$out" && echo "$f: Valid configuration"
done

echo "== 3. install-alpha.sh as root in Debian (GNU tools): the old preview, refusals, then the new"
git -c tar.umask=0022 archive --format=tar "$OLD" apps/landing/public | node "$here/../app/archive.mjs" "$LAB/old.tar.gz"
git -c tar.umask=0022 archive --format=tar "$NEW" apps/landing/public | node "$here/../app/archive.mjs" "$LAB/new.tar.gz"
tar -xzf "$LAB/old.tar.gz" -C "$LAB/expect-old"
tar -xzf "$LAB/new.tar.gz" -C "$LAB/expect-new"
size=$(wc -c <"$LAB/new.tar.gz")
head -c $((size / 2)) "$LAB/new.tar.gz" >"$LAB/half.tar.gz"
head -c $((size - 1)) "$LAB/new.tar.gz" >"$LAB/cut.tar.gz"
: >"$LAB/empty.tar.gz"
# The installer as root in Debian, on the alpha folder (the volume) with the lab's files to read.
deb() { docker run --rm --network none -v "$WT/infra/server:/infra:ro" -v "$LAB:/lab:ro" -v "$VOL:/alpha" -e SH_ALPHA_BASE=/alpha --entrypoint bash "$DEB" "$@"; }
deb -c 'tar --version | head -1; flock --version'
deb /infra/install-alpha.sh /lab/old.tar.gz "$OLD"
# shellcheck disable=SC2016 # These expansions run inside the Debian container.
state() { deb -c 'cd /alpha && echo "  current -> $(readlink current); releases: $(ls -1 releases | tr "\n" " "); beside them: $(ls -A | tr "\n" " ")"'; }
for f in half cut empty; do
  echo "-- the new preview's upload, $f ($(wc -c <"$LAB/$f.tar.gz" | tr -d ' ') of $size bytes):"
  if deb /infra/install-alpha.sh "/lab/$f.tar.gz" "$NEW" 2>"$LAB/refused.txt"; then echo "UNEXPECTED: accepted"; exit 1; fi
  echo "  refused: $(grep -v -E '^(gzip|tar):' "$LAB/refused.txt" | tr '\n' ' ')"
  state
done
echo "-- the new preview while another run holds the lock:"
deb -c 'exec 8>/alpha/.lock && flock -n 8 || exit 99; if bash /infra/install-alpha.sh /lab/new.tar.gz '"$NEW"'; then echo "UNEXPECTED: ran"; exit 1; fi'
state
deb /infra/install-alpha.sh /lab/new.tar.gz "$NEW"
# shellcheck disable=SC2016 # These expansions run inside the Debian container.
deb -c 'cd /alpha && echo "current -> $(readlink current)" && ls -1 releases && id -un && stat -c "%a %U:%G %n" releases/*/index.html releases/*/art current | sort -u | head -6 && echo "plain files only: $(find releases ! -type f ! -type d | wc -l) others"'
# shellcheck disable=SC2016 # The file count runs in Debian; NEW is deliberately expanded here.
deb -c 'diff -r /alpha/current/ /lab/expect-new/apps/landing/public && echo "served tree == git archive of '"$NEW"' ($(find /alpha/current/ -type f | wc -l) files)"'

echo "== 4. control and candidate Caddy, offline"
docker run -d --name sh-alpha-control --network none -v "$LAB/control.Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$WT/apps/landing/public:/srv/landing:ro" -v "$WT/apps/web/public/share/square-hole-1200x630.jpg:/srv/card/generic.jpg:ro" \
  "$CADDY" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker run -d --name sh-alpha-candidate --network none -v "$LAB/candidate.Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$WT/apps/landing/public:/srv/landing:ro" -v "$VOL:/srv/landing-alpha:ro" -v "$WT/apps/web/public/share/square-hole-1200x630.jpg:/srv/card/generic.jpg:ro" \
  "$CADDY" caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
for name in sh-alpha-control sh-alpha-candidate; do
  for _ in $(seq 1 40); do docker logs "$name" 2>&1 | grep -q 'serving initial configuration' && break; sleep 0.25; done
done
cat >"$LAB/probe.py" <<'PY'
# Raw HTTP probe: one request per line of the requests file ("METHOD HOST PATH [Accept-Encoding]"), no redirects followed.
import hashlib, http.client, json, sys
out = []
for line in open(sys.argv[1]):
    parts = line.split()
    if not parts:
        continue
    method, host, path = parts[:3]
    headers = {'Host': host}
    if len(parts) > 3:
        headers['Accept-Encoding'] = parts[3]
    conn = http.client.HTTPConnection('127.0.0.1', 80, timeout=10)
    conn.request(method, path, headers=headers)
    res = conn.getresponse()
    body = res.read()
    hdrs = sorted((k, v) for k, v in res.getheaders() if k.lower() not in ('date',))
    out.append({'req': ' '.join(parts), 'status': res.status, 'headers': hdrs, 'sha256': hashlib.sha256(body).hexdigest(), 'len': len(body), 'body': body[:80].decode('latin-1')})
    conn.close()
json.dump(out, open(sys.argv[2], 'w'), indent=1)
PY
cat >"$LAB/requests" <<'REQ'
GET squarehole.fun /
GET squarehole.fun / gzip
HEAD squarehole.fun /
POST squarehole.fun /
GET squarehole.fun /index.html
GET squarehole.fun /styles.css
GET squarehole.fun /styles.css gzip
GET squarehole.fun /art/card-1200x630.jpg
GET squarehole.fun /brand/mark.svg
GET squarehole.fun /fonts/plus-jakarta-sans-latin-wght-normal.woff2
GET squarehole.fun /robots.txt
GET squarehole.fun /_headers
GET squarehole.fun /_routes.json
GET squarehole.fun /nft
GET squarehole.fun /nft/the-misfits/1.json
GET squarehole.fun /missing
GET squarehole.fun /art/missing.jpg
GET squarehole.fun //a%2Fb?x=1&y=2
GET www.squarehole.fun /
GET www.squarehole.fun //a%2Fb?x=1&y=2
GET www.squarehole.fun /nft/the-misfits/1.json
GET squarehole.xyz /
GET www.squarehole.xyz /robots.txt
GET squarehole.fit /?x=1
GET www.squarehole.fit /styles.css
GET api.squarehole.fun /healthz
GET api.squarehole.fun /v1/feed?chain=11155111
GET api.squarehole.fun /card/healthz
GET api.squarehole.fun /card/box/11155111/0x0000000000000000000000000000000000000000.png?v=1-open
GET api.squarehole.fun /
POST api.squarehole.fun /v1/feed
OPTIONS api.squarehole.fun /v1/feed
GET unknown.example /
GET 127.0.0.1 /
GET alpha.squarehole.fun /
GET alpha.squarehole.fun / gzip
HEAD alpha.squarehole.fun /
POST alpha.squarehole.fun /
GET alpha.squarehole.fun /index.html
GET alpha.squarehole.fun /styles.css
GET alpha.squarehole.fun /pager.js
GET alpha.squarehole.fun /pager.js zstd
GET alpha.squarehole.fun /art/card-1200x630.jpg
GET alpha.squarehole.fun /robots.txt
GET alpha.squarehole.fun /_headers
GET alpha.squarehole.fun /_routes.json
GET alpha.squarehole.fun /missing
GET alpha.squarehole.fun /art/missing.jpg
GET alpha.squarehole.fun /nft/the-misfits/1.json
GET alpha.squarehole.fun //a%2Fb?x=1&y=2
GET alpha.squarehole.fun /art/
REQ
for name in control candidate; do
  docker run --rm --network "container:sh-alpha-$name" -v "$LAB:/work" "$PY" python /work/probe.py /work/requests "/work/$name.json"
done
python3 - "$LAB" <<'PY'
import hashlib, json, os, sys
lab = sys.argv[1]
control = json.load(open(os.path.join(lab, 'control.json')))
candidate = json.load(open(os.path.join(lab, 'candidate.json')))
same = [c == k for c, k in zip(control, candidate) if ' alpha.squarehole.fun ' not in c['req']]
print('every other host and path: control == candidate (status, every header but Date, body sha256):', all(same), '%d of %d' % (sum(same), len(same)))
for c, k in zip(control, candidate):
    if ' alpha.squarehole.fun ' not in c['req'] and c != k:
        print('  DIFFERS', c['req'], c['status'], k['status'])
def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()
expect = os.path.join(lab, 'expect-new/apps/landing/public')
files = {'/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/pager.js': 'pager.js', '/art/card-1200x630.jpg': 'art/card-1200x630.jpg'}
for c, k in zip(control, candidate):
    if ' alpha.squarehole.fun ' not in c['req']:
        continue
    h = dict(k['headers'])
    path = k['req'].split()[2]
    note = ''
    if k['req'].split()[0] == 'GET' and len(k['req'].split()) == 3 and path in files:
        note = 'bytes == preview ' + files[path] + ': ' + str(k['sha256'] == sha(os.path.join(expect, files[path])))
    if k['status'] == 404 and k['len']:
        note = 'bytes == preview 404.html: ' + str(k['sha256'] == sha(os.path.join(expect, '404.html')))
    if path == '/robots.txt':
        note = 'body %r' % k['body']
    print('%-40s control %s | candidate %s %-24s robots=%s cache=%s csp-scripts=%s enc=%s loc=%s %s' % (
        k['req'], c['status'], k['status'], h.get('Content-Type', '-')[:24], h.get('X-Robots-Tag'), h.get('Cache-Control'),
        "script-src 'self'" in h.get('Content-Security-Policy', ''), h.get('Content-Encoding', '-'), h.get('Location', '-'), note))
PY

echo "== 5. the real smoke-alpha.sh against the candidate (curl wrapper: https://alpha... to its plain HTTP port)"
cat >"$LAB/curlwrap/curl" <<'SH'
#!/bin/bash
# smoke-alpha.sh's https://alpha.squarehole.fun requests, sent to the local Caddy's plain HTTP port (no TLS here).
args=()
for arg in "$@"; do
  case $arg in
    =https) args+=(=http) ;;
    https://alpha.squarehole.fun*) args+=("http://alpha.squarehole.fun${arg#https://alpha.squarehole.fun}") ;;
    *) args+=("$arg") ;;
  esac
done
exec /usr/bin/curl --resolve alpha.squarehole.fun:80:127.0.0.1 "${args[@]}"
SH
chmod 755 "$LAB/curlwrap/curl"
smoke() { docker run --rm --network container:sh-alpha-candidate -v "$WT/infra/server:/infra:ro" -v "$LAB:/lab" --entrypoint bash "$DEB" -c "PATH=/lab/curlwrap:\$PATH bash /infra/smoke-alpha.sh /lab/$1/apps/landing/public"; }
echo "-- expecting the new preview (served):"
smoke expect-new && echo "exit 0"
echo "-- expecting the old preview (a control that must fail):"
if smoke expect-old; then echo "UNEXPECTED: passed"; exit 1; else echo "exit $? (as it must)"; fi

echo "== 6. switch to the old preview under load, without restarting Caddy"
before=$(docker inspect -f '{{.State.StartedAt}} restarts={{.RestartCount}} pid={{.State.Pid}}' sh-alpha-candidate)
cat >"$LAB/load.py" <<'PY'
import hashlib, http.client, json, sys, time
seen, statuses = {}, {}
deadline = time.time() + 12
n = 0
while time.time() < deadline:
    conn = http.client.HTTPConnection('127.0.0.1', 80, timeout=5)
    conn.request('GET', '/', headers={'Host': 'alpha.squarehole.fun'})
    res = conn.getresponse()
    body = res.read()
    conn.close()
    statuses[res.status] = statuses.get(res.status, 0) + 1
    digest = hashlib.sha256(body).hexdigest()
    seen.setdefault(digest, [n, n])[1] = n
    n += 1
json.dump({'requests': n, 'statuses': statuses, 'bodies': seen}, open(sys.argv[1], 'w'))
PY
docker run -d --name sh-alpha-load --network container:sh-alpha-candidate -v "$LAB:/work" "$PY" python /work/load.py /work/load.json >/dev/null
sleep 3
deb /infra/install-alpha.sh /lab/old.tar.gz "$OLD"
docker wait sh-alpha-load >/dev/null
after=$(docker inspect -f '{{.State.StartedAt}} restarts={{.RestartCount}} pid={{.State.Pid}}' sh-alpha-candidate)
echo "candidate before: $before"
echo "candidate after:  $after"
python3 - "$LAB" <<'PY'
import hashlib, json, os, sys
lab = sys.argv[1]
load = json.load(open(os.path.join(lab, 'load.json')))
names = {hashlib.sha256(open(os.path.join(lab, 'expect-%s/apps/landing/public/index.html' % v), 'rb').read()).hexdigest(): v for v in ('old', 'new')}
print('requests during the switch:', load['requests'], 'statuses:', load['statuses'])
for digest, (first, last) in sorted(load['bodies'].items(), key=lambda item: item[1][0]):
    print('  body %s... = %s preview index.html, requests %d to %d' % (digest[:12], names.get(digest, 'NEITHER'), first, last))
PY
echo "-- expecting the old preview now:"
smoke expect-old && echo "exit 0"
echo "== 7. candidate log lines about alpha or errors other than certificate attempts (offline)"
docker logs sh-alpha-candidate 2>&1 | grep -v -i -E 'acme|certificate|obtain|tls|issuer|challenge|ocsp|storage|lookup|dial|no such host' | grep -i -E 'error|alpha' | head -5 || true
echo "done; lab kept at $LAB"
