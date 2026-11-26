#!/usr/bin/env bash
# An scp process fixture (SH-LANDING-ALPHA): records its arguments and the uploaded archive's entries, and copies the
# file to its remote path under FAKE_SERVER_ROOT. No connection is made and no key is read. LANDING_FIXTURE_SCP_FAIL
# makes it fail as a lost connection would, after recording its arguments and before anything reaches the "server".
set -euo pipefail
printf '%s\n' "$@" >"$FAKE_SERVER_ROOT/scp-args"
[[ -z ${LANDING_FIXTURE_SCP_FAIL:-} ]] || { echo "scp fixture: connection lost" >&2; exit 1; }
target=${!#}
source=${*: -2:1}
tar -tzf "$source" >"$FAKE_SERVER_ROOT/scp-entries"
mkdir -p "$FAKE_SERVER_ROOT$(dirname "${target#*:}")"
cp "$source" "$FAKE_SERVER_ROOT${target#*:}"
