#!/usr/bin/env bash
# The lock covers probes, notification sends and state replacement, including manual invocations.
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} == --dry-run || ${1:-} == --drand ]]; then
  exec node "$script_dir/main.mjs" "$@"
fi
# StateDirectory in the service creates this root-owned directory. Exit 75 means a run already owns the lock.
exec flock --nonblock --conflict-exit-code 75 /var/lib/squarehole-monitor/run.lock node "$script_dir/main.mjs" "$@"
