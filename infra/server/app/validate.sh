#!/usr/bin/env bash
# Offline release preflight, run from the reviewed repository root; never installs or pulls anything.
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
source "$here/tools.sh"
sh_require_tools bash node curl shellcheck docker
artifact=${1:?usage: validate.sh <artifact directory> [--dry-run]}
mode=${2:-}
[[ $# -le 2 && ( -z $mode || $mode == --dry-run ) ]] || { echo 'app-validate: invalid arguments' >&2; exit 1; }
artifact=$(cd "$artifact" && pwd)
cd "$here/../../.."
if [[ $mode != --dry-run ]]; then sh_require_compose; fi
bash infra/server/smoke-app.sh "$artifact" --dry-run
scripts=(infra/server/ship.sh infra/server/install.sh infra/server/smoke-app.sh infra/server/app/install.sh infra/server/app/validate.sh infra/server/heal/check.sh infra/server/app/tools.sh infra/server/app/pack.sh)
for script in "${scripts[@]}"; do bash -n "$script"; done
if [[ $mode == --dry-run ]]; then
  printf 'app-validate: dry run; would run shellcheck, compose config and Caddy validation (network none)\n'
  exit 0
fi
shellcheck "${scripts[@]}"
# No server env file is read or printed; only the checked-in compose structure is resolved.
SH_RELEASE=offline-app-validation docker compose --project-directory infra/server --env-file /dev/null config --no-env-resolution --quiet
root=$(pwd)
id=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1])).id)' "$artifact/release.json")
docker run --rm --pull never --network none \
  -v "$root/infra/server/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$root/apps/landing/public:/srv/landing:ro" \
  -v "$artifact:/srv/app/current:ro" \
  -v "$artifact/public:/srv/app/releases/$id/public:ro" \
  -v "$artifact/public:/srv/app/immutable:ro" \
  squarehole-caddy:2.11.6-ratelimit caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
printf 'app-validate: shellcheck, compose and Caddy passed\n'
