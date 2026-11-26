#!/bin/sh
# SH-275: prepares the alpha's volumes before alpha-api and alpha-sender start (the one-shot service alpha-folders of
# the hackathon stack, run as root in the alpha-api image with CHOWN, FOWNER and FSETID only, no network). The owners
# are the test site's (infra/server/install.sh), except the sender: here it runs as the image's user 1000, as the
# keeper does.
#   /v/queue     2101:2103 2750  alpha-api (uid 2101) writes the claims; alpha-sender (group 2103) reads them
#   /v/receipts  1000:2103 2750  alpha-sender writes receipts and progress; alpha-api (group 2103) reads them
#   /v/state     2101:2101 0700  alpha-api's database and monitor file
#   /v/config    0:0       0700  alpha-api's cookie key, made here once: 32 random bytes as 64 hex digits, root
#                                only, 0600
# Runs at every start; changes no file inside the folders but the cookie key's first making. Prints no secret.
set -eu
chown 2101:2103 /v/queue && chmod 2750 /v/queue
chown 1000:2103 /v/receipts && chmod 2750 /v/receipts
chown 2101:2101 /v/state && chmod 0700 /v/state
chown 0:0 /v/config && chmod 0700 /v/config
if [ ! -e /v/config/cookie.key ]; then
  rm -f /v/config/.cookie.key.new  # a stage left by an interrupted first start
  node -e "
    const { openSync, writeSync, fsyncSync, closeSync, renameSync } = require('node:fs');
    const { randomBytes } = require('node:crypto');
    const fd = openSync('/v/config/.cookie.key.new', 'wx', 0o600);
    writeSync(fd, randomBytes(32).toString('hex') + '\n'); fsyncSync(fd); closeSync(fd);
    renameSync('/v/config/.cookie.key.new', '/v/config/cookie.key');
  "
  echo 'alpha-folders: cookie key made (not printed)'
fi
echo 'alpha-folders: queue, receipts, state and config ready'
