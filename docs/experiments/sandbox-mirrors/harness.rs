//! Proof-of-concept measurements for #76 (mirror retention and disk quota).
//!
//! Not part of the build. `run.sh` copies sandbox/host to a scratch directory, attaches
//! this file there as a child module of `publish` (one line appended to publish.rs), and
//! runs it with `cargo test --release -- --ignored --nocapture`. As a child module it
//! drives the real Publisher: `refresh` (the mirror fetch), `stage_and_record` /
//! `stage_bundle` (bundle verify into refs/stage/<id>, the diff, the record), `claim`
//! (what push consumes), `prune` (the housekeeping) and `git` / `git_capped` (the guarded
//! git environment). Only the VM and the network push are left out: the "VM" is a local
//! clone of the mirror that makes commits with plumbing, and a push is everything push()
//! does except the `git push` itself.
//!
//! Every result is one JSON line, printed as `POC {...}` and appended to $POC_OUT.

use super::*;
use serde_json::{json, Value};
use std::time::Instant;

const SANDBOX: &str = "slack_C1_1790000001.000100";
const LONG: Duration = Duration::from_secs(3600);

fn var(k: &str, d: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string())
}

fn emit(v: Value) {
    println!("POC {v}");
    if let Ok(p) = std::env::var("POC_OUT") {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).expect("POC_OUT");
        writeln!(f, "{v}").unwrap();
    }
}

fn sh_try(dir: &Path, script: &str) -> Result<String, String> {
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(script)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "bot")
        .env("GIT_AUTHOR_EMAIL", "1+bot@users.noreply.github.com")
        .env("GIT_COMMITTER_NAME", "bot")
        .env("GIT_COMMITTER_EMAIL", "1+bot@users.noreply.github.com")
        .output()
        .expect("sh");
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!("{script}: {}", String::from_utf8_lossy(&out.stderr)))
    }
}

fn sh(dir: &Path, script: &str) -> String {
    sh_try(dir, script).unwrap()
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

/// What a mirror holds: `git count-objects -v` (KiB fields as git prints them), bytes by
/// `du` (apparent and allocated), refs, loose object files, packs and cruft packs.
fn measure(dir: &Path) -> Value {
    let mut m = serde_json::Map::new();
    for line in sh(dir, "git count-objects -v").lines() {
        if let Some((k, v)) = line.split_once(": ") {
            m.insert(k.replace('-', "_"), json!(v.trim().parse::<u64>().unwrap_or(0)));
        }
    }
    let num = |s: String| json!(s.trim().parse::<u64>().unwrap_or(0));
    m.insert("apparent_bytes".into(), num(sh(dir, "du -sb . | cut -f1")));
    m.insert("allocated_bytes".into(), num(sh(dir, "du -s --block-size=1 . | cut -f1")));
    m.insert("refs".into(), num(sh(dir, "git for-each-ref | wc -l")));
    m.insert("stage_refs".into(), num(sh(dir, "git for-each-ref refs/stage/ | wc -l")));
    m.insert("cruft_packs".into(), num(sh(dir, "ls objects/pack/*.mtimes 2>/dev/null | wc -l")));
    m.insert("tmp_files".into(), num(sh(dir, "find objects -name 'tmp_*' -o -name '*.bundle' | wc -l")));
    Value::Object(m)
}

/// A small deterministic generator, so a run can be repeated.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    /// Verified, recorded, approved, pushed (push() minus the network step).
    Pushed,
    /// Verified and recorded, never approved: the record expires (24 h) and prune drops the ref.
    Abandoned,
    /// The bundle fails fsck (a tree entry named .git): 422.
    FsckRefused,
    /// The base branch isn't on GitHub: 404, after the bundle was fetched.
    BaseMissing,
    /// Verified, then cut off by the deadline before the record: ref left for prune.
    CutOff,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Pushed => "pushed",
            Kind::Abandoned => "abandoned",
            Kind::FsckRefused => "fsck_refused",
            Kind::BaseMissing => "base_missing",
            Kind::CutOff => "cut_off",
        }
    }
}

/// N stages: 80% pushed, then 5% each abandoned, fsck-refused, base-missing, cut off,
/// shuffled with the seed.
fn schedule(n: usize, rng: &mut Rng) -> Vec<Kind> {
    let fail = n / 20;
    let mut s: Vec<Kind> = Vec::new();
    for k in [Kind::Abandoned, Kind::FsckRefused, Kind::BaseMissing, Kind::CutOff] {
        s.extend(std::iter::repeat_n(k, fail));
    }
    s.extend(std::iter::repeat_n(Kind::Pushed, n - s.len()));
    for i in (1..s.len()).rev() {
        s.swap(i, rng.below(i as u64 + 1) as usize);
    }
    s
}

/// The stand-in for the VM's checkout: a clone of the mirror (so origin/* is GitHub's
/// branches as the mirror last saw them), with no working tree; commits are made with
/// plumbing, so even a large repo costs no checkout.
struct Vm {
    dir: PathBuf,
    base: String,
    candidates: Vec<String>,
}

impl Vm {
    /// `shared`: borrow the mirror's objects (cheap for a large repo); otherwise a copy, for
    /// when the mirror is being repacked underneath.
    fn new(root: &Path, mirror: &Path, base: &str, shared: bool) -> Vm {
        let dir = root.join("vm");
        let _ = std::fs::remove_dir_all(&dir);
        sh(root, &format!("git clone -q {} --no-checkout {} vm", if shared { "--shared" } else { "--no-local" }, mirror.display()));
        let listing = sh(&dir, &format!("git ls-tree -r -l origin/{base}"));
        let exts = [".md", ".rs", ".ts", ".tsx", ".js", ".py", ".go", ".txt", ".json", ".yml", ".yaml", ".html", ".css"];
        let candidates: Vec<String> = listing
            .lines()
            .filter_map(|l| {
                let (meta, path) = l.split_once('\t')?;
                let f: Vec<&str> = meta.split_whitespace().collect();
                let size: u64 = f.get(3)?.parse().ok()?;
                let plain = path.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b));
                (f[0] == "100644" && (200..=100_000).contains(&size) && plain && exts.iter().any(|e| path.ends_with(e))).then(|| path.to_string())
            })
            .collect();
        assert!(candidates.len() >= 10, "too few candidate files");
        Vm { dir, base: base.to_string(), candidates }
    }

    /// Catch up with the mirror (as the VM's fetch would catch up with GitHub).
    fn sync(&self) {
        // Retried: in the race test the mirror is being repacked underneath.
        for _ in 0..5 {
            if sh_try(&self.dir, "git fetch -q --prune origin").is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        sh(&self.dir, "git fetch -q --prune origin");
    }

    /// One commit on `parent` changing `files` existing files (a line inserted in the
    /// middle), plus, for `bad`, a root tree entry named .git (fsck's hasDotgit) and, for
    /// `artifact`, a new file of that many random bytes.
    fn commit(&self, parent: &str, rng: &mut Rng, files: usize, tag: &str, bad: bool, artifact: u64) -> String {
        let mut script = format!("set -e; export GIT_INDEX_FILE=\"$PWD/poc.idx\"; git read-tree {parent}; ");
        for f in 0..files {
            let path = &self.candidates[rng.below(self.candidates.len() as u64) as usize];
            let line = format!("poc {tag} file {f} {:016x}", rng.next());
            script.push_str(&format!(
                "git cat-file blob {parent}:{path} > poc.tmp; n=$(wc -l < poc.tmp); b=$(awk -v l='{line}' -v n=$n 'NR==int(n/2)+1{{print l}} {{print}}' poc.tmp | git hash-object -w --stdin); git update-index --cacheinfo 100644,$b,{path}; "
            ));
        }
        if artifact > 0 {
            script.push_str(&format!("b=$(head -c {artifact} /dev/urandom | git hash-object -w --stdin); git update-index --add --cacheinfo 100644,$b,dist/poc-{tag}.bin; "));
        }
        script.push_str("t=$(git write-tree); ");
        if bad {
            script.push_str("x=$(echo x | git hash-object -w --stdin); t=$( { git ls-tree $t; printf '100644 blob %s\\t.git\\n' $x; } | git mktree); ");
        }
        script.push_str(&format!("rm -f \"$GIT_INDEX_FILE\"; git commit-tree $t -p {parent} -m 'poc: {tag}'"));
        sh(&self.dir, &script)
    }

    /// The branch for stage `i`: 1-3 commits of 1-4 files on the base, HEAD pointed at it,
    /// and the bundle the VM would make (HEAD minus everything origin has).
    fn prepare(&self, i: usize, rng: &mut Rng, bad: bool, artifact: u64, bundle: &Path) -> (String, u64) {
        let mut head = sh(&self.dir, &format!("git rev-parse origin/{}", self.base));
        let commits = 1 + rng.below(3) as usize;
        for c in 0..commits {
            let files = 1 + rng.below(4) as usize;
            let last = c + 1 == commits;
            head = self.commit(&head, rng, files, &format!("s{i}c{c}"), bad && last, if last { artifact } else { 0 });
        }
        sh(&self.dir, &format!("git update-ref refs/heads/scout/poc-{i} {head} && git symbolic-ref HEAD refs/heads/scout/poc-{i}"));
        sh(&self.dir, &format!("git bundle create -q {} HEAD --not --remotes=origin", bundle.display()));
        let size = std::fs::metadata(bundle).map(|m| m.len()).unwrap_or(0);
        (head, size)
    }
}

/// The objects stages brought (each stage's commits minus origin), and how many of them,
/// and how many bytes on disk (packed or loose), are still in the mirror.
fn residue(vm: &Vm, mirror: &Path, heads: &[String]) -> Value {
    if heads.is_empty() {
        return json!({ "stages": 0 });
    }
    let list = vm.dir.join("poc-heads");
    std::fs::write(&list, heads.join("\n") + "\n").unwrap();
    let ids = vm.dir.join("poc-ids");
    sh(&vm.dir, &format!("git rev-list --objects --stdin --not --remotes=origin < {} | cut -d' ' -f1 > {}", list.display(), ids.display()));
    let brought: u64 = sh(&vm.dir, &format!("wc -l < {}", ids.display())).parse().unwrap_or(0);
    let check = sh(mirror, &format!("git cat-file --batch-check='%(objectname) %(objectsize:disk)' < {} | awk '$2==\"missing\"{{m++; next}} {{n++; b+=$2}} END{{print n+0, b+0, m+0}}'", ids.display()));
    let f: Vec<u64> = check.split_whitespace().map(|x| x.parse().unwrap_or(0)).collect();
    json!({ "stages": heads.len(), "objects_brought": brought, "objects_present": f[0], "disk_bytes_present": f[1], "objects_gone": f[2] })
}

/// Everything push() does after it has checked the record, except `git push`: consume the
/// record, drop the stage ref, prune, `gc --auto`.
async fn push_minus_network(p: &Publisher, dir: &Path, id: &str) {
    p.claim(id).expect("claim");
    let _ = git(dir, &["update-ref", "-d", &format!("refs/stage/{id}")], None, GIT_LOCAL).await;
    p.prune(dir).await;
    let _ = git(dir, &["gc", "--auto", "-q"], None, GIT_LOCAL).await;
}

/// One stage the way stage() runs it, with the bundle made locally: refresh, the bundle in
/// the mirror directory, verify and record (or the failure), remove the bundle, prune.
async fn one_stage(p: &Publisher, vm: &Vm, dir: &Path, owner: &str, name: &str, i: usize, kind: Kind, rng: &mut Rng, artifact: u64) -> (Value, String) {
    let t = Instant::now();
    if let Err(e) = p.refresh(dir, owner, name, None).await {
        // What stage() answers then: 502, nothing staged.
        return (json!({ "i": i, "kind": kind.name(), "status": 502, "error": e.chars().take(300).collect::<String>(), "refresh_ms": ms(t) }), String::new());
    }
    let refresh_ms = ms(t);
    vm.sync();
    let id = new_stage_id().unwrap();
    let bundle = dir.join(format!("stage-{id}.bundle"));
    let (head, bundle_bytes) = vm.prepare(i, rng, kind == Kind::FsckRefused, artifact, &bundle);
    let t = Instant::now();
    let base = if kind == Kind::BaseMissing { "poc-no-such-base".to_string() } else { vm.base.clone() };
    let req = StageRequest { owner: owner.into(), name: name.into(), base, branch: format!("scout/poc-{i}"), token: None };
    let result = match kind {
        Kind::CutOff => p.stage_bundle(dir, &bundle, &req.base, &id).await.map(|_| ()),
        _ => p.stage_and_record(dir, &bundle, SANDBOX, &req, &id).await.map(|_| ()),
    };
    let _ = std::fs::remove_file(&bundle);
    p.prune(dir).await;
    let verify_ms = ms(t);
    let t = Instant::now();
    if kind == Kind::Pushed && result.is_ok() {
        push_minus_network(p, dir, &id).await;
    }
    let push_ms = ms(t);
    let (status, error) = match &result {
        Ok(()) => (200, String::new()),
        Err((s, e)) => (*s, e.chars().take(300).collect()),
    };
    let packs: u64 = sh(dir, "ls objects/pack/*.pack 2>/dev/null | wc -l").parse().unwrap_or(0);
    let loose: u64 = sh(dir, "find objects -path 'objects/[0-9a-f][0-9a-f]/*' -type f | wc -l").parse().unwrap_or(0);
    (json!({ "i": i, "kind": kind.name(), "status": status, "error": error, "packs": packs, "loose": loose, "refresh_ms": refresh_ms, "verify_ms": verify_ms, "push_local_ms": push_ms, "bundle_bytes": bundle_bytes, "id": id }), head)
}

fn variant(dir: &Path, label: &str, args: &[&str]) -> (PathBuf, String, Vec<String>) {
    let copy = dir.with_extension(format!("{label}.git"));
    let _ = std::fs::remove_dir_all(&copy);
    sh(dir.parent().unwrap(), &format!("cp -a --reflink=always {} {}", dir.display(), copy.display()));
    (copy, label.to_string(), args.iter().map(|s| s.to_string()).collect())
}

/// The growth run: initial mirror, N stages, residue by kind, gc variants on reflink copies
/// of the end state, one large abandoned artifact, and a cold start.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn poc_mirror_growth() {
    let root = PathBuf::from(var("POC_ROOT", "/tmp/poc-mirrors"));
    let owner = var("POC_OWNER", "solcreek");
    let name = var("POC_NAME", "lorehouse");
    let base = var("POC_BASE", "main");
    let n: usize = var("POC_STAGES", "100").parse().unwrap();
    let mut rng = Rng(var("POC_SEED", "76").parse::<u64>().unwrap() * 0x9E37_79B9_7F4A_7C15 + 1);
    let repo = format!("{owner}/{name}");
    std::fs::create_dir_all(&root).unwrap();
    let p = Publisher::new(root.join("mirrors"), "https://github.com".into());
    let dir = p.mirror(&owner, &name);
    let _ = std::fs::remove_dir_all(&dir);

    // 1. Initial mirror.
    let t = Instant::now();
    let first = p.refresh(&dir, &owner, &name, None).await;
    let fetch_ms = ms(t);
    if let Err(e) = first {
        // refresh() gives a fetch GIT_NETWORK (600 s). Record what a timed-out first stage
        // leaves behind, then (POC_SEED_FETCH=1) seed the mirror with the very same fetch
        // without the deadline, so the rest can be measured.
        emit(json!({ "repo": repo, "step": "initial_failed", "ms": fetch_ms, "error": e, "m": measure(&dir) }));
        assert_eq!(var("POC_SEED_FETCH", "0"), "1", "initial fetch failed: {e}");
        sh(&root, &format!("rm -rf {}", dir.display()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "--bare"], None, GIT_LOCAL).await.unwrap();
        let t = Instant::now();
        git_capped(&dir, &["fetch", "-q", "--prune", "--no-tags", &p.url(&owner, &name), "+refs/heads/*:refs/heads/*"], None, LONG, OUTPUT_CAP).await.expect("seed fetch");
        emit(json!({ "repo": repo, "step": "seed_fetch", "ms": ms(t) }));
    }
    let heads: u64 = sh(&dir, "git for-each-ref refs/heads/ | wc -l").parse().unwrap();
    emit(json!({ "repo": repo, "step": "initial", "fetch_ms": fetch_ms, "branches": heads, "git": sh(&root, "git --version"), "m": measure(&dir) }));
    let t = Instant::now();
    p.refresh(&dir, &owner, &name, None).await.unwrap();
    emit(json!({ "repo": repo, "step": "noop_refresh", "ms": ms(t) }));

    // 2. N stages.
    let vm = Vm::new(&root, &dir, &base, true);
    let plan = schedule(n, &mut rng);
    let mut by_kind: HashMap<&'static str, Vec<String>> = HashMap::new();
    let mut abandoned = Vec::new();
    let before = measure(&dir);
    for (i, kind) in plan.iter().enumerate() {
        let (mut line, head) = one_stage(&p, &vm, &dir, &owner, &name, i, *kind, &mut rng, 0).await;
        if *kind == Kind::Abandoned {
            abandoned.push(line["id"].as_str().unwrap().to_string());
        }
        if !head.is_empty() {
            by_kind.entry(kind.name()).or_default().push(head);
        }
        line["repo"] = json!(repo);
        line["step"] = json!("stage");
        emit(line);
        if (i + 1) % 10 == 0 {
            emit(json!({ "repo": repo, "step": "after_stages", "n": i + 1, "m": measure(&dir) }));
        }
    }
    // The abandoned stages' records expire (24 h): prune drops them and their refs.
    for id in &abandoned {
        let _ = std::fs::remove_file(p.record_path(id));
    }
    p.prune(&dir).await;
    emit(json!({ "repo": repo, "step": "end", "before": before, "m": measure(&dir) }));

    // 3. Residue by kind.
    let mut all = Vec::new();
    for (k, heads) in &by_kind {
        emit(json!({ "repo": repo, "step": "residue", "kind": k, "r": residue(&vm, &dir, heads) }));
        all.extend(heads.iter().cloned());
    }
    emit(json!({ "repo": repo, "step": "residue", "kind": "all", "r": residue(&vm, &dir, &all) }));

    // 4. gc variants, each on a reflink copy of the same end state, with the guarded env.
    let variants = [
        variant(&dir, "gc-auto", &["gc", "--auto", "-q"]),
        variant(&dir, "maint-auto", &["maintenance", "run", "--auto", "--quiet"]),
        variant(&dir, "geometric", &["repack", "-d", "-q", "--geometric=2"]),
        variant(&dir, "gc-default", &["gc", "-q"]),
        variant(&dir, "gc-prune-now", &["gc", "-q", "--prune=now"]),
    ];
    for (copy, label, args) in variants {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        // Detached auto gc would return at once and run on: keep it in the foreground.
        sh(&copy, "git config gc.autoDetach false && git config maintenance.autoDetach false");
        let before = measure(&copy);
        let t = Instant::now();
        let r = git_capped(&copy, &args, None, LONG, OUTPUT_CAP).await;
        let took = ms(t);
        emit(json!({ "repo": repo, "step": "gc", "variant": label, "ok": r.is_ok(), "ms": took, "before": before, "after": measure(&copy), "residue_after": residue(&vm, &copy, &all) }));
        sh(dir.parent().unwrap(), &format!("rm -rf {}", copy.display()));
    }

    // One abandoned stage that commits a 20 MiB build artifact (incompressible).
    let before = measure(&dir);
    let (mut line, head) = one_stage(&p, &vm, &dir, &owner, &name, n, Kind::Abandoned, &mut rng, 20 << 20).await;
    let id = line["id"].as_str().unwrap().to_string();
    let _ = std::fs::remove_file(p.record_path(&id));
    p.prune(&dir).await;
    line["repo"] = json!(repo);
    line["step"] = json!("artifact_stage");
    line["before"] = before;
    line["after"] = measure(&dir);
    line["residue"] = residue(&vm, &dir, &[head]);
    emit(line);

    // 5. Cold start: the mirror is dropped (what retention costs), the next stage rebuilds it.
    let warm = Instant::now();
    let (warm_line, _) = one_stage(&p, &vm, &dir, &owner, &name, n + 1, Kind::Pushed, &mut rng, 0).await;
    let warm_ms = ms(warm);
    // The VM's clone borrows the mirror's objects: point it at a reflink copy first.
    let old = dir.with_extension("old.git");
    sh(&root, &format!("cp -a --reflink=always {d} {o} && rm -rf {d}", d = dir.display(), o = old.display()));
    std::fs::write(vm.dir.join(".git/objects/info/alternates"), format!("{}/objects\n", old.display())).unwrap();
    let cold = Instant::now();
    let (cold_line, _) = one_stage(&p, &vm, &dir, &owner, &name, n + 2, Kind::Pushed, &mut rng, 0).await;
    emit(json!({ "repo": repo, "step": "cold_start", "warm_total_ms": warm_ms, "warm": warm_line, "cold_total_ms": ms(cold), "cold": cold_line, "m": measure(&dir) }));
    sh(&root, &format!("rm -rf {}", old.display()));
}

/// Is gc safe while a stage runs? Stages of one repo back to back, with a gc of the same
/// mirror looping beside them from outside sandboxd's lock; then every stage ref is checked
/// for missing objects.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn poc_gc_race() {
    let root = PathBuf::from(var("POC_ROOT", "/tmp/poc-mirrors")).join("race");
    let owner = var("POC_OWNER", "solcreek");
    let name = var("POC_NAME", "lorehouse");
    let base = var("POC_BASE", "main");
    let n: usize = var("POC_RACE_STAGES", "60").parse().unwrap();
    let repo = format!("{owner}/{name}");
    // "none" is the control: it checks the checker.
    for (label, gc) in [("none", "sleep 0.05"), ("gc-prune-now", "git gc -q --prune=now"), ("gc-default", "git gc -q")] {
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let p = Publisher::new(root.join("mirrors"), "https://github.com".into());
        let dir = p.mirror(&owner, &name);
        p.refresh(&dir, &owner, &name, None).await.unwrap();
        let vm = Vm::new(&root, &dir, &base, false);
        let mut rng = Rng(0x7676_7676);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let looper = {
            let (stop, dir, gc) = (stop.clone(), dir.clone(), gc.to_string());
            std::thread::spawn(move || {
                let (mut runs, mut failed) = (0u64, 0u64);
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    runs += 1;
                    if sh_try(&dir, &gc).is_err() {
                        failed += 1;
                    }
                }
                (runs, failed)
            })
        };
        let mut statuses: HashMap<u16, u64> = HashMap::new();
        let mut errors: Vec<String> = Vec::new();
        let mut ids = Vec::new();
        for i in 0..n {
            // Abandoned: verify and record, keep the ref, so it can be checked afterwards.
            let (line, _) = one_stage(&p, &vm, &dir, &owner, &name, i, Kind::Abandoned, &mut rng, 0).await;
            *statuses.entry(line["status"].as_u64().unwrap() as u16).or_default() += 1;
            if let Some(e) = line.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
                errors.push(e.to_string());
            }
            if line["status"] == 200 {
                ids.push(line["id"].as_str().unwrap().to_string());
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let (gc_runs, gc_failed) = looper.join().unwrap();
        let mut broken = 0;
        let mut first_error = String::new();
        for id in &ids {
            // Every object of the staged commits must be readable: the diff, push, a later stage.
            let r = sh_try(&dir, &format!("git rev-list --objects refs/stage/{id} --not --branches | cut -d' ' -f1 | git cat-file --batch-check | grep missing; test $? = 1"));
            if let Err(e) = r {
                broken += 1;
                if first_error.is_empty() {
                    first_error = e.chars().take(300).collect();
                }
            }
        }
        let fsck = sh_try(&dir, "git fsck --connectivity-only --no-dangling 2>&1").is_ok();
        emit(json!({ "repo": repo, "step": "gc_race", "gc": label, "stages": n, "statuses": statuses, "gc_runs": gc_runs, "gc_failed": gc_failed, "stage_refs_broken": broken, "first_error": first_error, "errors": errors, "fsck_ok": fsck }));
    }
    let _ = std::fs::remove_dir_all(&root);
}
