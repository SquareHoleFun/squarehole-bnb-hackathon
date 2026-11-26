#!/usr/bin/env bash
# An ssh process fixture (SH-LANDING-ALPHA): records its arguments and standard input, then runs the remote command
# here as the server would, with the server's /tmp under FAKE_SERVER_ROOT and the tests' sudo, which only runs its
# command. No connection is made and no key is read.
set -euo pipefail
printf '%s\n' "$@" >"$FAKE_SERVER_ROOT/ssh-args"
command=${!#}
tee "$FAKE_SERVER_ROOT/ssh-stdin" | bash -c "${command//\/tmp\//$FAKE_SERVER_ROOT/tmp/}"
