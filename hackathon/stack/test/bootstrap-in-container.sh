#!/usr/bin/env bash
# bootstrap.sh in a throwaway Ubuntu 24.04 container (SH-259 Part 4), twice: the second run must keep every file.
# No port is published; the container has no firewall to set (SH_BNB_NO_FIREWALL=1). Needs Docker and the network
# (the container installs the packages bootstrap.sh asks for).  bash hackathon/stack/test/bootstrap-in-container.sh
set -euo pipefail
root=$(git rev-parse --show-toplevel)
docker run --rm --volume "$root/hackathon/stack:/stack:ro" ubuntu:24.04 bash -c '
  set -euo pipefail
  export SH_BNB_NO_FIREWALL=1 SH_BNB_HOST=192-0-2-10.sslip.io
  bash /stack/bootstrap.sh
  before=$(sha256sum /etc/squarehole-bnb/*.env)
  SH_BNB_HOST=other.example bash /stack/bootstrap.sh
  [ "$before" = "$(sha256sum /etc/squarehole-bnb/*.env)" ] || { echo "FAIL: a second run changed the settings"; exit 1; }
  check() { [ "$(stat -c "%a %U:%G" "$1")" = "$2" ] || { echo "FAIL: $1 is $(stat -c "%a %U:%G" "$1"), want $2"; exit 1; }; }
  check /etc/squarehole-bnb "700 root:root"
  [ "$(stat -c "%a %u:%g" /etc/squarehole-bnb/keeper)" = "700 1000:1000" ] || { echo "FAIL: the keeper folder is not uid 1000 (the container user)"; exit 1; }
  for f in stack indexer keeper db; do check /etc/squarehole-bnb/$f.env "600 root:root"; done
  check /srv/squarehole-bnb "755 squarehole-bnb:squarehole-bnb"
  grep -qx "SH_BNB_HOST=192-0-2-10.sslip.io" /etc/squarehole-bnb/stack.env || { echo "FAIL: host"; exit 1; }
  grep -qx "SH_CORE_ART_GATEWAYS=https://192-0-2-10.sslip.io" /etc/squarehole-bnb/indexer.env || { echo "FAIL: art origin"; exit 1; }
  grep -q "^POSTGRES_PASSWORD=[0-9a-f]\{64\}$" /etc/squarehole-bnb/db.env || { echo "FAIL: password"; exit 1; }
  [ "$(cat /srv/squarehole-bnb/withheld/pictures.json)" = "[]" ] || { echo "FAIL: withheld list"; exit 1; }
  command -v docker >/dev/null && docker compose version >/dev/null && docker buildx version >/dev/null || { echo "FAIL: docker tools"; exit 1; }
  ! grep -q "^[^#]*<" /etc/squarehole-bnb/stack.env /etc/squarehole-bnb/indexer.env || { echo "FAIL: a placeholder is left"; exit 1; }
  [ "$(grep -c "^[^#]*<" /etc/squarehole-bnb/keeper.env)" = 1 ] || { echo "FAIL: keeper.env should keep its one placeholder (the signer)"; exit 1; }
  echo "bootstrap in a container: PASS"
'
