#!/usr/bin/env bash
# Puts one commit's static landing on the droplet as the preview at alpha.squarehole.fun, without shipping or
# restarting anything else (docs/runbooks/server.md, "The preview at alpha.squarehole.fun"):
#
#   infra/server/ship-alpha.sh [--dry-run] <commit>  any branch's commit; only committed content ships
#
# The server must run a release with SH-LANDING-ALPHA (ship.sh), and this checkout's infra/server should be that
# release's: the policy check reads this folder's Caddyfile. `git archive` packs only apps/landing/public of <commit>.
# Refused before anything is sent: a landing without index.html, 404.html, _headers or styles.css (or with one of them
# empty), one holding a link or a submodule, and one whose _headers asks for another security policy than alpha sends
# (its /* block must equal the Caddyfile's alpha_headers without X-Robots-Tag; a new policy is a Caddyfile change and a
# ship.sh first). Then the tarball goes over SSH, install-alpha.sh (this folder's, sent on standard input) unpacks it on
# the server and switches alpha to it, and smoke-alpha.sh checks https://alpha.squarehole.fun from this machine against
# the shipped bytes. Environment, as ship.sh: SH_SERVER (default squarehole@203.0.113.10), SH_SERVER_KEY (default
# ~/.ssh/squarehole_droplet).
set -euo pipefail
# Resolve bare names and relative symlink targets without platform-specific realpath flags.
script=${BASH_SOURCE[0]}
while [[ -L $script ]]; do
  command -v readlink >/dev/null 2>&1 || { printf '%s: missing tool: readlink; Arch package: coreutils; macOS provider: macOS readlink\n' "${0##*/}" >&2; exit 1; }
  parent=${script%/*}
  [[ $parent != "$script" ]] || parent=.
  link=$(readlink "$script")
  if [[ $link == /* ]]; then script=$link; else script=$parent/$link; fi
done
here=${script%/*}
[[ $here != "$script" ]] || here=.
here=$(cd "$here" && pwd)
# shellcheck source=infra/server/app/tools.sh
source "$here/app/tools.sh"
sh_require_tools bash git node ssh scp tar gzip mkdir mktemp du cut awk sort tr diff sed curl cmp date rm
dry_run=false
ref=
usage() { printf 'usage: ship-alpha.sh [--dry-run] <commit>\n' >&2; exit 2; }
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) dry_run=true; shift ;;
    -*) usage ;;
    *) [[ -z $ref ]] || usage; ref=$1; shift ;;
  esac
done
[[ -n $ref ]] || usage
# Keep Git status from refreshing the index during a plan.
if $dry_run; then export GIT_OPTIONAL_LOCKS=0; fi
commit=$(git rev-parse --verify --quiet "$ref^{commit}") ||
  { echo "ship-alpha.sh: not a commit here: $ref" >&2; exit 2; }
# From the top of the repository (after `here`, which may be relative): git ls-tree and git archive read their paths
# from the current folder, and from a subfolder the link check below would list nothing.
root=$(git rev-parse --show-toplevel) || { echo 'ship-alpha.sh: cannot resolve the Git checkout' >&2; exit 1; }
cd "$root"
server=${SH_SERVER:-squarehole@203.0.113.10}
key=${SH_SERVER_KEY:-$HOME/.ssh/squarehole_droplet}
# The outside checks pass Cloudflare Access with the founder's service token file (two header lines) when it exists and
# SH_ACCESS_HEADERS is unset; an explicitly empty SH_ACCESS_HEADERS keeps the token off.
if [[ -z ${SH_ACCESS_HEADERS+set} && -s $HOME/.ssh/squarehole_access_smoke ]]; then export SH_ACCESS_HEADERS=$HOME/.ssh/squarehole_access_smoke; fi
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes)
landing=apps/landing/public
# The reason, then any detail lines.
refuse() {
  printf 'ship-alpha.sh: %s; nothing was sent\n' "$1" >&2
  shift
  if (($#)); then printf '%s\n' "$@" >&2; fi
  exit 1
}

status=$(git status --porcelain --untracked-files=all) || refuse 'git status failed; cannot verify a clean checkout'
[[ -z $status ]] || refuse 'a clean checkout is required'

# One listing of the commit's landing serves the two checks below. A file the commit does not have is a plain refusal
# ("has no ..."); a Git probe that fails is its own refusal and is never taken for a missing file. `git cat-file` alone
# cannot tell the two apart: it fails the same way for both.
tree=$(git ls-tree -r "$commit" -- "$landing") || refuse "cannot list $commit:$landing"
for file in index.html 404.html _headers styles.css; do
  awk -F'\t' -v path="$landing/$file" '$2 == path { found = 1 } END { exit !found }' <<<"$tree" ||
    refuse "$commit has no $landing/$file (or it is empty)"
  type=$(git cat-file -t "$commit:$landing/$file") || refuse "cannot read type of $commit:$landing/$file"
  size=$(git cat-file -s "$commit:$landing/$file") || refuse "cannot read $commit:$landing/$file"
  if [[ $type != blob || $size == 0 ]]; then
    refuse "$commit has no $landing/$file (or it is empty)"
  fi
done
odd=$(awk '$1 != "100644" && $1 != "100755" { sub(/^[^\t]*\t/, ""); print }' <<<"$tree")
[[ -z $odd ]] || refuse "$commit's landing holds links or submodules: $(tr '\n' ' ' <<<"$odd")"

# The policy the landing asks for (its _headers' /* block, as smoke-landing.sh reads it) against the one alpha sends.
asked=$(git show "$commit:$landing/_headers" |
  awk '/^\/\*/ { all = ($0 == "/*"); next } /^\// { all = 0 } all && /^  / { sub(/^  /, ""); print }' | LC_ALL=C sort)
sent=$(awk '$0 == "(alpha_headers) {" { on = 1; next } on && $0 == "}" { exit }
  on && /^\t\t[A-Za-z-]+ "/ {
    line = $0; sub(/^\t\t/, "", line); name = line; sub(/ .*/, "", name)
    value = substr(line, length(name) + 3); sub(/"$/, "", value)
    if (name != "X-Robots-Tag") print name ": " value
  }' "$here/Caddyfile" | LC_ALL=C sort)
[[ -n $sent ]] || refuse "no alpha_headers in $here/Caddyfile"
if [[ $asked != "$sent" ]]; then
  lines=$(diff <(printf '%s\n' "$sent") <(printf '%s\n' "$asked") | sed -n -e 's/^< /  alpha sends:   /p' -e 's/^> /  _headers asks: /p' || true)
  refuse "$commit's $landing/_headers asks for another policy than alpha sends (alpha_headers in $here/Caddyfile)" "$lines" \
    "A new policy is a change to alpha_headers, shipped with ship.sh, before this preview."
fi

work=.cache/tmp/ship-alpha.DRY-RUN
if $dry_run; then
  printf 'ship-alpha.sh: dry run; work path placeholder: %s; committed archive file inventory:\n' "$work"
  git ls-tree -r --name-only "$commit" -- "$landing"
fi
sh_command mkdir -p .cache/tmp
sh_capture work sh_command mktemp -d .cache/tmp/ship-alpha.XXXXXX
# Only the folder created by this invocation's mktemp. The plan prints cleanup last too.
trap 'sh_command rm -rf -- "$work"' EXIT
tarball=$work/squarehole-alpha-$commit.tar.gz
archive=(git -c tar.umask=0022 archive --format=tar "$commit" "$landing")
sh_pipeline "${#archive[@]}" "${archive[@]}" node "$here/app/archive.mjs" "$tarball"
sh_capture size sh_pipeline 3 du -h "$tarball" cut -f1
if ! $dry_run; then
  echo "ship-alpha.sh: preview $commit ($size) for alpha.squarehole.fun"
fi

remote=/tmp/squarehole-alpha-$commit.tar.gz
sh_command scp "${ssh_opts[@]}" -q "$tarball" "$server:$remote" ||
  { echo "ship-alpha.sh: the upload failed; nothing ran on the server, alpha unchanged" >&2; exit 1; }
# The installer comes from this checkout (a preview's commit need not carry it), on standard input; the upload is
# removed whatever it answers. LC_ALL: a Mac forwards LC_CTYPE=UTF-8, which Ubuntu does not know (as in ship.sh).
# A refusal there says "alpha unchanged" itself; no outside check follows a failure.
# shellcheck disable=SC2029 # $remote and $commit are expanded here on purpose
sh_command_stdin "$here/install-alpha.sh" ssh "${ssh_opts[@]}" "$server" "export LC_ALL=C.UTF-8; sudo env LC_ALL=C.UTF-8 bash -s -- $remote $commit; status=\$?; rm -f $remote; exit \$status" ||
  { status=$?; echo "ship-alpha.sh: the install on the server failed (exit $status), see above; no outside check" >&2; exit "$status"; }

# From this machine, through public DNS and TLS, against the bytes just shipped. A failure is reported after the switch;
# it does not go back (ship-alpha.sh <the previous commit> does, from the folder kept on the server).
sh_command tar -xzf "$tarball" -C "$work" "$landing"
sh_command bash "$here/smoke-alpha.sh" "$work/$landing"
