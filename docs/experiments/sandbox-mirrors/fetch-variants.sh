#!/usr/bin/env bash
# How big and how slow a cold mirror is with narrower fetches than publish.rs's refresh()
# (every branch, every blob). Same guarded environment as git_command(); no deadline.
#
#   docs/experiments/sandbox-mirrors/fetch-variants.sh vercel/next.js canary [scratch-dir]
#
# Prints one JSON line per variant. The scratch directory is removed at the end.
set -euo pipefail
repo=$1 base=$2
dir=${3:-$HOME/scratch/fetch-variants-$$}
mkdir -p "$dir"
trap 'rm -rf "$dir"' EXIT

g() { # git in the guarded env, in $1
  local d=$1; shift
  env -i PATH=/usr/bin:/bin HOME="$d" LC_ALL=C GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 \
    git -C "$d" -c core.hooksPath=/dev/null -c fetch.fsckObjects=true -c transfer.fsckObjects=true \
    -c maintenance.autoDetach=false -c gc.autoDetach=false "$@"
}

variant() { # label, filter ("" for none), fetch args...
  local label=$1 filter=$2; shift 2
  local d="$dir/$label.git"
  rm -rf "$d"; mkdir -p "$d"; g "$d" init -q --bare
  g "$d" remote add origin "$url"
  if [ -n "$filter" ]; then
    # A partial clone needs its remote marked as the promisor.
    g "$d" config remote.origin.promisor true
    g "$d" config remote.origin.partialclonefilter "$filter"
    set -- --filter="$filter" "$@"
  fi
  local t0; t0=$(date +%s.%N)
  g "$d" fetch -q --prune --no-tags --no-auto-maintenance "$@"
  local t1; t1=$(date +%s.%N)
  printf '{"step":"fetch_variant","repo":"%s","variant":"%s","seconds":%.1f,"apparent_bytes":%s,"refs":%s}\n' \
    "$repo" "$label" "$(awk -v a="$t0" -v b="$t1" 'BEGIN{print b-a}')" "$(du -sb "$d" | cut -f1)" "$(g "$d" for-each-ref | wc -l)"
  rm -rf "$d"
}

url=https://github.com/$repo.git
variant base-only "" origin "+refs/heads/$base:refs/heads/$base"
variant base-only-blobless blob:none origin "+refs/heads/$base:refs/heads/$base"
