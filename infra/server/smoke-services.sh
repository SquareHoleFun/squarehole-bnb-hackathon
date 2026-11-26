#!/usr/bin/env bash
# No inbound health endpoint. Run on the droplet in the reviewed release's infra/server directory.
set -euo pipefail
dry_run=false
if [[ ${1:-} == --dry-run ]]; then dry_run=true; shift; fi
service=${1:-all}
expected=${2:-}
[[ $# -le 2 ]] || { echo 'smoke-services: too many arguments' >&2; exit 2; }
case "$service" in keeper|keeper-set|burn-bot|reveal|cow-poster|alpha-sender|agents|alpha-api|all) ;; *) echo 'smoke-services: unknown service' >&2; exit 2;; esac
case "$expected" in ''|disabled|dry-run|live|ready) ;; *) echo 'smoke-services: invalid expected mode' >&2; exit 2;; esac
if [[ $service == alpha-api ]]; then
  [[ $expected != dry-run && $expected != live ]] || { echo 'smoke-services: alpha-api expects ready or disabled' >&2; exit 2; }
elif [[ $expected == ready ]]; then echo 'smoke-services: ready is only for alpha-api' >&2; exit 2; fi
services=("$service")
if [[ $service == all ]]; then services=(keeper keeper-set burn-bot reveal cow-poster alpha-sender agents alpha-api); fi
# The CoW order poster's image has no shared runner: its own check (packages/cow-poster/src/healthcheck.ts), run from
# the image's WORKDIR, accepts a current disabled record or, once enabled, a completed cycle in the flags' mode.
poster_check=(node --experimental-transform-types --no-warnings=ExperimentalWarning --import ../chain/scripts/register-ts.mjs src/healthcheck.ts)
for name in "${services[@]}"; do
  if $dry_run; then
    printf 'smoke-services: dry run; check %s completion and mode inside its container\n' "$name"
    continue
  fi
  if [[ $name == cow-poster ]]; then args=("${poster_check[@]}");
  elif [[ $name == alpha-api || $name == alpha-sender || $name == agents ]]; then args=(node "infra/server/services/$name.mjs" --healthcheck); else
    driver=$name
    if [[ $name == keeper-set ]]; then driver=keeper; fi
    args=(node infra/server/services/run.mjs "$driver" --healthcheck)
  fi
  mode=$expected
  if [[ $name == alpha-api && ( $mode == dry-run || $mode == live ) ]]; then mode=ready; fi
  if [[ -n $mode ]]; then args+=("$mode"); fi
  ok=false
  for _ in {1..36}; do
    if result=$(docker compose exec -T "$name" "${args[@]}"); then
      if [[ $name == keeper-set ]]; then result=${result/#keeper:/keeper-set:}; fi
      printf '%s\n' "$result"
      ok=true; break
    fi
    sleep 5
  done
  if ! $ok; then printf 'smoke-services: %s did not complete healthy work in the expected mode\n' "$name" >&2; exit 1; fi
done
