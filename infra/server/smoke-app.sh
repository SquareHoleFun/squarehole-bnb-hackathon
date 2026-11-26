#!/usr/bin/env bash
# Outside HTTPS smoke against the exact checked artifact; --dry-run never makes a request.
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
source "$here/app/tools.sh"
sh_require_tools node curl
exec node "$here/app/smoke.mjs" "$@"
