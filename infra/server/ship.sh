#!/usr/bin/env bash
# Ships one commit of this repository to the droplet and installs it there (docs/runbooks/server.md):
#
#   infra/server/ship.sh [--dry-run] [<commit>]    stack, default HEAD; clean tree required
#   infra/server/ship.sh --app sepolia --config <public env file> [--dry-run] <full reviewed commit>
# App shipping builds exact HEAD, requires pnpm check:production, activates only static files, then checks HTTPS.
# See docs/runbooks/app-hosting.md. Mainnet app shipping is refused (G08).
#
# The server cannot clone the private repository, so this builds a release tarball with `git archive`: the workspace
# manifests and lockfile, the indexer, the card service (packages/cards, its fonts and brand files, and the generic card
# from apps/web/public/share), the static landing (apps/landing/public), the workspace packages they import,
# the core v1 manifests, keeper/drand, burn-bot, reveal and CoW order poster sources and infra/server. Nothing
# secret is in it. The tarball goes over SSH and install.sh runs on the server as root; the images are built
# there. Environment: SH_SERVER (default squarehole@203.0.113.10), SH_SERVER_KEY (default ~/.ssh/squarehole_droplet).
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

fail() { printf 'ship.sh: %s\n' "$*" >&2; exit 1; }
target=stack
config=
ref=
dry_run=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) dry_run=true; shift ;;
    --app) [[ $# -ge 2 && -n $2 && $2 != -* ]] || fail '--app needs sepolia'; target=$2; shift 2 ;;
    --config) [[ $# -ge 2 && -n $2 && $2 != -* ]] || fail '--config needs a public env file'; config=$2; shift 2 ;;
    -*) fail 'unknown option' ;;
    *) [[ -z $ref ]] || fail 'only one commit is accepted'; ref=$1; shift ;;
  esac
done
# Preserve the operator's starting folder, including for a nonexistent config (the builder diagnoses it).
if [[ -n $config && $config != /* ]]; then config=$PWD/$config; fi
[[ $target == stack || $target == sepolia ]] || fail 'G08: mainnet app shipping remains refused'
sh_require_tools bash git node ssh scp tar gzip mkdir mktemp cp du cut sed curl awk cmp date
if [[ $target == sepolia ]]; then
  sh_require_tools pnpm shellcheck docker
fi
# Keep Git status from refreshing the index during a plan.
if $dry_run; then export GIT_OPTIONAL_LOCKS=0; fi
root=$(git rev-parse --show-toplevel) || fail 'cannot resolve the Git checkout'
cd "$root"
status=$(git status --porcelain --untracked-files=all) || fail 'git status failed; cannot verify a clean checkout'
[[ -z $status ]] || fail 'a clean checkout is required'
if [[ $target == sepolia ]]; then
  sh_require_compose
  [[ $ref =~ ^[a-f0-9]{40}$ && -n $config ]] || fail 'app shipping needs a full reviewed commit and --config'
else
  [[ -z $config ]] || fail '--config is only for --app sepolia'
fi
commit=$(git rev-parse --verify "${ref:-HEAD}^{commit}")
server=${SH_SERVER:-squarehole@203.0.113.10}
key=${SH_SERVER_KEY:-$HOME/.ssh/squarehole_droplet}
# The outside checks pass Cloudflare Access with the founder's service token file (two header lines) when it exists and
# SH_ACCESS_HEADERS is unset; an explicitly empty SH_ACCESS_HEADERS keeps the token off.
if [[ -z ${SH_ACCESS_HEADERS+set} && -s $HOME/.ssh/squarehole_access_smoke ]]; then export SH_ACCESS_HEADERS=$HOME/.ssh/squarehole_access_smoke; fi
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes)
paths=(
  package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc vitest.timeouts.mjs
  packages/indexer/package.json packages/indexer/src packages/indexer/scripts/register-ts.mjs
  packages/chain/package.json packages/chain/src packages/chain/scripts/register-ts.mjs
  packages/box-spec/package.json packages/box-spec/src
  packages/domain/package.json packages/domain/src
  packages/artwork/package.json packages/artwork/src
  packages/cards/package.json packages/cards/src packages/cards/assets packages/cards/scripts/register-ts.mjs
  packages/cards/scripts/check-webp.ts packages/cards/notices
  packages/keeper/package.json packages/keeper/src packages/keeper/scripts/register-ts.mjs packages/keeper/Dockerfile
  packages/burn-bot/package.json packages/burn-bot/src packages/burn-bot/Dockerfile
  packages/cow-poster/package.json packages/cow-poster/src packages/cow-poster/Dockerfile
  scripts/ipfs scripts/box/lib scripts/nft
  scripts/box/reveal-service/common.mjs scripts/box/reveal-service/poster.mjs scripts/box/reveal-service/journal.mjs
  apps/web/public/share/square-hole-1200x630.jpg
  apps/landing/public
  packages/contracts/deployments/core-v1
  packages/design/art/fit/fit-icon.svg docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png
  infra/server
)

work=.cache/tmp/ship.DRY-RUN
if $dry_run; then
  printf 'ship.sh: dry run; %s release %s; no build or upload performed\n' "$target" "$commit"
  printf 'ship.sh: work path placeholder: %s\n' "$work"
fi
sh_command mkdir -p .cache/tmp
sh_capture work sh_command mktemp -d .cache/tmp/ship.XXXXXX
# Keep artifacts and logs for review/retry. Nothing is removed automatically.
if [[ $target == sepolia ]]; then
  tarball=$work/app-$commit.tar.gz
  if $dry_run; then
    printf 'ship.sh: validation-only reads: reviewed HEAD, status, public config and source policy\n'
    node infra/server/app/build.mjs "$commit" "$target" "$config" "$work/artifact" --dry-run
    printf 'ship.sh: archive members: install.sh; artifact/{public/**,release.json,app.site.caddy,app.cors.caddy,SHA256SUMS}; public paths generated by production build\n'
  fi
  sh_command node infra/server/app/build.mjs "$commit" "$target" "$config" "$work/artifact"
  sh_command bash infra/server/app/validate.sh "$work/artifact"
  sh_command cp infra/server/app/install.sh "$work/install.sh"
  sh_command bash infra/server/app/pack.sh "$work" "$tarball"
  remote=/tmp/squarehole-app-$commit-$$.tar.gz
  sh_command scp "${ssh_opts[@]}" -q "$tarball" "$server:$remote"
  # shellcheck disable=SC2029 # Only the validated commit and generated remote name expand locally.
  sh_command ssh "${ssh_opts[@]}" "$server" "set -e; d=\$(mktemp -d /tmp/squarehole-app.XXXXXX); tar -xzf '$remote' -C \"\$d\"; sudo bash \"\$d/install.sh\" \"\$d/artifact\" '$commit'"
  sh_command bash infra/server/smoke-app.sh "$work/artifact"
  if $dry_run; then exit 0; fi
  printf 'ship.sh: checked app artifact retained at %s/artifact\n' "$work"
  exit 0
fi
tarball=$work/squarehole-$commit.tar.gz
if $dry_run; then
  printf 'ship.sh: committed archive file inventory:\n'
  git ls-tree -r --name-only "$commit" -- "${paths[@]}"
fi
archive=(git -c tar.umask=0022 archive --format=tar "$commit" "${paths[@]}")
sh_pipeline "${#archive[@]}" "${archive[@]}" node "$here/app/archive.mjs" "$tarball"
size='' manifest=''
sh_capture size sh_pipeline 3 du -h "$tarball" cut -f1
sh_capture manifest sh_pipeline 3 git show "$commit:packages/contracts/deployments/core-v1/11155111.json" sed -n 's/.*"status": *"\([^"]*\)".*/\1/p'
if ! $dry_run; then echo "ship.sh: release $commit ($size), manifest status: $manifest"; fi

remote=/tmp/squarehole-$commit.tar.gz
sh_command scp "${ssh_opts[@]}" -q "$tarball" "$server:$remote"
# LC_ALL: a Mac forwards LC_CTYPE=UTF-8, which Ubuntu does not know (apt and perl warn at length).
# shellcheck disable=SC2029 # $remote and $commit are expanded here on purpose
sh_command ssh "${ssh_opts[@]}" "$server" "set -e; export LC_ALL=C.UTF-8; d=\$(mktemp -d); tar -xzf $remote -C \$d infra/server/install.sh; sudo env LC_ALL=C.UTF-8 bash \$d/infra/server/install.sh $remote $commit"

# Run from the caller's machine, outside the droplet, against public DNS and TLS. Use the shipped commit's checker
# and bytes even when a different commit was requested. A failure is reported after install; it does not roll back.
sh_command tar -xzf "$tarball" -C "$work" infra/server/smoke-landing.sh apps/landing/public
sh_command bash "$work/infra/server/smoke-landing.sh" "$work/apps/landing/public"
