#!/usr/bin/env bash
# Prepares an Ubuntu 24.04 machine for the BNB Chain testnet stack (SH-259 Part 4; hackathon/runbooks/machine.md).
# Run once as root, from the unpacked release: `bash hackathon/stack/bootstrap.sh`. Safe to run again: it adds what is
# missing and never overwrites a settings file, a key or a folder's contents.
#
# What it does, and nothing else:
#   1. packages: Docker with Compose and buildx (only if no Docker is installed: an existing Docker is kept), ufw, jq,
#      curl, openssl, git, ca-certificates.
#   2. a system user `squarehole-bnb` (no shell, no home) that owns the stack's folders.
#   3. folders: SH_BNB_SRV (default /srv/squarehole-bnb: releases, withheld) and SH_BNB_ETC (default
#      /etc/squarehole-bnb, root only: the settings, the keeper's key folder).
#   4. the firewall: 22, 80 and 443 in, nothing else. An active ufw keeps its rules and gets 22, 80 and 443 added.
#   5. settings from the templates beside this script, with the host name filled in; the database password made here.
# It touches no other user's files, no other folder and no running container.
#
# Settings (environment):
#   SH_BNB_HOST        the host name (default: the machine's public IPv4 address with dashes, under sslip.io)
#   SH_BNB_SRV, SH_BNB_ETC   the two folders (defaults above)
#   SH_BNB_NO_FIREWALL=1     leave the firewall alone (a throwaway test container has none)
#   SH_BNB_USER_MODE=1       on a machine that already has Docker and its firewall (the build machine): run as an
#                            ordinary user of the docker group, skip steps 1, 2 and 4, and make the folders and
#                            settings that user's (SH_BNB_SRV and SH_BNB_ETC must then be folders that user may write)
set -euo pipefail
umask 022

log() { printf 'bootstrap: %s\n' "$*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

user_mode=${SH_BNB_USER_MODE:-0}
if [ "$user_mode" = 1 ]; then
  [ "$(id -u)" != 0 ] || die "SH_BNB_USER_MODE=1 is for an ordinary user; as root, leave it unset"
  docker info >/dev/null 2>&1 || die "this user cannot use Docker"
  if [ -z "${SH_BNB_SRV:-}" ] || [ -z "${SH_BNB_ETC:-}" ]; then die "SH_BNB_USER_MODE=1 needs SH_BNB_SRV and SH_BNB_ETC"; fi
else
  [ "$(id -u)" = 0 ] || die "run as root (or SH_BNB_USER_MODE=1 on a machine with Docker and its firewall)"
fi
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for template in stack.env.example indexer.env.example keeper.env.example; do
  [ -s "$here/$template" ] || die "the template $template is missing beside this script"
done
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != 24.04 ]; then log "not Ubuntu 24.04 (${PRETTY_NAME:-unknown}); going on"; fi
fi
srv=${SH_BNB_SRV:-/srv/squarehole-bnb}
etc=${SH_BNB_ETC:-/etc/squarehole-bnb}
case "$srv$etc" in *[!A-Za-z0-9/_.-]*) die "SH_BNB_SRV and SH_BNB_ETC are plain absolute paths" ;; esac
case "$srv" in /*) ;; *) die "SH_BNB_SRV must be absolute" ;; esac
case "$etc" in /*) ;; *) die "SH_BNB_ETC must be absolute" ;; esac
# The settings folder holds secrets: by resolved path never inside the deployment root (every release there is a build
# context) nor inside a git checkout (re-read point 11).
etc_r=$(readlink -m "$etc") srv_r=$(readlink -m "$srv")
case "$etc_r/" in "$srv_r"/*) die "SH_BNB_ETC lies inside SH_BNB_SRV; keep the settings outside every build root" ;; esac
# A strict boundary (STEP B point 19): both parents exist already (nothing is made outside the two folders), and
# neither folder nor anything this script writes is a link.
for dir in "$srv" "$etc"; do
  [ -d "$(dirname "$dir")" ] || die "$(dirname "$dir") does not exist: make it first (bootstrap makes only $dir itself)"
  [ ! -L "$dir" ] || die "$dir is a link; give the real folder"
done
for path in "$srv/releases" "$srv/withheld" "$srv/withheld/pictures.json" "$etc/keeper" "$etc/stack.env" "$etc/indexer.env" "$etc/keeper.env" "$etc/db.env"; do
  [ ! -L "$path" ] || die "$path is a link; bootstrap writes no link's target"
done
probe=$etc_r
while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
# Without git (a fresh machine installs it below): any parent holding a .git entry is a checkout.
while :; do
  [ ! -e "$probe/.git" ] || die "SH_BNB_ETC lies inside a git checkout ($probe); keep the settings outside it"
  [ "$probe" != / ] || break
  probe=$(dirname "$probe")
done

# 1. packages
missing=()
if [ "$user_mode" = 1 ]; then log "user mode: packages, service user and firewall left as they are"; fi
for pair in ufw:ufw jq:jq curl:curl openssl:openssl git:git update-ca-certificates:ca-certificates; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || missing+=("${pair#*:}")
done
if ! command -v docker >/dev/null 2>&1; then
  missing+=(docker.io docker-compose-v2 docker-buildx)
elif ! docker compose version >/dev/null 2>&1; then
  die "Docker is installed without Compose v2; install its compose plugin, then run this again"
fi
if [ "$user_mode" != 1 ] && [ "${#missing[@]}" -gt 0 ]; then
  log "installing ${missing[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
fi
if [ "$user_mode" != 1 ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable --now docker >/dev/null 2>&1 || log "could not enable the docker service; check: systemctl status docker"
fi

# 2. the service user
if [ "$user_mode" != 1 ] && ! id squarehole-bnb >/dev/null 2>&1; then
  log "adding the system user squarehole-bnb"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin squarehole-bnb
fi

# 3. folders. The keeper container runs as uid 1000 (the image's `node` user) and must read its key folder.
if [ "$user_mode" = 1 ]; then
  # The keeper container reads its key folder as uid 1000: in user mode that must be this user.
  [ "$(id -u)" = 1000 ] || die "user mode: the keeper's key folder must belong to uid 1000 (the container's user); this user is $(id -u)"
  install -d -m 0755 "$srv" "$srv/releases" "$srv/withheld"
  install -d -m 0700 "$etc" "$etc/keeper"
else
  install -d -m 0755 -o squarehole-bnb -g squarehole-bnb "$srv" "$srv/releases"
  install -d -m 0755 -o root -g root "$srv/withheld"
  install -d -m 0700 -o root -g root "$etc"
  install -d -m 0700 -o 1000 -g 1000 "$etc/keeper"
fi
[ -e "$srv/withheld/pictures.json" ] || printf '[]\n' > "$srv/withheld/pictures.json"

# 4. the firewall
if [ "${SH_BNB_NO_FIREWALL:-0}" = 1 ] || [ "$user_mode" = 1 ]; then
  log "firewall left alone (SH_BNB_NO_FIREWALL=1 or user mode)"
elif ufw status 2>/dev/null | grep -q '^Status: active'; then
  log "ufw is active: keeping its rules, allowing 22, 80 and 443"
  ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
else
  log "ufw: deny incoming, allow outgoing, allow 22, 80 and 443"
  ufw default deny incoming >/dev/null && ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

# 5. settings
host=${SH_BNB_HOST:-}
if [ -z "$host" ] && [ -s "$etc/stack.env" ]; then host=$(sed -n 's/^SH_BNB_HOST=//p' "$etc/stack.env"); fi
if [ -z "$host" ]; then
  # The address this machine sends from (on a cloud machine with a public address, that address); no outside service.
  address=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
  [[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "no IPv4 address found; set SH_BNB_HOST"
  host="${address//./-}.sslip.io"
fi
[[ $host =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "SH_BNB_HOST is not a host name"

write_once() { # write_once <file> <mode>: stdin becomes the file unless it exists (never overwritten)
  if [ -e "$1" ]; then log "kept $1"; cat > /dev/null; return; fi
  ( umask 077; cat > "$1.new" ) && chmod "$2" "$1.new" && mv "$1.new" "$1" && log "wrote $1"
}
sed -e "s|^SH_BNB_HOST=.*|SH_BNB_HOST=$host|" -e "s|^SH_BNB_ETC=.*|SH_BNB_ETC=$etc|" -e "s|^SH_BNB_SRV=.*|SH_BNB_SRV=$srv|" \
  "$here/stack.env.example" | write_once "$etc/stack.env" 0600
sed -e "s|https://<SH_BNB_HOST>|https://$host|" "$here/indexer.env.example" | write_once "$etc/indexer.env" 0600
write_once "$etc/keeper.env" 0600 < "$here/keeper.env.example"
if [ ! -e "$etc/db.env" ]; then
  password=$(openssl rand -hex 32)
  printf 'POSTGRES_PASSWORD=%s\nPGPASSWORD=%s\n' "$password" "$password" | write_once "$etc/db.env" 0600
  unset password
fi

configured=$(sed -n 's/^SH_BNB_HOST=//p' "$etc/stack.env")
log "done. Host name: $configured (settings in $etc, releases in $srv/releases)"
[ "$configured" = "$host" ] || log "note: $etc/stack.env keeps its host name $configured; edit it there to change it"
log "next: hackathon/runbooks/machine.md step 3 (ship a release)"
