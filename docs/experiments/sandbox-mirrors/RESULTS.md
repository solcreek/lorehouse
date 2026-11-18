# Results: sandboxd's publish mirrors, growth and a retention/quota policy (#76)

## Current state: starship, 2026-10-11

A proof of concept: numbers and a recommended policy, not the production change.

Host: starship (Ryzen 7 8745HS, 16 threads, Arch, kernel 7.2.5), git 2.55.0, scratch
directory on btrfs `@home` (zstd:3). The production sandboxd on the same host was not
touched. Three public repos, read-only over HTTPS, no token:

| | solcreek/lorehouse | django/django (mid) | vercel/next.js (large monorepo) |
|---|---|---|---|
| branches mirrored (`refs/heads/*`) | 46 | 4 | 2,724 |
| initial mirror, size / objects | 1.4 MB / 2,599 | 252.8 MB / 435,606 | 2,673 MB / 899,894 |
| initial fetch (`refresh()`) | 0.8 s | 32.0 s | **549.6 s**; another attempt **timed out at 600 s** |
| no-op refresh (every stage pays it) | 243 ms | 258 ms | 433 ms |
| verify + describe + record, median (p95) | 30 (34) ms | 36 (42) ms | 62 (67) ms |
| bundle per stage, median | 1.6 KB | 1.9 KB | 2.5 KB |
| growth over 100 stages | +1.0 MB | +13.5 MB | +26.4 MB |
| ↳ stage objects still in the mirror | 0.82 MB (1,583 objects) | 1.13 MB (2,167) | 1.07 MB (3,020) |
| ↳ the rest: git's multi-pack-index (see below) | ~0.2 MB | ~10 MB | ~20–25 MB |
| packs after each stage (min–max) / loose objects | 2–6 / 0 | 2–6 / 0 | 2–7 / 0 |
| residue of the 20 failed or abandoned stages | 78 KB | 188 KB | 141 KB |
| `tmp_pack_*` garbage left by the 5 fsck refusals | 9 KiB | 12 KiB | 19 KiB |
| one abandoned stage with a 20 MiB artifact | +21.0 MB | +21.0 MB | +21.0 MB |
| `gc --auto`, `maintenance run --auto`, `repack --geometric=2` | nothing to do | nothing | nothing |
| `gc` (default: prune after 2 weeks) | 0.05 s, −0.4 MB | 3.3 s, −10.0 MB | 14.8 s, −20.9 MB |
| `gc --prune=now` | 0.03 s, −1.0 MB, all residue gone | 3.1 s, −11.1 MB | 13.3 s, −21.9 MB |
| cold start: first stage after the mirror is dropped | 0.8 s (warm 0.3 s) | 12.3 s (warm 0.3 s) | 119 s (warm 0.7 s); 550 s and >600 s on the two earlier fetches |
| cold mirror, base branch only | 1.4 MB, 0.7 s | 250.1 MB, 84.5 s | 2,453 MB, 111.6 s |
| cold mirror, base branch only, `--filter=blob:none` | 0.37 MB, 0.5 s | 50.8 MB, 5.1 s | 96.0 MB, 6.6 s |

Sizes are apparent bytes (`du -sb`). On btrfs `compsize` reports 99% of that on disk:
git packs don't compress further, so `du` is honest for mirrors.

**The headline: ordinary stages are not what fills the disk.** A realistic stage leaves
about 10 KB (1.1 MB per 100 stages on every repo, whatever its size). What can fill a
host is (1) the mirrors themselves, which are the whole repo with every branch,
(2) a stage that carries a large artifact (kept byte for byte, up to `MAX_BUNDLE` =
96 MiB a stage), and (3) a first fetch of a large repo that times out, which leaves its
whole partial pack behind (2.3 GB measured) and starts over on the next try.

## Method

`run.sh` copies `sandbox/host` to a scratch directory and attaches `harness.rs` as a
child module of `publish`, so the measurements drive the real code: `refresh()` (the
mirror fetch from https://github.com), `stage_and_record()` / `stage_bundle()` (bundle
fetch with fsck into `refs/stage/<id>`, the diff facts, the digest, the record),
`claim()`, `prune()`, and the guarded `git()` environment. Left out: the VM (a local clone
of the mirror makes the commits with plumbing, then `git bundle create HEAD --not
--remotes=origin` as the guest does) and the network push (a "pushed" stage does
everything `push()` does except `git push`: consume the record, drop the ref, `prune()`,
`gc --auto`).

Each repo: initial mirror, then 100 stages, seeded and shuffled: 80 pushed, 5 abandoned
(recorded, never approved; the record then expires and `prune()` drops the ref), 5 refused
by fsck (a tree entry named `.git`: 422), 5 with a missing base branch (404 after the
bundle was fetched), 5 cut off between verification and record (the deadline case; the
harness calls `stage_bundle()` alone, so these report 200 but write no record). A stage is
1–3 commits of 1–4 existing text files (≤100 KB) with a line inserted in the middle.
Every stage refreshes first, as `stage()` does. Then: what each kind left in the mirror
(the objects each stage's commits brought, looked up in the mirror with
`cat-file --batch-check`), five gc variants each on a reflink copy of the same end state,
one abandoned stage with a 20 MiB random file, and a cold start (mirror deleted, next
stage timed). `poc_gc_race` runs 60 stages of lorehouse while another process loops a gc
on the same mirror, outside sandboxd's lock. `fetch-variants.sh` times narrower cold
fetches with plain git in the same guarded environment.

```bash
docs/experiments/sandbox-mirrors/run.sh                     # ~25 min here, network-bound
python3 docs/experiments/sandbox-mirrors/summarize.py results.jsonl
docs/experiments/sandbox-mirrors/fetch-variants.sh vercel/next.js canary
```

Raw lines: `results-2026-10-11.jsonl` (one `host` line per `run.sh` invocation; the
next.js growth run is the second invocation: its first one hit the 600 s fetch deadline).

## Findings

**1. Every bundle becomes a pack; git keeps the pack count down on its own.** A bundle
fetch always goes through `index-pack` (never loose objects), so each stage adds a small
pack. Git 2.55's `fetch` then starts `git maintenance run --auto --quiet --detach`
(traced with `GIT_TRACE2_EVENT`), which repacks the small packs
(`repack -d -l --cruft --cruft-expiration=2.weeks.ago --write-midx`). Packs stayed at 2–7
over 100 stages. Two side effects: that maintenance runs **detached, outside sandboxd's
per-mirror lock**, after both the refresh and the bundle fetch; and it writes a
multi-pack-index of about 28 bytes per object (25.2 MB for next.js), which is most of the
"growth" in the table and is not stage data.

**2. Residue is unreachable but not collected.** After a stage's ref is dropped (pushed,
expired, failed, cut off), its objects stay. 100% of them were still present at the end
of the run, for every kind except fsck refusals. Nothing in sandboxd collects them:
`gc --auto` after a push found nothing to do (no loose objects, fewer than 50 packs), and
git's own maintenance moves them into a cruft pack that expires after **2 weeks**. A
pushed stage's objects come back as reachable if the branch exists on GitHub (the refresh
mirrors every branch), until the branch is deleted.

**3. Failed stages: small, except two cases.**
- A stage refused by fsck brings no objects, but `index-pack` dies and leaves its input
  as `objects/pack/tmp_pack_*` (one file per refusal, the size of the bundle, up to
  96 MiB). `git gc` keeps them for 2 weeks; only `--prune=now` removed them.
- A missing base branch (404), a cut-off stage and an abandoned one keep what they
  brought, byte for byte: the 20 MiB artifact cost 21.0 MB on every repo, and stays two
  weeks under git's defaults. Worst case per stage is `MAX_BUNDLE`, 96 MiB.
- **A timed-out refresh** (`GIT_NETWORK`, 600 s) killed the next.js first fetch at 2.3 GB
  and left it as `tmp_pack_*` garbage in an otherwise empty mirror; the next stage
  starts the 2.6 GB download again from zero. Starship's GitHub throughput varied 5× in
  one afternoon (4.5–22 MB/s: next.js took 550 s, then >600 s, then 119 s), so a first
  stage on a large repo fails at random.

**4. gc is cheap, and `--prune=now` is only safe under the mirror's lock.** A full
`gc --prune=now` took 13.3 s on the 2.7 GB mirror (pack reuse; no recompression) and
removed every stage object and every `tmp_pack_*`. Run beside stages from outside the
lock, it broke things in both runs: 5 × 422, 2 × 500 in 40 stages the first time; the
second time a pack vanished under a bundle fetch, a `refs/stage/<id>` was left pointing
at a missing object, and **every following refresh failed** ("bad object
refs/stage/…"): 44 of 60 stages answered 502 and `fsck` failed. `prune()` can't heal that,
because `stage()` returns on the refresh error before it gets to `prune()`. The default
`gc` (2-week grace) ran 958 times beside 60 stages (and 442 times beside 40 in the first
run) and no stage failed; 2 and 3 of those gc runs failed themselves. The control (no
gc) had no failures either.

**5. Cold start is what retention costs.** Under a second for a small repo, ~12 s for a
250 MB one, and 2 to 10+ minutes for a 2.7 GB monorepo, past the 600 s deadline on a
slow afternoon. Retention should therefore be generous, and eviction should hit idle and
small mirrors first.

**6. Narrower mirrors.** Fetching only the base branch saves 8% on next.js (2,453 vs
2,673 MB) and nothing on django. Blobless (`--filter=blob:none`) is 5× (django) to 26× (next.js)
smaller and about 17× faster to create (next.js: 96 MB in 6.6 s). The diff, the fsck and the push
against a promisor mirror are **not measured**; it would fetch base blobs lazily during
`diff`, so it needs network (and the token) at describe time.

## Disk per host (estimates)

Steady state per mirror ≈ the repo with all branches × ~1.01 (multi-pack-index) + stage
residue for the last 2 weeks.

| mix (estimate) | mirrors | residue, 20 stages/day/repo, ~10 KB each, 14 days | with 1 in 10 stages carrying a 20 MiB artifact |
|---|---|---|---|
| 20 repos: 12 small (10 MB), 6 mid (250 MB), 2 large (2.7 GB) | ~7.0 GB | ~56 MB | +~11 GB |
| 20 repos, 5 of them large | ~15 GB | ~56 MB | +~11 GB |

Plus each timed-out first fetch of a large repo: up to its full size again, per attempt,
until something deletes it. On starship the state directory
(`/var/lib/lorehouse-sandboxes`) is on the root subvolume `@`, which snapper's `root`
config snapshots (number cleanup, limit 5): space freed by deleting a mirror comes back
only once those snapshots roll over. A quota counts what sandboxd stores; the free-space
floor must use the filesystem's own number (`statvfs`).

## Recommended policy

All values are proposals, tunable by env; "measured" means it rests on the table above.

1. **Keep git's maintenance under the lock.** Add `maintenance.auto=false` and
   `gc.auto=0` to the guarded environment (`git_command()`), so no detached maintenance
   runs outside sandboxd's per-mirror lock (finding 1). sandboxd does the maintenance
   itself, below.
2. **Clean up after every job, under the lock, in `prune()`:** remove
   `objects/pack/tmp_pack_*`, `tmp_idx_*` and `stage-*.bundle` older than 10 minutes, and
   any `refs/stage/*` whose object is missing. On a failed refresh of a mirror that has
   no pack yet, delete the mirror directory (2.3 GB left otherwise, finding 3). Run
   `prune()` on the refresh-error path too.
3. **gc after a heavy failure:** when a stage fails, is cut off, or its record expires
   unpushed, and its bundle was over 8 MiB, run `git gc --quiet --prune=now` under the
   lock before releasing it (3 s at 250 MB, 13 s at 2.7 GB, measured).
4. **Periodic gc:** once a day per mirror, when it has had no job for 10 minutes, under
   the lock: `git gc --quiet --prune=now`, with its own deadline (600 s, not
   `GIT_LOCAL`'s 120 s). `--prune=now` is safe there because the lock excludes every
   stage and push of that mirror and (with 1.) nothing else writes to it; it is not safe
   from cron or by hand (finding 4: a wedged mirror). Unreachable objects of stages with
   a live record are still referenced by `refs/stage/<id>`, so they stay.
5. **Retention:** drop a mirror **14 days after its last stage or push** (a stamp file
   touched under the lock), never while a stage record younger than `STAGE_TTL` names it
   and never while its lock is held. 14 days matches git's own grace period and keeps
   the 2–10 minute cold start of a large repo off anyone's regular path.
6. **Quotas, fail closed:**
   - per mirror: **4 GiB** (`SANDBOXD_MIRROR_MAX_GIB`): next.js (2.7 GB) fits with room
     for its residue; a larger monorepo is refused rather than allowed to take the host.
   - all mirrors: **24 GiB** (`SANDBOXD_MIRRORS_MAX_GIB`), about 3× the 20-repo estimate;
   - free-space floor: refuse when the filesystem has under **10% or 20 GiB** free,
     whichever is larger.
   - Checked before the refresh (from the last measured size), after the refresh and
     after the bundle fetch. A new mirror is admitted only if the total plus the per-mirror
     cap fits; a mirror over its cap after a fetch is deleted. Before refusing for the
     total, evict mirrors idle for over 24 h, least recently staged first, down to 80%.
   - The refusal is HTTP 507, nothing staged, and says why and what to do, e.g.:
     `the sandbox host has no room for the mirror of acme/widgets (mirrors use 23.8 of
     24 GiB, and this one would need up to 4 GiB): nothing was staged. Try again later,
     or ask an operator to raise SANDBOXD_MIRRORS_MAX_GIB or free space on the host.`
     and, for one repo:
     `the mirror of acme/monorepo is 4.6 GiB, over the 4 GiB a repo may use on this sandbox
     host: nothing was staged. An operator can raise SANDBOXD_MIRROR_MAX_GIB.`
7. **Runner status** (`status_json` in `runner.rs`), recomputed after each job and gc,
   never by walking the disk per request:
   `mirrors: { count, bytes, maxBytes, perMirrorMaxBytes, fsFreeBytes, garbageBytes,
   stageRefs, records, largest: { repo, bytes }, oldestIdleSecs, lastGc: { at, ms,
   reclaimedBytes }, evicted, refusedForSpace, refreshTimeouts }`. The last three count
   since start; `refreshTimeouts` is what tells an operator a repo is too large for the
   host's bandwidth.
8. **Separately (follow-ups, not part of this policy):** give a mirror's *first* fetch a
   longer deadline than a refresh (it timed out at 600 s on a 2.7 GB repo), and evaluate a
   blobless base-branch mirror (finding 6) against the publish path.

## Not measured

- Weeks of real use: whether git's cruft packs actually expire residue after 2 weeks
  under the auto-maintenance strategy, and the real stage rate and artifact rate per repo
  (the projections assume 20 stages/day and 1 in 10 with an artifact).
- The production mirrors on starship (left untouched), private repos (a token changes
  nothing in the git operations, but sizes differ), and repos over 3 GB.
- The real VM path (`bundle_from` over vsock) and the network push; the push only adds
  `git push` to what was measured.
- A blobless mirror through `stage_bundle()` (fsck and diff with promisor objects).
- gc while a VM is bundling: the bundle is made in the guest, so it is unaffected; only
  the host side was raced.
