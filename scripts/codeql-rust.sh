#!/usr/bin/env bash
# Run CodeQL's Rust code-scanning queries over sandbox/host on this machine, the way the
# `security` workflow does (build-mode none), and print each result with its data flow.
#
# Why this exists: on a pull request CodeQL reports only results on the lines the pull
# request changes, so a clean pull request says nothing about a line it only moved. This
# scans everything, before a push.
#
#   scripts/codeql-rust.sh                 # all of CI's Rust queries
#   scripts/codeql-rust.sh <query or suite>  # e.g. codeql/rust-queries:queries/security/CWE-502/UnsafeDeserialization.ql
#
# Needs Linux, cargo on the PATH (the extractor reads the Cargo workspace), python3, and
# the CodeQL bundle (not the bare CLI: the bundle has the queries):
#   gh release download codeql-bundle-v<version> --repo github/codeql-action --pattern codeql-bundle-linux64.tar.gz
#   tar xzf codeql-bundle-linux64.tar.gz      # → ./codeql/codeql
# Use the version CI ran: it is in the `codeql (rust)` job's log and in code scanning's
# analyses (`gh api repos/<owner>/<repo>/code-scanning/analyses`). A newer bundle can
# report what an older one doesn't.
#
# CODEQL names the binary (default: `codeql` on the PATH). The database and the SARIF go
# in CODEQL_OUT (default: a new temporary directory, named on the last line).
# Exit status: 0 no results, 1 results, 2 it could not run.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
codeql=${CODEQL:-codeql}
query=${1:-codeql/rust-queries:codeql-suites/rust-code-scanning.qls}
out=${CODEQL_OUT:-$(mktemp -d)}

command -v "$codeql" >/dev/null || { echo "codeql-rust: no CodeQL at '$codeql'. Set CODEQL to the bundle's codeql binary (see the top of this script)" >&2; exit 2; }
command -v cargo >/dev/null || { echo "codeql-rust: cargo is not on the PATH; the Rust extractor needs it" >&2; exit 2; }

mkdir -p "$out"
if ! "$codeql" database create "$out/db" --language=rust --source-root "$root/sandbox/host" --build-mode none --overwrite >"$out/create.log" 2>&1; then
  tail -20 "$out/create.log" >&2
  echo "codeql-rust: the database could not be made; the whole log is $out/create.log" >&2
  exit 2
fi
if ! "$codeql" database analyze "$out/db" "$query" --format=sarif-latest --output "$out/results.sarif" --threads 0 >"$out/analyze.log" 2>&1; then
  tail -20 "$out/analyze.log" >&2
  echo "codeql-rust: the analysis failed; the whole log is $out/analyze.log" >&2
  exit 2
fi

python3 - "$out/results.sarif" <<'EOF'
import json
import sys

def place(loc):
    p = loc["physicalLocation"]
    return "%s:%s" % (p["artifactLocation"]["uri"], p["region"]["startLine"])

results = [r for run in json.load(open(sys.argv[1]))["runs"] for r in run["results"]]
for r in results:
    print("%s  sandbox/host/%s" % (r["ruleId"], place(r["locations"][0])))
    print("    %s" % r["message"]["text"].splitlines()[0])
    for flow in r.get("codeFlows", []):
        print("    flow: " + " -> ".join(place(s["location"]) for s in flow["threadFlows"][0]["locations"]))
print("codeql-rust: %d result(s) from %s" % (len(results), sys.argv[1]))
sys.exit(1 if results else 0)
EOF
