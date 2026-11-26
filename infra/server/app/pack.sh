#!/usr/bin/env bash
# Packs the checked artifact and installer with canonical headers, independent of host tar and filesystem metadata.
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
sh_require_tools node
[[ $# -eq 2 ]] || { echo 'usage: pack.sh <work directory> <tarball>' >&2; exit 1; }
exec node "$here/pack.mjs" "$@"
