//! The mirrors' upkeep (#76; measured in docs/experiments/sandbox-mirrors/RESULTS.md): how
//! much disk they may use, when their garbage is collected, when a mirror is dropped, and
//! what the runner status says about them.
//!
//! - **gc.** `git gc --prune=now`, always under the mirror's lock (from outside it, it was
//!   seen to wedge a mirror): after a stage whose bundle was over `heavy_bundle` failed, was
//!   cut off, or expired unpushed; and once a day per mirror used since its last gc, once it
//!   has had no job for `gc_idle`. Its own deadline, `gc_deadline` (a 2.7 GB mirror took
//!   13 s).
//! - **Retention.** A mirror is dropped `retention` after its last stage or push, never
//!   while a live stage record names it, never while its lock is held.
//! - **Quotas, fail closed (507).** One mirror may use `mirror_max`, all of them
//!   `mirrors_max`, and the filesystem keeps `free_min_pct` or `free_min` free, whichever is
//!   larger. Checked before the refresh (from the last measured size; a new mirror counts at
//!   `mirror_max`, against the total and the free space over the floor), after it, and after
//!   the bundle fetch. A mirror over its cap is removed, unless a live stage record names it.
//!   New mirrors are made one at a time, host-wide (`new_mirrors`): admitted, fetched and
//!   measured before the next is admitted, so two can't count on the same room; a stage of a
//!   second new repo waits for the first's fetch. Stages of existing mirrors don't wait, and
//!   run at once: those growing together can pass the total by what those stages fetch (the
//!   refresh and the bundle: about 10 KB for a typical stage, measured; more for an
//!   artifact-sized one). A check that finds it over refuses the stage: its bundle is
//!   collected by the gc (at once if heavy), its refresh stays with the mirror until it is
//!   evicted or dropped.
//!   Before refusing, mirrors idle for over `evict_idle` are dropped, least recently used
//!   first, until the mirrors use at most 80% of `mirrors_max` and the floor holds.
//! - **Status.** Sizes are measured after every job (a failed refresh and a push's gc
//!   included), gc and upkeep pass, and kept; the status reads what was kept, never the disk.
//!   The kept sizes are a cache, by design: anything else that changes a mirror (git on its
//!   own, an operator) shows at the next measurement, at the latest the next upkeep pass
//!   (every 5 minutes). The quotas are enforced against it at admission and again after
//!   each fetch, so a lag of one pass can't let a mirror grow without bound.
//!
//! What a mirror was last used for is kept beside the mirrors, in
//! `<mirrors>/.upkeep/<owner>/<name>.json`, not in the mirror: a mirror is writable by the
//! uid its git runs as (gitjail.rs), which must neither set its own retention nor plant a
//! link sandboxd would write through. (It was the mirror's `sandboxd.json` before: that
//! file is removed when the mirror's state is next written.)

use super::{expired, remove_mirror, Failure, Publisher, StageRecord};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use std::time::{Duration, Instant};

pub const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;
/// Eviction stops once the mirrors use this share of mirrors_max (in percent).
const EVICT_TO_PCT: u64 = 80;
/// Where a mirror's upkeep state was kept before, in the mirror itself.
const OLD_STATE: &str = "sandboxd.json";
/// After a gc fails (or runs out of time), how long until the next try on that mirror.
const GC_RETRY: u64 = 3600;

/// What the mirrors may use, and when they are collected and dropped. The quotas and the
/// retention come from sandboxd's configuration (config.rs); the rest is fixed outside tests.
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// The most one mirror may use (SANDBOXD_MIRROR_MAX_GIB).
    pub mirror_max: u64,
    /// The most all mirrors together may use (SANDBOXD_MIRRORS_MAX_GIB).
    pub mirrors_max: u64,
    /// The filesystem keeps this percentage of its size free (SANDBOXD_MIRRORS_FREE_PCT)…
    pub free_min_pct: u64,
    /// …or this many bytes, whichever is larger (SANDBOXD_MIRRORS_FREE_GIB).
    pub free_min: u64,
    /// A mirror is dropped this long after its last stage or push
    /// (SANDBOXD_MIRROR_RETENTION_DAYS).
    pub retention: Duration,
    /// Mirrors idle for longer may be evicted to make room.
    pub evict_idle: Duration,
    /// A mirror used since its last gc is collected once per this…
    pub gc_every: Duration,
    /// …once it has had no job for this long.
    pub gc_idle: Duration,
    /// The deadline of one gc.
    pub gc_deadline: Duration,
    /// A stage whose bundle is over this, and that fails, is cut off or expires unpushed, is
    /// collected after (what it brought is kept byte for byte otherwise, for 2 weeks).
    pub heavy_bundle: u64,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy {
            mirror_max: 4 * GIB,
            mirrors_max: 24 * GIB,
            free_min_pct: 10,
            free_min: 20 * GIB,
            retention: Duration::from_secs(14 * 86_400),
            evict_idle: Duration::from_secs(86_400),
            gc_every: Duration::from_secs(86_400),
            gc_idle: Duration::from_secs(10 * 60),
            gc_deadline: Duration::from_secs(600),
            heavy_bundle: 8 * MIB,
        }
    }
}

impl Policy {
    /// The free space the filesystem keeps.
    fn floor(&self, fs_size: u64) -> u64 {
        (fs_size / 100 * self.free_min_pct).max(self.free_min)
    }
}

/// Where sizes come from: the disk in production, set by hand in tests.
pub trait Disk: Send + Sync {
    /// The bytes a mirror uses (apparent sizes, as `du -sb`), and how many of those are
    /// garbage (git's partial packs, stage bundles).
    fn usage(&self, dir: &Path) -> (u64, u64);
    /// Free bytes (for an unprivileged user) and the size of the filesystem `dir` is on.
    fn fs(&self, dir: &Path) -> Option<(u64, u64)>;
}

pub struct RealDisk;

impl Disk for RealDisk {
    fn usage(&self, dir: &Path) -> (u64, u64) {
        // Garbage by the names remove_garbage() goes by, each only where that file lives (a
        // branch may be called tmp_pack_x).
        fn walk(top: &Path, place: &Path, sum: &mut (u64, u64)) {
            let packs = place == top.join("objects").join("pack");
            for entry in std::fs::read_dir(place).into_iter().flatten().flatten() {
                // DirEntry::metadata doesn't follow a symlink.
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    walk(top, &entry.path(), sum);
                    continue;
                }
                sum.0 += meta.len();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if (packs && (name.starts_with("tmp_pack_") || name.starts_with("tmp_idx_"))) || (place == top && name.starts_with("stage-") && name.ends_with(".bundle")) {
                    sum.1 += meta.len();
                }
            }
        }
        let mut sum = (0, 0);
        walk(dir, dir, &mut sum);
        sum
    }

    // f_bavail and the rest are u32 on some platforms and u64 on others.
    #[allow(clippy::unnecessary_cast)]
    fn fs(&self, dir: &Path) -> Option<(u64, u64)> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
        // SAFETY: statvfs writes into the struct it is given and reads a NUL-terminated path.
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut s) } != 0 {
            return None;
        }
        let unit = s.f_frsize as u64;
        Some((s.f_bavail as u64 * unit, s.f_blocks as u64 * unit))
    }
}

/// What a mirror's upkeep keeps in it. Times are unix seconds.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub(super) struct MirrorState {
    #[serde(rename = "lastUsed", default)]
    pub(super) last_used: u64,
    #[serde(rename = "lastGc", default)]
    pub(super) last_gc: u64,
    /// When a gc last failed: none is tried again for GC_RETRY.
    #[serde(rename = "gcFailedAt", default)]
    pub(super) gc_failed_at: u64,
    /// Stages whose bundle was over heavy_bundle and that weren't pushed (yet).
    #[serde(default)]
    pub(super) heavy: Vec<String>,
}

/// Where the upkeep state of the mirror in `dir` (`<mirrors>/<owner>/<name>.git`) is:
/// `<mirrors>/.upkeep/<owner>/<name>.json`, out of the mirror's reach.
pub(super) fn state_path(dir: &Path) -> PathBuf {
    let name = dir.file_name().map(|n| n.to_string_lossy().trim_end_matches(".git").to_string()).unwrap_or_default();
    let owner = dir.parent();
    let mirrors = owner.and_then(Path::parent).unwrap_or(Path::new("."));
    mirrors.join(".upkeep").join(owner.and_then(Path::file_name).unwrap_or_default()).join(format!("{name}.json"))
}

pub(super) fn read_state(dir: &Path) -> Option<MirrorState> {
    serde_json::from_slice(&std::fs::read(state_path(dir)).ok()?).ok()
}

/// Written whole (a temporary file renamed into place). Not synced: losing it to a crash
/// costs a gc or a few days' retention, nothing else.
fn write_state(dir: &Path, state: &MirrorState) {
    let path = state_path(dir);
    let Some(parent) = path.parent() else { return };
    let tmp = parent.join(format!(".{}.tmp", path.file_name().unwrap_or_default().to_string_lossy()));
    let written = std::fs::create_dir_all(parent)
        .and_then(|()| serde_json::to_vec(state).map_err(std::io::Error::other))
        .and_then(|json| std::fs::write(&tmp, json))
        .and_then(|()| std::fs::rename(&tmp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    // Where it was kept before: unlinked, never followed.
    let _ = std::fs::remove_file(dir.join(OLD_STATE));
}

/// `owner/name` of a mirror's directory (`<mirrors>/<owner>/<name>.git`).
fn repo_of(dir: &Path) -> String {
    let name = dir.file_name().map(|n| n.to_string_lossy().trim_end_matches(".git").to_string()).unwrap_or_default();
    let owner = dir.parent().and_then(Path::file_name).map(|o| o.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{owner}/{name}")
}

/// A mirror's refs/stage refs, loose or packed.
fn count_stage_refs(dir: &Path) -> u64 {
    let loose = std::fs::read_dir(dir.join("refs").join("stage")).map_or(0, |d| d.flatten().count() as u64);
    let packed = std::fs::read_to_string(dir.join("packed-refs")).map_or(0, |p| p.lines().filter(|l| l.contains(" refs/stage/")).count() as u64);
    loose + packed
}

/// Bytes in GiB for a message: whole when they are, else to one decimal.
fn gib(bytes: u64) -> String {
    if bytes.is_multiple_of(GIB) {
        (bytes / GIB).to_string()
    } else {
        format!("{:.1}", bytes as f64 / GIB as f64)
    }
}

#[derive(Clone, Copy, Default, Debug)]
struct Measured {
    bytes: u64,
    garbage: u64,
    stage_refs: u64,
    last_used: u64,
}

/// What the status reports, kept up to date by every job, gc and upkeep pass.
#[derive(Default)]
pub(super) struct Stats {
    mirrors: HashMap<PathBuf, Measured>,
    fs_free: Option<u64>,
    records: u64,
    /// The last gc: when (unix seconds), how long (ms), and what it reclaimed.
    last_gc: Option<(u64, u64, u64)>,
    evicted: u64,
    refused_for_space: u64,
    refresh_timeouts: u64,
    fs_unknown_logged: bool,
}

/// Why there is no room.
enum Short {
    /// All mirrors would use this much.
    Total(u64),
    /// The filesystem has this much free, under this floor.
    Free(u64, u64),
    /// The filesystem has this much free, over this floor, but not by the room asked for.
    FreeFor(u64, u64),
}

impl Publisher {
    /// The upkeep's limits and schedule; Policy::default() unless set.
    pub fn with_policy(mut self, policy: Policy) -> Publisher {
        self.policy = policy;
        self
    }

    /// Now, in unix seconds (a test sets the clock).
    pub(super) fn now(&self) -> u64 {
        (self.clock)()
    }

    fn stats(&self) -> MutexGuard<'_, Stats> {
        self.stats.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The mirrors on disk.
    fn mirror_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        for owner in std::fs::read_dir(&self.mirrors).into_iter().flatten().flatten() {
            // .stages and the like aren't owners.
            if owner.file_name().to_string_lossy().starts_with('.') || !owner.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            for mirror in std::fs::read_dir(owner.path()).into_iter().flatten().flatten() {
                if mirror.file_name().to_string_lossy().ends_with(".git") && mirror.file_type().is_ok_and(|t| t.is_dir()) {
                    dirs.push(mirror.path());
                }
            }
        }
        dirs
    }

    /// The repos a live stage record (one push could still use) names.
    fn live_repos(&self) -> HashSet<String> {
        let now = self.now();
        let mut live = HashSet::new();
        for entry in std::fs::read_dir(self.records()).into_iter().flatten().flatten() {
            let Ok(bytes) = std::fs::read(entry.path()) else { continue };
            if let Ok(r) = serde_json::from_slice::<StageRecord>(&bytes) {
                if !expired(r.created_at, now) {
                    live.insert(format!("{}/{}", r.owner, r.name));
                }
            }
        }
        live
    }

    fn fs(&self) -> Option<(u64, u64)> {
        self.disk.fs(&self.mirrors).or_else(|| self.mirrors.parent().and_then(|p| self.disk.fs(p)))
    }

    /// Measure a mirror (and the filesystem, and the records) for the quotas and the status.
    /// Its size in bytes.
    fn measure(&self, dir: &Path) -> u64 {
        let (bytes, garbage) = self.disk.usage(dir);
        let last_used = match read_state(dir) {
            Some(s) => s.last_used,
            None => {
                // A mirror from before its upkeep was kept: counted as used now.
                let now = self.now();
                write_state(dir, &MirrorState { last_used: now, ..MirrorState::default() });
                now
            }
        };
        let m = Measured { bytes, garbage, stage_refs: count_stage_refs(dir), last_used };
        let fs_free = self.fs().map(|(free, _)| free);
        let records = self.count_records();
        let mut st = self.stats();
        st.mirrors.insert(dir.to_path_buf(), m);
        st.fs_free = fs_free;
        st.records = records;
        bytes
    }

    fn count_records(&self) -> u64 {
        std::fs::read_dir(self.records()).map_or(0, |d| d.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".json")).count() as u64)
    }

    /// Remove a mirror (its lock held) and forget it.
    pub(super) fn drop_mirror(&self, dir: &Path) {
        remove_mirror(dir);
        self.forget(dir);
    }

    fn forget(&self, dir: &Path) {
        self.stats().mirrors.remove(dir);
    }

    fn total(&self) -> u64 {
        self.stats().mirrors.values().map(|m| m.bytes).sum()
    }

    /// Whether the mirrors, with `extra` bytes more, fit, and the filesystem keeps its floor
    /// with `extra` bytes less free.
    fn room(&self, extra: u64) -> Result<(), Short> {
        let total = self.total() + extra;
        if total > self.policy.mirrors_max {
            return Err(Short::Total(total - extra));
        }
        match self.fs() {
            Some((free, size)) if free < self.policy.floor(size) => Err(Short::Free(free, self.policy.floor(size))),
            Some((free, size)) if free - extra.min(free) < self.policy.floor(size) => Err(Short::FreeFor(free, self.policy.floor(size))),
            Some(_) => Ok(()),
            None => {
                // Unknown: the quotas still hold; the floor can't be checked.
                if !self.stats().fs_unknown_logged {
                    self.stats().fs_unknown_logged = true;
                    eprintln!("sandboxd: can't read the free space of {}: the mirrors' free-space floor isn't checked", self.mirrors.display());
                }
                Ok(())
            }
        }
    }

    /// Make room by dropping mirrors idle for over evict_idle, least recently used first:
    /// never `keep`, one a live stage record names, or one whose lock is held (it is never
    /// waited for: the caller holds `keep`'s). Until the mirrors, with `extra` bytes more, use at
    /// most EVICT_TO_PCT of mirrors_max and the filesystem keeps its floor, or none is left.
    fn evict(&self, keep: &Path, extra: u64) {
        let now = self.now();
        let live = self.live_repos();
        let mut idle: Vec<(u64, PathBuf)> = self.stats().mirrors.iter().filter(|(d, m)| d.as_path() != keep && now.saturating_sub(m.last_used) > self.policy.evict_idle.as_secs()).map(|(d, m)| (m.last_used, d.clone())).collect();
        idle.sort();
        for (last_used, dir) in idle {
            let enough = self.total() + extra <= self.policy.mirrors_max / 100 * EVICT_TO_PCT && self.room(extra).is_ok();
            if enough {
                break;
            }
            if live.contains(&repo_of(&dir)) {
                continue;
            }
            let lock = self.lock(&dir);
            let Ok(_held) = lock.try_lock() else { continue };
            // Looked at again under its lock: a stage of it may have ended since the list
            // was made.
            let used = read_state(&dir).map_or(last_used, |s| s.last_used);
            if now.saturating_sub(used) <= self.policy.evict_idle.as_secs() || self.live_repos().contains(&repo_of(&dir)) {
                continue;
            }
            remove_mirror(&dir);
            self.forget(&dir);
            self.stats().evicted += 1;
            eprintln!("sandboxd: dropped the mirror of {} to make room (idle {} h)", repo_of(&dir), now.saturating_sub(last_used) / 3600);
        }
    }

    /// Room for `extra` bytes more, evicting if needed; else a 507 that says why. `need` is
    /// what the message says this mirror needs.
    fn make_room(&self, dir: &Path, owner: &str, name: &str, extra: u64, need: u64) -> Result<(), Failure> {
        if self.room(extra).is_ok() {
            return Ok(());
        }
        self.evict(dir, extra);
        let short = match self.room(extra) {
            Ok(()) => return Ok(()),
            Err(short) => short,
        };
        self.stats().refused_for_space += 1;
        let message = match short {
            Short::Total(used) => format!(
                "the sandbox host has no room for the mirror of {owner}/{name} (mirrors use {} of {} GiB, and this one would need up to {} GiB): nothing was staged. Try again later, or ask an operator to raise SANDBOXD_MIRRORS_MAX_GIB or free space on the host.",
                gib(used),
                gib(self.policy.mirrors_max),
                gib(need)
            ),
            Short::Free(free, floor) => format!(
                "the sandbox host is low on disk space ({} GiB free, under the {} GiB it keeps free), so it has no room for the mirror of {owner}/{name}: nothing was staged. Try again later, or ask an operator to free space on the host.",
                gib(free),
                gib(floor)
            ),
            Short::FreeFor(free, floor) => format!(
                "the sandbox host is low on disk space for the mirror of {owner}/{name} ({} GiB free, and it keeps {} GiB free; this one would need up to {} GiB): nothing was staged. Try again later, or ask an operator to free space on the host.",
                gib(free),
                gib(floor),
                gib(need)
            ),
        };
        Err((507, message))
    }

    /// A mirror over its cap: a 507, and removed, unless a live stage record names it (its
    /// push needs the mirror; the first stage after no record does, removes it).
    fn over_cap(&self, dir: &Path, owner: &str, name: &str, bytes: u64) -> Failure {
        if !self.live_repos().contains(&repo_of(dir)) {
            remove_mirror(dir);
            self.forget(dir);
        }
        self.stats().refused_for_space += 1;
        (507, format!("the mirror of {owner}/{name} is {} GiB, over the {} GiB a repo may use on this sandbox host: nothing was staged. An operator can raise SANDBOXD_MIRROR_MAX_GIB.", gib(bytes), gib(self.policy.mirror_max)))
    }

    /// Before a stage's refresh, under the mirror's lock: the mirror as last measured is
    /// within its cap, and there is room for it. A `new` one (never fetched into: is_new)
    /// counts at mirror_max, and is admitted under `new_mirrors`.
    pub(super) fn admit(&self, dir: &Path, owner: &str, name: &str, new: bool) -> Result<(), Failure> {
        if new {
            return self.make_room(dir, owner, name, self.policy.mirror_max, self.policy.mirror_max);
        }
        let mut known = self.stats().mirrors.get(dir).map(|m| m.bytes);
        if known.is_none() && dir.join("HEAD").exists() {
            // On disk, not measured yet: put there after the start's inventory, not by a stage.
            known = Some(self.measure(dir));
        }
        match known {
            Some(bytes) if bytes > self.policy.mirror_max => Err(self.over_cap(dir, owner, name, bytes)),
            Some(bytes) => self.make_room(dir, owner, name, 0, bytes),
            None => self.make_room(dir, owner, name, self.policy.mirror_max, self.policy.mirror_max),
        }
    }

    /// After a fetch into the mirror (the refresh, a bundle), under its lock: measured; over
    /// its cap, it is removed; either way, refused when there is no room.
    pub(super) fn check_size(&self, dir: &Path, owner: &str, name: &str) -> Result<(), Failure> {
        let bytes = self.measure(dir);
        if bytes > self.policy.mirror_max {
            return Err(self.over_cap(dir, owner, name, bytes));
        }
        self.make_room(dir, owner, name, 0, bytes)
    }

    /// A refresh failed: counted if it ran out of time, forgotten if the mirror is gone, and
    /// measured again if not (what the failed fetch left counts at once, not at the next pass).
    pub(super) fn refresh_failed(&self, dir: &Path, error: &str) {
        if error.contains(" took over ") {
            self.stats().refresh_timeouts += 1;
        }
        if dir.join("HEAD").exists() {
            self.measure(dir);
        } else {
            self.forget(dir);
        }
    }

    /// A stage's bundle was read: if it is heavy, the stage is noted, so that what it brought
    /// is collected once it can't be pushed (it failed, was cut off, or expired).
    pub(super) fn mark_heavy(&self, dir: &Path, bundle: &Path, id: &str) {
        if std::fs::metadata(bundle).is_ok_and(|m| m.len() > self.policy.heavy_bundle) {
            let mut state = read_state(dir).unwrap_or_default();
            state.heavy.push(id.to_string());
            write_state(dir, &state);
        }
    }

    /// After a stage or a push, under the mirror's lock, prune() done: the mirror is stamped
    /// as used, what a heavy stage that won't be pushed brought is collected, and the mirror
    /// is measured. `pushed`: the stage a push just pushed.
    pub(super) async fn after_job(&self, dir: &Path, pushed: Option<&str>) {
        if !dir.join("HEAD").exists() {
            self.forget(dir);
            return;
        }
        let mut state = read_state(dir).unwrap_or_default();
        state.last_used = self.now();
        if let Some(id) = pushed {
            state.heavy.retain(|h| h != id);
        }
        write_state(dir, &state);
        self.collect_heavy(dir, &mut state).await;
        self.measure(dir);
    }

    /// gc --prune=now if a heavy stage of this mirror has no record any more (it failed, was
    /// cut off, expired, or its push failed). Under the mirror's lock.
    async fn collect_heavy(&self, dir: &Path, state: &mut MirrorState) {
        if state.heavy.iter().all(|id| self.record_path(id).exists()) {
            return;
        }
        if self.gc(dir, state).await {
            state.heavy.retain(|id| self.record_path(id).exists());
            write_state(dir, state);
        }
    }

    /// `git gc --prune=now`, under the mirror's lock, with its own deadline. Safe there: the
    /// lock excludes every stage and push of this mirror, and nothing else writes to it.
    /// Objects of a live stage are kept by its refs/stage ref. Whether it succeeded.
    async fn gc(&self, dir: &Path, state: &mut MirrorState) -> bool {
        if self.now().saturating_sub(state.gc_failed_at) < GC_RETRY {
            return false;
        }
        let before = self.disk.usage(dir).0;
        let started = Instant::now();
        let done = self.git.run(dir, &["gc", "--quiet", "--prune=now"], self.policy.gc_deadline).await;
        let ms = started.elapsed().as_millis() as u64;
        let reclaimed = before.saturating_sub(self.disk.usage(dir).0);
        if let Err(e) = &done {
            eprintln!("sandboxd: gc of the mirror of {}: {e}", repo_of(dir));
            state.gc_failed_at = self.now();
            write_state(dir, state);
            return false;
        }
        let now = self.now();
        state.last_gc = now;
        write_state(dir, state);
        self.stats().last_gc = Some((now, ms, reclaimed));
        true
    }

    /// Every mirror on disk measured, for the quotas: run at start, before any job is taken
    /// (the first upkeep pass may take minutes to reach them all, a gc at a time).
    pub fn inventory(&self) {
        for dir in self.mirror_dirs() {
            if dir.join("HEAD").exists() {
                self.measure(&dir);
            }
        }
    }

    /// The periodic pass (at start, then every few minutes), over every mirror whose lock is
    /// free (a busy one is skipped, never waited for): retention, the housekeeping (prune),
    /// what heavy stages left, the daily gc; then every mirror is measured for the status.
    pub async fn maintain(&self) {
        let live = self.live_repos();
        let dirs = self.mirror_dirs();
        for dir in &dirs {
            let lock = self.lock(dir);
            let Ok(_held) = lock.try_lock() else { continue };
            let now = self.now();
            let Some(mut state) = read_state(dir) else {
                self.measure(dir); // stamps it as used now
                continue;
            };
            let idle = now.saturating_sub(state.last_used);
            // Looked at again under its lock, as evict() does: a stage of it may have written
            // its record since the pass began.
            if idle > self.policy.retention.as_secs() && !live.contains(&repo_of(dir)) && !self.live_repos().contains(&repo_of(dir)) {
                remove_mirror(dir);
                self.forget(dir);
                self.stats().evicted += 1;
                eprintln!("sandboxd: dropped the mirror of {}: no stage in {} days", repo_of(dir), idle / 86_400);
                continue;
            }
            self.prune(dir).await;
            self.collect_heavy(dir, &mut state).await;
            let gc_due = idle >= self.policy.gc_idle.as_secs() && state.last_used >= state.last_gc && now.saturating_sub(state.last_gc) >= self.policy.gc_every.as_secs();
            if gc_due {
                self.gc(dir, &mut state).await;
            }
            self.measure(dir);
        }
        // Mirrors no longer on disk (removed by hand) are forgotten; not by the list the pass
        // started from, which a stage may have added a mirror to since.
        let fs_free = self.fs().map(|(free, _)| free);
        let records = self.count_records();
        let mut st = self.stats();
        st.mirrors.retain(|d, _| d.join("HEAD").exists());
        st.fs_free = fs_free;
        st.records = records;
    }

    /// The `mirrors` block of the runner status: what the last jobs, gcs and upkeep pass
    /// measured, never the disk now. Counters are since sandboxd started.
    pub fn status(&self) -> serde_json::Value {
        let now = self.now();
        let st = self.stats();
        let largest = st.mirrors.iter().max_by_key(|(_, m)| m.bytes).map(|(d, m)| serde_json::json!({ "repo": repo_of(d), "bytes": m.bytes }));
        serde_json::json!({
            "count": st.mirrors.len(),
            "bytes": st.mirrors.values().map(|m| m.bytes).sum::<u64>(),
            "maxBytes": self.policy.mirrors_max,
            "perMirrorMaxBytes": self.policy.mirror_max,
            "fsFreeBytes": st.fs_free,
            "garbageBytes": st.mirrors.values().map(|m| m.garbage).sum::<u64>(),
            "stageRefs": st.mirrors.values().map(|m| m.stage_refs).sum::<u64>(),
            "records": st.records,
            "largest": largest,
            "oldestIdleSecs": st.mirrors.values().map(|m| now.saturating_sub(m.last_used)).max().unwrap_or(0),
            "lastGc": st.last_gc.map(|(at, ms, reclaimed)| serde_json::json!({ "at": at, "ms": ms, "reclaimedBytes": reclaimed })),
            "evicted": st.evicted,
            "refusedForSpace": st.refused_for_space,
            "refreshTimeouts": st.refresh_timeouts,
        })
    }
}
