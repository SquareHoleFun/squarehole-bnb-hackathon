#!/usr/bin/env bash
# systemd creates the private StateDirectory. The lock also covers manual runs and durable budget reservation.
set +x
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
state_dir=/var/lib/squarehole-indexer-heal
release_file=$script_dir/../.env
manifest_file=/srv/squarehole/manifests/11155111.json

# Do not inherit a remote context or credentials from the caller. All Docker output is captured or suppressed.
docker() {
  /usr/bin/timeout --kill-after=1 "$docker_timeout" /usr/bin/env -i \
    PATH=/usr/local/bin:/usr/bin:/bin DOCKER_HOST=unix:///var/run/docker.sock DOCKER_CONFIG=/etc/squarehole/docker \
    /usr/bin/docker "$@"
}

internal_error() { printf '{"decision":"internal-error","gatewayFailures":0,"stuckRuns":0,"restarts24h":0}\n'; }

# Never echo an unvalidated container line into the host journal, even on image/runtime failure.
decision_line() {
  jq -ces '
    def count($max): type == "number" and . >= 0 and . <= $max and . == floor;
    if length != 1 then error("invalid") else .[0] end |
    if (keys == ["decision","gatewayFailures","restarts24h","stuckRuns"])
      and (.gatewayFailures | count(3)) and (.stuckRuns | count(3)) and (.restarts24h | count(4))
      and (.decision | IN("clock-rollback", "container-unavailable", "startup-grace", "rpc-unavailable",
        "rpc-behind", "state-recovery-hold", "observing", "no-action", "daily-cap", "cooldown",
        "restart-gateway", "restart-stalled", "restart-failed", "internal-error"))
    then . else error("invalid") end' 2>/dev/null
}

main() {
  local release id='' inspection=null chain_id=null decision action outcome code docker_timeout=5
  local compose=(compose --project-name squarehole --project-directory /srv/squarehole/current/infra/server)
  local inspect_format='[{{json .Id}},{{json .State.StartedAt}},{{json (index .Config.Labels "com.docker.compose.project")}},{{json (index .Config.Labels "com.docker.compose.service")}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "SH_CORE_HTTP_URLS"}},{{json .}}{{end}}{{end}}]'
  if ! { exec 9>"$state_dir/run.lock"; } 2>/dev/null; then internal_error; return 1; fi
  if ! flock --nonblock 9; then printf '{"decision":"already-running"}\n'; return 0; fi
  if ! release=$(cat "$release_file" 2>/dev/null) || [[ ! $release =~ ^SH_RELEASE=([0-9a-f]{40})$ ]]; then
    internal_error; return 1
  fi
  release=${BASH_REMATCH[1]}
  local run=(run --rm --pull never --name squarehole-indexer-heal-check --network host
    --read-only --cap-drop ALL --security-opt no-new-privileges --user "$(id -u)"
    --no-healthcheck --log-driver none
    --mount "type=bind,src=$state_dir,dst=/var/lib/squarehole-indexer-heal"
    --mount "type=bind,src=$script_dir/main.mjs,dst=/heal.mjs,readonly"
    --entrypoint node -i "squarehole-indexer:$release" /heal.mjs)
  if id=$(docker "${compose[@]}" ps --all --quiet indexer 2>/dev/null) && [[ $id =~ ^[0-9a-f]{64}$ ]]; then
    inspection=$(docker inspect --format "$inspect_format" "$id" 2>/dev/null) || inspection=null
  else
    id=''
  fi
  chain_id=$(jq -ce '.chainId' "$manifest_file" 2>/dev/null) || chain_id=null
  docker_timeout=30
  code=0
  decision=$({ printf '{"id":"%s","inspection":%s,"chainId":%s}\n' "$id" "$inspection" "$chain_id" |
    docker "${run[@]}"; } 2>/dev/null) || code=$?
  if ! decision=$(decision_line <<<"$decision"); then
    internal_error; return 1
  fi
  action=$(jq -r '.decision' <<<"$decision")
  if [[ $code != 0 ]]; then
    if [[ $action == internal-error ]]; then printf '%s\n' "$decision"; else internal_error; fi
    return 1
  fi
  case "$action" in
    restart-gateway|restart-stalled)
      docker_timeout=60
      if ! docker "${compose[@]}" restart indexer >/dev/null 2>&1; then
        docker_timeout=15
        code=0
        outcome=$(docker "${run[@]}" --restart-failed </dev/null 2>/dev/null) || code=$?
        # The recorder returns 1 for a persisted restart-failed outcome. Anything else means recording failed.
        if [[ $code == 1 ]] && outcome=$(decision_line <<<"$outcome") &&
          [[ $(jq -r '.decision' <<<"$outcome") == restart-failed ]]; then
          printf '%s\n' "$outcome"
        else
          internal_error
        fi
        return 1
      fi
      ;;
    internal-error|restart-failed) printf '%s\n' "$decision"; return 1 ;;
  esac
  printf '%s\n' "$decision"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main; fi
