#!/usr/bin/env bash
# Lets only Cloudflare reach the web ports the stack publishes (80 and 443), as root (install.sh and
# squarehole-origin-firewall.service run it; docs/runbooks/server.md):
#
#   squarehole-origin-firewall [--check] <Caddyfile>
#
# Docker publishes ports past ufw (its DNAT sends them through FORWARD, not INPUT), so the allowlist sits in DOCKER-USER,
# the chain Docker checks first and leaves alone. The list is the Caddyfile's `trusted_proxies static` line (Cloudflare's
# published ranges), one list for both. Its IPv4 ranges fill the chain SH-ORIGIN in one iptables-restore transaction
# (all or nothing; a refused list changes nothing). DOCKER-USER sends every packet of a connection made to 80 or 443 (its
# original destination port, client to server) through SH-ORIGIN: traffic from Docker's own bridges and from Cloudflare
# returns to Docker's rules, anything else is dropped, so a direct visitor or a scanner gets no answer and no
# certificate. The stack publishes IPv4 only (compose.yaml). Idempotent. --check reads and checks the list only, needs no
# root and applies nothing: install.sh runs a release's own copy so before its switch and applies the list at the switch.
set -euo pipefail

check=false
if [[ ${1:-} == --check ]]; then check=true; shift; fi
caddyfile=${1:?usage: squarehole-origin-firewall [--check] <Caddyfile>}
$check || [[ $(id -u) -eq 0 ]] || { echo "origin-firewall: run as root" >&2; exit 2; }
fail() { echo "origin-firewall: $*; nothing changed" >&2; exit 2; }

line=$(grep -E '^[[:space:]]*trusted_proxies[[:space:]]+static[[:space:]]' "$caddyfile" || true)
[[ -n $line && $(grep -c . <<<"$line") -eq 1 ]] || fail "expected one 'trusted_proxies static' line in $caddyfile"
v4=()
for word in $line; do
  case $word in trusted_proxies | static) continue ;; esac
  if [[ $word =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]]; then
    for octet in "${BASH_REMATCH[@]:1:4}"; do
      ((10#$octet <= 255)) || fail "not an IPv4 range: $word"
    done
    # No wide ranges: a /0 or /1 would let everyone through.
    ((10#${BASH_REMATCH[5]} >= 8 && 10#${BASH_REMATCH[5]} <= 32)) || fail "IPv4 range too wide or malformed: $word"
    v4+=("$word")
  elif [[ $word =~ ^[0-9a-fA-F:]+/[0-9]{1,3}$ ]]; then
    : # IPv6: nothing is published on IPv6.
  else
    fail "not a range in trusted_proxies: $word"
  fi
done
((${#v4[@]} >= 10)) || fail "found ${#v4[@]} IPv4 ranges in $caddyfile, expected Cloudflare's (15 on 2026-10-04)"
if $check; then
  echo "origin-firewall: the list in $caddyfile holds ${#v4[@]} Cloudflare IPv4 ranges (checked, not applied)"
  exit 0
fi

{
  echo '*filter'
  echo ':SH-ORIGIN - [0:0]'
  echo '-F SH-ORIGIN'
  echo '-A SH-ORIGIN -i docker0 -j RETURN'
  echo '-A SH-ORIGIN -i br-+ -j RETURN'
  for range in "${v4[@]}"; do echo "-A SH-ORIGIN -s $range -j RETURN"; done
  echo '-A SH-ORIGIN -j DROP'
  echo 'COMMIT'
} | iptables-restore -w --noflush

# At boot this runs before Docker, which then keeps the chain and jumps to it first from FORWARD.
iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || iptables -w -N DOCKER-USER
for port in 443 80; do
  jump=(-p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport "$port" -j SH-ORIGIN)
  iptables -w -C DOCKER-USER "${jump[@]}" 2>/dev/null || iptables -w -I DOCKER-USER 1 "${jump[@]}"
done
echo "origin-firewall: ports 80 and 443 answer Cloudflare's ${#v4[@]} IPv4 ranges only (from $caddyfile)"
