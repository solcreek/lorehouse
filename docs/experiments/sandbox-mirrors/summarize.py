#!/usr/bin/env python3
"""Summarize run.sh's results.jsonl into the tables in RESULTS.md.

    python3 docs/experiments/sandbox-mirrors/summarize.py results.jsonl
"""
import json
import statistics
import sys
from collections import defaultdict

MB = 1e6


def mb(b):
    return f"{b / MB:,.1f} MB"


def main(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    by_repo = defaultdict(list)
    for r in rows:
        if r.get("step") == "host":
            print(f"host: {r['date']}  {r['git']}  kernel {r['kernel']}  fs {r['fs']}\n")
        elif "repo" in r:
            by_repo[r["repo"]].append(r)

    for repo, rs in by_repo.items():
        step = lambda s: [r for r in rs if r["step"] == s]
        print(f"## {repo}")
        init = step("initial")
        if init:
            i = init[0]
            m = i["m"]
            print(f"initial: {mb(m['apparent_bytes'])} apparent, {mb(m['allocated_bytes'])} allocated, "
                  f"{m['in_pack']:,} objects in {m['packs']} pack(s), {i['branches']} branches, fetch {i['fetch_ms'] / 1000:.1f} s")
        for r in step("noop_refresh"):
            print(f"no-op refresh: {r['ms']} ms")
        stages = step("stage")
        if stages:
            ok = [s for s in stages if s["status"] == 200]
            ref = [s["refresh_ms"] for s in stages if "refresh_ms" in s]
            ver = [s["verify_ms"] for s in stages if "verify_ms" in s]
            print(f"stages: {len(stages)}, statuses {dict(sorted(defaultdict(int, {k: sum(1 for s in stages if s['status'] == k) for k in {s['status'] for s in stages}}).items()))}")
            print(f"  refresh ms median {statistics.median(ref):.0f} p95 {sorted(ref)[int(len(ref) * .95) - 1]}; "
                  f"verify ms median {statistics.median(ver):.0f} p95 {sorted(ver)[int(len(ver) * .95) - 1]}")
            print(f"  bundle bytes median {statistics.median(s['bundle_bytes'] for s in stages):.0f}, total {sum(s['bundle_bytes'] for s in stages):,}")
            print(f"  packs after each stage: min {min(s['packs'] for s in stages)} max {max(s['packs'] for s in stages)}; loose max {max(s['loose'] for s in stages)}")
        for r in step("end"):
            b, m = r["before"], r["m"]
            print(f"growth over the stages: {mb(b['apparent_bytes'])} -> {mb(m['apparent_bytes'])} "
                  f"(+{mb(m['apparent_bytes'] - b['apparent_bytes'])}), objects {b['in_pack'] + b['count']:,} -> {m['in_pack'] + m['count']:,}, "
                  f"packs {b['packs']} -> {m['packs']}, loose {m['count']}, garbage {m['garbage']} ({m['size_garbage']} KiB), stage refs {m['stage_refs']}")
        for r in step("residue"):
            x = r["r"]
            if x.get("stages"):
                print(f"  residue {r['kind']:<13} stages {x['stages']:>3}  brought {x['objects_brought']:>5}  present {x['objects_present']:>5}  "
                      f"gone {x['objects_gone']:>4}  on disk {x['disk_bytes_present']:>10,} B")
        for r in step("gc"):
            b, a, x = r["before"], r["after"], r["residue_after"]
            print(f"  gc {r['variant']:<13} ok={r['ok']!s:<5} {r['ms'] / 1000:>7.1f} s  {mb(b['apparent_bytes'])} -> {mb(a['apparent_bytes'])} "
                  f"(reclaimed {mb(b['apparent_bytes'] - a['apparent_bytes'])}); packs {b['packs']} -> {a['packs']} (cruft {a['cruft_packs']}); "
                  f"stage objects left {x['objects_present']}")
        for r in step("artifact_stage"):
            print(f"20 MiB artifact, abandoned: status {r['status']}, bundle {r['bundle_bytes']:,} B, mirror +{mb(r['after']['apparent_bytes'] - r['before']['apparent_bytes'])}, "
                  f"residue {r['residue']['disk_bytes_present']:,} B")
        for r in step("cold_start"):
            print(f"cold start: warm stage {r['warm_total_ms'] / 1000:.1f} s (refresh {r['warm']['refresh_ms']} ms), "
                  f"cold stage {r['cold_total_ms'] / 1000:.1f} s (refresh {r['cold'].get('refresh_ms')} ms), rebuilt {mb(r['m']['apparent_bytes'])}")
        for r in step("gc_race"):
            print(f"gc race [{r['gc']}]: {r['stages']} stages, statuses {r['statuses']}, gc runs {r['gc_runs']} (failed {r['gc_failed']}), "
                  f"broken stage refs {r['stage_refs_broken']}, fsck ok {r['fsck_ok']}")
            for e in r.get("errors", [])[:5]:
                print(f"    {e[:200]}")
        print()
    for r in rows:
        if r.get("step") == "compsize":
            print(f"compsize {r['repo']}: {r['out']}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "results.jsonl")
