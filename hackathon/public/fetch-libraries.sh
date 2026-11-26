#!/usr/bin/env bash
# Fetches the pinned third-party libraries into their folders: each from its public home, at the exact commit this
# copy was built with, with the libraries' own nested libraries. The list is hackathon/public/libraries.txt
# (<folder> <public home> <commit>). A folder that already holds the pinned commit is left as it is.
# usage: bash hackathon/public/fetch-libraries.sh            (from the top folder of the copy)
set -euo pipefail
cd "$(dirname "$0")/../.."
list=hackathon/public/libraries.txt
[ -f "$list" ] || { echo "fetch-libraries: $list is missing" >&2; exit 1; }
while read -r dir url commit; do
  case "$dir" in ''|'#'*) continue ;; esac
  if [ -d "$dir/.git" ] || [ -f "$dir/.git" ]; then
    if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$commit" ]; then echo "ok      $dir"; continue; fi
  elif [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
    echo "fetch-libraries: $dir holds files but no git checkout; empty it first" >&2; exit 1
  fi
  echo "fetch   $dir  ($url @ ${commit:0:12})"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote remove origin 2>/dev/null || true
  git -C "$dir" remote add origin "$url"
  git -C "$dir" fetch -q --depth 1 origin "$commit"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  git -C "$dir" submodule -q update --init --recursive --depth 1 || git -C "$dir" submodule -q update --init --recursive
  [ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ] || { echo "fetch-libraries: $dir is not at $commit" >&2; exit 1; }
done < "$list"
echo "fetch-libraries: all libraries at their pinned commits"
