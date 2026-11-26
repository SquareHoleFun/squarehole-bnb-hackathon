#!/bin/sh
set -eu
umask 077

# This is a new, separate stack volume. Never reuse a running standalone node's repository.
if [ ! -s "$IPFS_PATH/config" ]; then
  ipfs init --profile=server
fi
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080
ipfs config --json Addresses.Swarm '[]'
ipfs config --json Bootstrap '[]'
ipfs config --json Gateway.NoFetch true
ipfs config --json Gateway.NoDNSLink true
# Imports are explicitly pinned; no automatic GC or unreviewed repo migrations.
exec ipfs daemon --offline --enable-gc=false --migrate=false
