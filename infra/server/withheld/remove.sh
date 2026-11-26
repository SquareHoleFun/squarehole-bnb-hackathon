#!/bin/sh
# Usage: remove.sh [--dry-run] ipfs:<raw-cid>|ar:<transaction-id>
set -eu
exec node "$(dirname "$0")/edit.mjs" remove "$@"
