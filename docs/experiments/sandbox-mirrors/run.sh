#!/usr/bin/env bash
# Reproduce the #76 mirror measurements (RESULTS.md). Linux, git, cargo, HTTPS to
# github.com; no credentials, no Docker, no VM. Everything happens under $SCRATCH, which
# is removed at the end unless KEEP=1.
#
#   docs/experiments/sandbox-mirrors/run.sh                 # all three repos + the gc race
#   REPOS="solcreek/lorehouse:main" RACE=0 STAGES=20 docs/experiments/sandbox-mirrors/run.sh
#
# The harness (harness.rs) is attached to a scratch copy of sandbox/host as a child module
# of publish, so it drives the real Publisher code; nothing in the repo is changed.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/../../../sandbox/host" && pwd)
SCRATCH=${SCRATCH:-$HOME/scratch/mirror-poc-$(date +%F)}
REPOS=${REPOS:-"solcreek/lorehouse:main django/django:main vercel/next.js:canary"}
STAGES=${STAGES:-100}
RACE=${RACE:-1}
OUT=${OUT:-$SCRATCH/results.jsonl}

mkdir -p "$SCRATCH"
rsync -a --delete --exclude target "$src/" "$SCRATCH/host/"
cp "$here/harness.rs" "$SCRATCH/host/src/poc_mirrors.rs"
printf '\n#[cfg(test)]\n#[path = "poc_mirrors.rs"]\nmod poc_mirrors;\n' >> "$SCRATCH/host/src/publish.rs"

cd "$SCRATCH/host"
export CARGO_TARGET_DIR="$SCRATCH/target"
# -j 8 and nice: the host may be serving sandboxes.
nice -n 10 cargo test --release --locked -j 8 --bin sandboxd --no-run

run() { # test-name owner name base
  POC_ROOT="$SCRATCH/$2-$3" POC_OWNER=$2 POC_NAME=$3 POC_BASE=$4 POC_STAGES=$STAGES POC_OUT=$OUT \
    POC_SEED_FETCH=${SEED_FETCH:-1} nice -n 10 cargo test --release --locked -j 8 --bin sandboxd "publish::poc_mirrors::$1" -- --ignored --nocapture --exact \
    || echo "{\"step\":\"test_failed\",\"test\":\"$1\",\"repo\":\"$2/$3\"}" >> "$OUT"
}

{ echo "{\"step\":\"host\",\"date\":\"$(date -Is)\",\"git\":\"$(git --version)\",\"kernel\":\"$(uname -r)\",\"fs\":\"$(findmnt -no FSTYPE,OPTIONS -T "$SCRATCH")\"}"; } >> "$OUT"
for r in $( [ "${GROWTH:-1}" = 1 ] && echo $REPOS ); do
  repo=${r%%:*}; base=${r#*:}
  run poc_mirror_growth "${repo%%/*}" "${repo#*/}" "$base"
  if command -v compsize >/dev/null && sudo -n true 2>/dev/null; then
    echo "{\"step\":\"compsize\",\"repo\":\"$repo\",\"out\":\"$(sudo -n compsize -b "$SCRATCH/${repo%%/*}-${repo#*/}/mirrors" 2>&1 | tr '\n' ';' | tr -s ' ')\"}" >> "$OUT"
  fi
  rm -rf "${SCRATCH:?}/${repo%%/*}-${repo#*/}"
done
if [ "$RACE" = 1 ]; then
  first=${REPOS%% *}; repo=${first%%:*}; base=${first#*:}
  POC_RACE_STAGES=${RACE_STAGES:-60} run poc_gc_race "${repo%%/*}" "${repo#*/}" "$base"
fi

echo "results: $OUT"
[ "${KEEP:-0}" = 1 ] || { cp "$OUT" "${RESULTS_COPY:-/tmp/mirror-poc-results.jsonl}"; rm -rf "$SCRATCH"; echo "scratch removed; results copied to ${RESULTS_COPY:-/tmp/mirror-poc-results.jsonl}"; }
