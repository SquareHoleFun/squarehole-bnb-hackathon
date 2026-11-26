#!/usr/bin/env bash
# Build-machine preflight. No package installation, version probe or network access.
sh_require_tools() {
  local tool arch mac missing=false
  for tool in "$@"; do
    case $tool in
      bash) arch=bash; mac='macOS bash (or bash)' ;;
      node) arch='mise (Node 24.22.1)'; mac='mise (Node 24.22.1)' ;;
      pnpm) arch='pnpm 10.29.1'; mac='pnpm 10.29.1' ;;
      git) arch=git; mac='Xcode Command Line Tools (git)' ;;
      ssh|scp) arch=openssh; mac='macOS OpenSSH' ;;
      rsync) arch=rsync; mac='macOS rsync' ;;
      curl) arch=curl; mac='macOS curl' ;;
      tar) arch=tar; mac='macOS bsdtar' ;;
      gzip) arch=gzip; mac='macOS gzip' ;;
      awk) arch=gawk; mac='macOS awk' ;;
      sed) arch='sed'; mac='macOS sed' ;;
      grep) arch='grep'; mac='macOS grep' ;;
      cmp|diff) arch=diffutils; mac='macOS diffutils' ;;
      shellcheck) arch=shellcheck; mac=shellcheck ;;
      docker) arch='docker + docker-compose'; mac='Docker Desktop (Compose v2)' ;;
      python3) arch=python; mac=python3 ;;
      *) arch=coreutils; mac='macOS base utilities' ;;
    esac
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf '%s: missing tool: %s; Arch package: %s; macOS provider: %s; install the listed package/provider\n' "${0##*/}" "$tool" "$arch" "$mac" >&2
      missing=true
    fi
  done
  ! "$missing"
}

sh_require_compose() {
  local command=(docker compose version --short)
  if "${dry_run:-false}"; then sh_command "${command[@]}"; return; fi
  "${command[@]}" >/dev/null 2>&1 || {
    printf '%s: missing tool: docker compose; Arch package: docker-compose; macOS provider: Docker Desktop (Compose v2); install the listed package/provider\n' "${0##*/}" >&2
    return 1
  }
}

# The dry plan and execution share exactly the same argv. printf %q is supported by macOS Bash 3.2 too.
# shellcheck disable=SC2154 # The calling ship script owns dry_run.
sh_command() {
  if "$dry_run"; then printf '%q ' "$@"; printf '\n'; else "$@"; fi
}

sh_command_stdin() {
  local input=$1
  shift
  if "$dry_run"; then printf '%q ' "$@"; printf '< %q\n' "$input"; else "$@" <"$input"; fi
}

# Capture stdout only in a real run; a plan prints the same command in its place.
sh_capture() {
  local destination=$1 output
  shift
  if "$dry_run"; then "$@"; else
    output=$("$@") || return $?
    printf -v "$destination" '%s' "$output"
  fi
}

# The first argument is the producer's argc; the remaining argv is the consumer.
# Callers enable pipefail, so either side failing stops shipping.
sh_pipeline() {
  local count=$1
  shift
  local producer=()
  while ((count > 0)); do producer+=("$1"); shift; count=$((count - 1)); done
  if "$dry_run"; then
    printf '%q ' "${producer[@]}"; printf '| '; printf '%q ' "$@"; printf '\n'
  else
    "${producer[@]}" | "$@"
  fi
}
