#!/bin/sh
# Usage: add.sh [--dry-run] ipfs:<raw-cid>|ar:<transaction-id> illegal|legal-notice
set -eu
exec node "$(dirname "$0")/edit.mjs" add "$@"
