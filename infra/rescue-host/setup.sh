#!/usr/bin/env bash
# Founder runs this once as root in a reviewed release archive on a fresh Ubuntu 24.04 server.
set -euo pipefail
umask 077

NODE_VERSION=24.22.1
# Node.js security release of 2026-10-21 (SH-NODE-24-22-1). The v24.22.1 SHASUMS256.txt was fetched from
# nodejs.org over HTTPS on 2026-10-22; its detached signature SHASUMS256.txt.sig verifies against the
# nodejs/release-keys key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 (Antoine du Hamel), checked with sqv 1.3.0.
NODE_SHA256_X64='6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6'
NODE_SHA256_ARM64='dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e'
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; NODE_SHA256=$NODE_SHA256_X64 ;;
  aarch64) NODE_ARCH=arm64; NODE_SHA256=$NODE_SHA256_ARM64 ;;
  *) echo 'Unsupported architecture; installation refused' >&2; exit 1 ;;
esac
if [[ ! "$NODE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Node archive SHA-256 pin missing; installation refused' >&2
  exit 1
fi
if [[ $EUID != 0 || $# != 1 || ! "$1" =~ ^core-v[a-zA-Z0-9_.-]+$ ]]; then
  echo 'usage (root): bash infra/rescue-host/setup.sh <release-tag>' >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]]
release_tag=$1
release_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
install_root=/opt/squarehole-rescue
[[ ! -e "$install_root" && ! -e /etc/squarehole-rescue ]]

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3
python3 - "$release_root/release.json" "$release_tag" <<'PY'
import json, re, sys
with open(sys.argv[1], encoding='utf8') as f:
    release = json.load(f)
assert release['tag'] == sys.argv[2]
assert re.fullmatch('[0-9a-f]{40}', release['commit'])
assert release['node'] == '24.22.1' and release['viem'] == '2.56.8'
PY

install -d -m 0755 "$install_root" "$install_root/download" "$install_root/node" "$install_root/releases/$release_tag"
archive="$install_root/download/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o "$archive"
printf '%s  %s\n' "$NODE_SHA256" "$archive" | sha256sum --check --status
tar -xJf "$archive" -C "$install_root/node" --strip-components=1
"$install_root/node/bin/node" --version | grep -qx "v$NODE_VERSION"

useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin squarehole-rescue
cp -a "$release_root/scripts" "$release_root/infra" "$release_root/node_modules" \
  "$release_root/release.json" "$release_root/pnpm-lock.yaml" "$install_root/releases/$release_tag/"
chown -R root:root "$install_root"
chmod -R a+rX "$install_root"
chmod -R a-w "$install_root/node" "$install_root/releases/$release_tag"
ln -s "releases/$release_tag" "$install_root/current"
install -d -o root -g squarehole-rescue -m 0750 /etc/squarehole-rescue
install -o root -g root -m 0600 /dev/null /etc/squarehole-rescue/rescue.env
cat > /etc/squarehole-rescue/rescue.env <<'ENV'
DRAND_RESCUE_RPC_URL=
DRAND_RESCUE_KEY_FILE=/etc/squarehole-rescue/signing-material
DRAND_RESCUE_TICKETS=
DRAND_RESCUE_MAILER_URL=
DRAND_RESCUE_MAILER_TOKEN=
DRAND_RESCUE_HEARTBEAT_HOUR=0
ENV
install -o squarehole-rescue -g squarehole-rescue -m 0600 /dev/null /etc/squarehole-rescue/signing-material
install -o root -g root -m 0644 "$release_root/infra/rescue-host/squarehole-rescue.service" /etc/systemd/system/
install -o root -g root -m 0644 "$release_root/infra/rescue-host/squarehole-rescue.timer" /etc/systemd/system/
systemctl daemon-reload
echo 'Installed, timer disabled. Configure private files and follow Turning it on before starting.'
