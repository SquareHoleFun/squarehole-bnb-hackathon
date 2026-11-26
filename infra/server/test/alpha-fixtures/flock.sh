#!/bin/sh
# A flock stand-in for a machine without util-linux (a Mac; the server has the real one), SH-LANDING-ALPHA: only
# `flock -n <fd>`, the form install-alpha.sh uses. perl takes flock(2) on the open file the caller holds on that
# descriptor, so the lock stays with the caller after perl exits and ends with it, as util-linux's does.
[ "$1" = -n ] && [ -n "$2" ] || { echo "flock stand-in: only -n <fd>" >&2; exit 64; }
exec perl -MFcntl=:flock -e 'open(my $fh, ">&=", $ARGV[0]) or exit 1; flock($fh, LOCK_EX | LOCK_NB) or exit 1' "$2"
