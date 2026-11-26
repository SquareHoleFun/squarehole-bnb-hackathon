#!/usr/bin/env bash
# Rewrites chain 97's stored index history with the serving indexer's own code (SH-259; runbook "The morning ship",
# M7b). The indexer never rewrites a stored row, so rows written by an earlier indexer keep that indexer's form (on 25
# November: two Rent Free activity rows whose label an event argument had replaced). In order, and each step only when
# the one before it is confirmed:
#   1. the index follows the chain now; its head is recorded, and the boxes the feed lists;
#   2. the indexer is stopped and Docker lists it as not running (otherwise nothing is deleted);
#   3. chain 97's rows of the twelve history tables are deleted in ONE transaction (all or nothing);
#   4. the indexer is started; the script waits until it follows at or past the recorded head, its history is healthy
#      with nothing pending, and the history's own cursor is at or past that head;
#   5. every row named with --row reads as expected, and the first activity page of every listed box passes the page's
#      acceptance rules (parseActivityPageV2 in apps/web/src/features/core/v2/life-activity.ts, transcribed below);
#   6. it prints `history-rewrite: complete`.
# Any failure says which state the index is in and what to do.
#   SH_BNB_ETC=<etc> bash <srv>/current/hackathon/stack/history-rewrite.sh \
#     [--row <token> <block>-<logIndex> '<JSON the row's data must contain>']...
set -euo pipefail
say() { printf 'history-rewrite: %s\n' "$*"; }
fail() { printf 'history-rewrite: %s\n' "$*" >&2; exit 1; }

rows=()
while [ "$#" -gt 0 ]; do
  if [ "$1" != --row ] || [ "$#" -lt 4 ]; then fail "usage: history-rewrite.sh [--row <token> <block>-<logIndex> '<JSON>']..."; fi
  [[ $2 =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "--row: $2 is not a token address"
  [[ $3 =~ ^[0-9]{1,20}-[0-9]{1,10}$ ]] || fail "--row: $3 is not <block>-<logIndex>"
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$4" || fail "--row: $4 is not a JSON object"
  rows+=("${2,,}" "$3" "$4")
  shift 4
done

etc=${SH_BNB_ETC:-/etc/squarehole-bnb}
settings="$etc/stack.env"
[ -r "$settings" ] || fail "no $settings"
value() { sed -n "s/^$1=//p" "$settings" | tail -n 1; }
srv=$(value SH_BNB_SRV)
gateway=$(value SH_BNB_GATEWAY_PORT); gateway=${gateway:-5494}
project=${SH_BNB_PROJECT:-squarehole-bnb}
release=$(readlink -f "$srv/current")
[ -s "$release/.derived.env" ] || fail "no serving release with its .derived.env at $srv/current; nothing changed"
C=(env "SH_RELEASE=$(basename "$release")" docker compose --project-name "$project" --env-file "$settings" --env-file "$release/.derived.env"
  --file "$release/hackathon/stack/compose.yaml")
api="http://127.0.0.1:$gateway"
health() { curl -fsS --max-time 5 "$api/healthz" 2>/dev/null || echo '{}'; }
sql() { "${C[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -q -At -U squarehole -d squarehole_history -c "$1"; }
running_indexers() { docker ps --quiet --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=indexer" --filter status=running; }

# 1. The index follows now: its head, and the boxes it lists.
h=$(health)
[ "$(jq -r '.following // false' <<<"$h")" = true ] || fail "the index does not follow the chain now ($(jq -c '{following, reason}' <<<"$h")); nothing changed"
head=$(jq -r '.asOf.block' <<<"$h")
[[ $head =~ ^[0-9]+$ ]] || fail "no head in the index's health answer; nothing changed"
tokens=$(curl -fsS --max-time 10 "$api/v2/feed" | jq -r '.cards[].token') || fail "the feed did not answer; nothing changed"
say "the index follows at block $head; $(wc -w <<<"$tokens") boxes listed"

# 2. Stopped, and confirmed.
"${C[@]}" stop indexer >/dev/null 2>&1 || true
if [ -n "$(running_indexers)" ]; then
  fail "the indexer did not stop (Docker still lists it running); nothing was deleted; the index serves as before"
fi
say "the indexer is stopped (Docker lists none running)"

# 3. One transaction.
tables="chain_blocks boxes trades activity batches depth_events transfers balances items candles writer_cursor history_replays"
statement="BEGIN;"
for t in $tables; do statement="$statement DELETE FROM $t WHERE chain_id = 97;"; done
if ! sql "$statement COMMIT;" >/dev/null; then
  "${C[@]}" start indexer >/dev/null 2>&1 || true
  fail "the delete failed and was rolled back: the history is as it was; the indexer was started again (check: $api/healthz)"
fi
say "chain 97's history deleted (one transaction)"

# 4. Started; followed until the history is written at or past the recorded head.
"${C[@]}" start indexer >/dev/null
deadline=$((SECONDS + ${SH_BNB_REWRITE_SECONDS:-900}))
while :; do
  h=$(health)
  cursor=$(sql "SELECT COALESCE(MAX(block), 0) FROM writer_cursor WHERE chain_id = 97;" 2>/dev/null || echo 0)
  if [ "$(jq -r '.following // false' <<<"$h")" = true ] && [ "$(jq -r '.asOf.block // "0"' <<<"$h")" -ge "$head" ] \
    && [ "$(jq -r '(.history.ok // false) and ((.history.pending // 1) == 0)' <<<"$h")" = true ] && [ "${cursor:-0}" -ge "$head" ]; then
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    fail "the history is not yet written to block $head after ${SH_BNB_REWRITE_SECONDS:-900} s (health $(jq -c '{following, block: .asOf.block, history}' <<<"$h"), history cursor ${cursor:-none}): the indexer runs and the site serves, its activity may be partial; look at \`docker compose ... logs indexer\`, then run this script again (it deletes and rewrites again)"
  fi
  sleep 5
done
say "the index follows at block $(jq -r '.asOf.block' <<<"$h"); the history is written to block $cursor (recorded head $head)"

# 5. The named rows, and every listed box's first page.
for ((i = 0; i < ${#rows[@]}; i += 3)); do
  token=${rows[i]} id=${rows[i + 1]} want=${rows[i + 2]}
  data=$(sql "SELECT data FROM activity WHERE chain_id = 97 AND token = '$token' AND block = ${id%-*} AND log_index = ${id#*-};")
  [ -n "$data" ] || fail "row $token $id is missing from the rewritten history (the history is complete to block $cursor; the indexer runs)"
  jq -e --argjson want "$want" 'contains($want)' >/dev/null <<<"$data" || fail "row $token $id reads $(jq -c . <<<"$data"), not $want (the indexer runs)"
  say "row $token $id: $(jq -c --argjson want "$want" 'with_entries(select(.key as $k | $want | has($k)))' <<<"$data")"
done
# parseActivityPageV2's acceptance rules: a body with items and a cursor; each trade's side, route, amounts, trader and
# price; each event's source and name as strings; every item's id, block, log index, hashes and time. jq checks the
# address's shape (the page also checks its checksum when the case is mixed).
accept='def raw: type == "string" and test("^(0|[1-9][0-9]{0,77})$");
  def h32: type == "string" and test("^0x[0-9a-fA-F]{64}$");
  def addr: type == "string" and test("^0x[0-9a-fA-F]{40}$");
  def base: (.block | raw) and (.logIndex | type == "number" and . >= 0 and . <= 4294967295 and floor == .)
    and (.id == "\(.block)-\(.logIndex)") and (.blockHash | h32) and (.txHash | h32) and (.timestamp | raw);
  type == "object" and (.items | type == "array")
  and (.next == null or (.next | type == "string" and test("^[0-9]{1,20}-[0-9]{1,5}$")))
  and (.asOf == null or (.asOf | type == "object" and (.block | raw)))
  and all(.items[]; type == "object" and
    (if .kind == "trade" then base and (.side == "buy" or .side == "sell") and (.route | type == "string")
       and (.qRaw | raw) and (.tRaw | raw) and (.taxQ | raw) and (.sqrtPriceX96After | raw) and (.trader == null or (.trader | addr))
     elif .kind == "v2_event" then base and (.data | type == "object") and (.data.source | type == "string") and (.data.event | type == "string")
     else true end))'
for token in $tokens; do
  page=$(curl -fsS --max-time 15 "$api/v2/boxes/97/$token/activity?limit=50") || fail "box $token's activity did not answer (the indexer runs)"
  jq -e "$accept" >/dev/null <<<"$page" || fail "box $token's first activity page is not one the page accepts (the indexer runs; send me this line)"
  say "box $token: its first activity page is accepted ($(jq '.items | length' <<<"$page") items)"
done
say complete
