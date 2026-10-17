//! Configuration, all from the environment, with every problem reported at once.

use crate::publish::{Policy, GIB};
use std::{env, path::PathBuf, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Transport {
    /// WebSocket first; long poll if the upgrade is refused.
    Auto,
    Ws,
    Poll,
}

/// How work reaches this host.
#[derive(Clone, Debug)]
pub enum Mode {
    /// Connect out to Lorehouse and ask for work (docs/sandbox-runners.md). No open port.
    Runner { app_url: String, token: String, name: String, transport: Transport },
    /// Serve the HTTP API for Lorehouse to call, e.g. on the same machine over loopback.
    Serve { listen: String, token: String },
}

#[derive(Clone, Debug)]
pub struct Config {
    pub mode: Mode,
    /// Per-sandbox directories: rootfs.ext4, vm.json, sockets, console.log.
    pub state_dir: PathBuf,
    /// Prepared rootfs (guestd baked in, see prepare-golden.sh); reflinked per sandbox.
    pub golden: PathBuf,
    pub kernel: PathBuf,
    /// The host's internet-facing interface; sandboxes are masqueraded out of it.
    pub uplink: String,
    pub max_vms: usize,
    pub idle: Duration,
    /// How long after its last request a VM with a running background job is kept from
    /// its idle stop (guestd says how many run; vm.rs `reap`). 0: a job doesn't hold it.
    pub job_hold: Duration,
    pub vcpus: u32,
    pub mem_mib: u32,
    /// Where repos are published to and mirrored from: https://github.com. Another base (a
    /// file:// directory) is for testing the publish path without GitHub.
    pub github_url: String,
    /// The publish mirrors' quotas and retention (publish/upkeep.rs).
    pub mirrors: Policy,
    /// How each VM is jailed (jail.rs).
    pub jail: JailConfig,
    /// Each VM's network and disk rates and its disk quota.
    pub limits: Limits,
    /// How often the nftables table is checked against what sandboxd loaded (net.rs).
    pub net_check: Duration,
}

/// Per VM. A rate of 0 means unlimited.
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    /// Into the guest (downloads): above what GitHub gave starship (4.5–22 MB/s, 2026-10-11),
    /// so a clone isn't slowed by it.
    pub net_rx_mibps: u64,
    /// Out of the guest: what abuse from a sandbox (a flood, a scan) can send.
    pub net_tx_mibps: u64,
    pub disk_mibps: u64,
    pub disk_iops: u64,
    pub disk_quota: DiskQuota,
}

/// SANDBOXD_DISK_QUOTA_GIB: unset is the default, enforced where the filesystem can and
/// skipped with a warning where it can't; set, it must be enforced or sandboxd won't start.
#[derive(Clone, Debug, PartialEq)]
pub enum DiskQuota {
    Off,
    Default(u64),
    Set(u64),
}

pub const DEFAULT_DISK_QUOTA_GIB: u64 = 8;

impl Default for Limits {
    fn default() -> Limits {
        Limits { net_rx_mibps: 50, net_tx_mibps: 10, disk_mibps: 200, disk_iops: 5000, disk_quota: DiskQuota::Default(DEFAULT_DISK_QUOTA_GIB) }
    }
}

/// The jail's settings. Every VM runs under the jailer; there is no setting to turn it off.
#[derive(Clone, Debug, PartialEq)]
pub struct JailConfig {
    /// The jailer: a path, or a name looked up on PATH.
    pub jailer: PathBuf,
    /// Firecracker, likewise; it must be the jailer's own release.
    pub firecracker: PathBuf,
    /// The VM in slot n runs as uid and gid `uid_base + n`. These ids must belong to no
    /// user or group; sandboxd checks at start.
    pub uid_base: u32,
    /// Publishing's git runs as one of `git_uid_base .. + gitjail::GIT_UIDS`, a uid of its
    /// own per run (gitjail.rs). These must belong to no user or group either, and not be
    /// a VM's.
    pub git_uid_base: u32,
    /// Each run of publishing's git may use this much memory (its cgroup's memory.max, no
    /// swap); past it the run alone is killed.
    pub git_mem_mib: u32,
    /// A VM's cgroup memory limit is its guest RAM plus this.
    pub mem_headroom_mib: u32,
}

/// Above every regular and system user (and systemd's dynamic users), and below the
/// ids some tools read as signed: 1_900_000_000 + 63 is still under 2^31.
pub const DEFAULT_JAIL_UID_BASE: u64 = 1_900_000_000;
/// Past the VMs' default range (64 at most), for the same reasons.
pub const DEFAULT_GIT_UID_BASE: u64 = 1_900_100_000;
/// A run of publishing's git: a diff or a pack of a bundle (at most 96 MiB) and a gc of a
/// mirror (at most SANDBOXD_MIRROR_MAX_GIB, 4 GiB by default) fit in this.
pub const DEFAULT_GIT_MEM_MIB: u64 = 2048;

/// Seconds between checks of the nftables table: how long a flushed table can leave
/// running guests unfiltered. A check is one `nft list table`.
pub const DEFAULT_NET_CHECK_SECS: u64 = 10;

/// A running job holds its VM up for this long after the last request: the longest a job
/// may run (guestd's limit, 6 h), so a job whose caller stopped polling still finishes.
pub const DEFAULT_JOB_HOLD_SECS: u64 = 6 * 3600;

/// Where sandboxes live unless SANDBOXD_STATE says otherwise; sandboxd.service's
/// StateDirectory= creates this directory and makes it writable.
pub const DEFAULT_STATE: &str = "/var/lib/lorehouse-sandboxes";

fn var(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
}

/// The systemd credentials (`LoadCredential=<name>:<file>`) sandboxd reads its tokens
/// from, in `$CREDENTIALS_DIRECTORY`. Preferred over the environment variables: a
/// credential is a file only the service can read, never part of any process's environment.
pub const RUNNER_TOKEN_CREDENTIAL: &str = "runner-token";
pub const API_TOKEN_CREDENTIAL: &str = "api-token";

/// A credential's contents (trailing newline trimmed), if systemd passed it. Unset or
/// absent: None; there but unreadable or empty: an error.
fn credential(name: &str) -> Result<Option<String>, String> {
    let Some(dir) = env::var_os("CREDENTIALS_DIRECTORY").filter(|d| !d.is_empty()) else { return Ok(None) };
    let path = PathBuf::from(dir).join(name);
    match std::fs::read_to_string(&path) {
        Ok(v) => {
            let v = v.trim_end_matches(['\n', '\r']).to_string();
            if v.is_empty() {
                Err(format!("credential {name} ({}) is empty", path.display()))
            } else if v.chars().any(|c| c.is_whitespace() || c.is_control()) {
                // A token never has them; one that does would only fail later, at the app.
                Err(format!("credential {name} ({}) holds whitespace or control characters: one line, the token alone", path.display()))
            } else {
                Ok(Some(v))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("credential {name} ({}): {e}", path.display())),
    }
}

/// A token, from its credential first, else its environment variable (deprecated), and
/// the warning to log about where it came from.
fn token(credential: Option<String>, env: Option<String>, name: &str, key: &str) -> (Option<String>, Option<String>) {
    match (credential, env) {
        (Some(c), Some(_)) => (Some(c), Some(format!("{key} is set too, and ignored: the {name} credential is used. Remove {key} from the environment file"))),
        (Some(c), None) => (Some(c), None),
        (None, Some(e)) => (
            Some(e),
            Some(format!(
                "{key} from the environment is deprecated: anything that reads sandboxd's environment (/proc/<pid>/environ, a child that inherits it) gets it. Put it in a file (root, 0600) and pass it as a systemd credential, LoadCredential={name}:<file> (README.md, \"Tokens\")"
            )),
        ),
        (None, None) => (None, None),
    }
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let mut problems = Vec::new();
        let mut need = |key: &str| -> String {
            var(key).unwrap_or_else(|| {
                problems.push(format!("{key} is required"));
                String::new()
            })
        };
        let golden = need("SANDBOXD_GOLDEN");
        let kernel = need("SANDBOXD_KERNEL");
        let uplink = need("SANDBOXD_UPLINK");

        // A token from its credential, else its variable; a warning for the log about which.
        let mut secret = |name: &str, key: &str| -> String {
            let cred = credential(name).unwrap_or_else(|e| {
                problems.push(e);
                None
            });
            let (value, warning) = token(cred, var(key), name, key);
            if let Some(w) = warning {
                eprintln!("sandboxd: WARNING: {w}");
            }
            value.unwrap_or_default()
        };
        let mode = if let Some(app_url) = var("SANDBOXD_APP_URL") {
            let token = secret(RUNNER_TOKEN_CREDENTIAL, "SANDBOXD_RUNNER_TOKEN");
            if token.len() < 32 {
                problems.push(format!("the runner token is required with SANDBOXD_APP_URL (32+ characters, the app's SANDBOX_RUNNER_TOKEN): the {RUNNER_TOKEN_CREDENTIAL} credential, or SANDBOXD_RUNNER_TOKEN"));
            }
            // The runner token travels with every request, and whoever holds it can take
            // this host's jobs, so plain HTTP is refused unless explicitly allowed (a
            // loopback or an already-encrypted link, e.g. a WireGuard tailnet, in development).
            let insecure_ok = var("SANDBOXD_ALLOW_INSECURE_HTTP").as_deref() == Some("1");
            if app_url.starts_with("http://") && !insecure_ok {
                problems.push(format!("SANDBOXD_APP_URL must be https:// (it carries the runner token), got {app_url:?}; set SANDBOXD_ALLOW_INSECURE_HTTP=1 only for loopback or an encrypted private link"));
            } else if !(app_url.starts_with("https://") || app_url.starts_with("http://")) {
                problems.push(format!("SANDBOXD_APP_URL must be https://…, got {app_url:?}"));
            }
            let name = var("SANDBOXD_RUNNER_NAME").or_else(|| var("HOSTNAME")).unwrap_or_else(|| "sandboxd".into());
            if name.is_empty() || name.len() > 64 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) {
                problems.push(format!("SANDBOXD_RUNNER_NAME must be 1–64 of [A-Za-z0-9_.-], got {name:?}"));
            }
            let transport = match var("SANDBOXD_TRANSPORT").as_deref() {
                None | Some("auto") => Transport::Auto,
                Some("ws") => Transport::Ws,
                Some("poll") => Transport::Poll,
                Some(other) => {
                    problems.push(format!("SANDBOXD_TRANSPORT must be auto, ws or poll, got {other:?}"));
                    Transport::Auto
                }
            };
            Mode::Runner { app_url: app_url.trim_end_matches('/').to_string(), token, name, transport }
        } else {
            let token = secret(API_TOKEN_CREDENTIAL, "SANDBOXD_TOKEN");
            if token.len() < 32 {
                problems.push(format!("a token is required to serve the API (32+ characters): the {API_TOKEN_CREDENTIAL} credential, or SANDBOXD_TOKEN; or set SANDBOXD_APP_URL to connect out"));
            }
            Mode::Serve { listen: var("SANDBOXD_LISTEN").unwrap_or_else(|| "127.0.0.1:8787".into()), token }
        };

        let mut num = |key: &str, default: u64| -> u64 {
            match var(key) {
                None => default,
                Some(v) => v.parse().unwrap_or_else(|_| {
                    problems.push(format!("{key} must be a number, got {v:?}"));
                    default
                }),
            }
        };
        let (max_vms, idle, vcpus, mem) = (num("SANDBOXD_MAX_VMS", 4), num("SANDBOXD_IDLE_SECS", 900), num("SANDBOXD_VCPUS", 2), num("SANDBOXD_MEM_MIB", 2048));
        let job_hold = num("SANDBOXD_JOB_HOLD_SECS", DEFAULT_JOB_HOLD_SECS);
        // The mirrors' quotas and retention: issue #76's measured proposal by default.
        let d = Policy::default();
        let mirror_max = num("SANDBOXD_MIRROR_MAX_GIB", d.mirror_max / GIB);
        let mirrors_max = num("SANDBOXD_MIRRORS_MAX_GIB", d.mirrors_max / GIB);
        let free_pct = num("SANDBOXD_MIRRORS_FREE_PCT", d.free_min_pct);
        let free_gib = num("SANDBOXD_MIRRORS_FREE_GIB", d.free_min / GIB);
        let retention_days = num("SANDBOXD_MIRROR_RETENTION_DAYS", d.retention.as_secs() / 86_400);
        let uid_base = num("SANDBOXD_JAIL_UID_BASE", DEFAULT_JAIL_UID_BASE);
        let git_uid_base = num("SANDBOXD_GIT_UID_BASE", DEFAULT_GIT_UID_BASE);
        let git_mem = num("SANDBOXD_GIT_MEM_MIB", DEFAULT_GIT_MEM_MIB);
        let check_secs = num("SANDBOXD_GIT_CHECK_SECS", crate::publish::DEFAULT_CHECK_SECS);
        let mirror_entries = num("SANDBOXD_MIRROR_MAX_ENTRIES", d.mirror_entries);
        let headroom = num("SANDBOXD_VM_MEM_HEADROOM_MIB", 512);
        let net_check = num("SANDBOXD_NET_CHECK_SECS", DEFAULT_NET_CHECK_SECS);
        let dl = Limits::default();
        let rates = [
            ("SANDBOXD_NET_RX_MIBPS", num("SANDBOXD_NET_RX_MIBPS", dl.net_rx_mibps)),
            ("SANDBOXD_NET_TX_MIBPS", num("SANDBOXD_NET_TX_MIBPS", dl.net_tx_mibps)),
            ("SANDBOXD_DISK_MIBPS", num("SANDBOXD_DISK_MIBPS", dl.disk_mibps)),
            ("SANDBOXD_DISK_IOPS", num("SANDBOXD_DISK_IOPS", dl.disk_iops)),
        ];
        let quota_gib = var("SANDBOXD_DISK_QUOTA_GIB").map(|_| num("SANDBOXD_DISK_QUOTA_GIB", DEFAULT_DISK_QUOTA_GIB));
        // Checked before the casts below, so an out-of-range value fails here instead of
        // wrapping (4294967297 as u32 is 1).
        if !(1..=32).contains(&vcpus) {
            problems.push("SANDBOXD_VCPUS must be 1..=32 (Firecracker's limit)".into());
        }
        if !(128..=262_144).contains(&mem) {
            problems.push("SANDBOXD_MEM_MIB must be 128..=262144".into());
        }
        if !(1..=64).contains(&max_vms) {
            problems.push("SANDBOXD_MAX_VMS must be 1..=64 (one /30 per VM in 172.30.0.0/24)".into());
        }
        if !(1..=1024).contains(&mirror_max) {
            problems.push("SANDBOXD_MIRROR_MAX_GIB must be 1..=1024".into());
        }
        if !(mirror_max..=65_536).contains(&mirrors_max) {
            problems.push("SANDBOXD_MIRRORS_MAX_GIB must be at least SANDBOXD_MIRROR_MAX_GIB, and at most 65536".into());
        }
        if free_pct > 90 {
            problems.push("SANDBOXD_MIRRORS_FREE_PCT must be 0..=90".into());
        }
        if free_gib > 65_536 {
            problems.push("SANDBOXD_MIRRORS_FREE_GIB must be 0..=65536".into());
        }
        if !(1..=365).contains(&retention_days) {
            problems.push("SANDBOXD_MIRROR_RETENTION_DAYS must be 1..=365".into());
        }
        let mirrors = Policy { mirror_max: mirror_max * GIB, mirrors_max: mirrors_max * GIB, free_min_pct: free_pct, free_min: free_gib * GIB, retention: Duration::from_secs(retention_days * 86_400), check_deadline: Duration::from_secs(check_secs), mirror_entries, ..d };
        if !(65_536..=2_000_000_000).contains(&uid_base) {
            problems.push("SANDBOXD_JAIL_UID_BASE must be 65536..=2000000000 (above every real user, below 2^31 with room for 64 VMs)".into());
        }
        if !(10_000..=100_000_000).contains(&mirror_entries) {
            problems.push("SANDBOXD_MIRROR_MAX_ENTRIES must be 10000..=100000000".into());
        }
        if !(10..=3600).contains(&check_secs) {
            problems.push("SANDBOXD_GIT_CHECK_SECS must be 10..=3600".into());
        }
        if !(256..=65_536).contains(&git_mem) {
            problems.push("SANDBOXD_GIT_MEM_MIB must be 256..=65536".into());
        }
        let git_uids = crate::gitjail::GIT_UIDS as u64;
        if !(65_536..=2_000_000_000).contains(&git_uid_base) {
            problems.push(format!("SANDBOXD_GIT_UID_BASE must be 65536..=2000000000 (above every real user, below 2^31 with room for {git_uids} runs of git)"));
        } else if git_uid_base < uid_base + max_vms && uid_base < git_uid_base + git_uids {
            problems.push(format!("SANDBOXD_GIT_UID_BASE: git's {git_uids} uids from {git_uid_base} overlap the VMs' (SANDBOXD_JAIL_UID_BASE {uid_base}, {max_vms} VMs)"));
        }
        if !(64..=65_536).contains(&headroom) {
            problems.push("SANDBOXD_VM_MEM_HEADROOM_MIB must be 64..=65536".into());
        }
        for (key, value) in rates {
            if value > 100_000 {
                problems.push(format!("{key} must be 0 (unlimited)..=100000"));
            }
        }
        if job_hold > 7 * 86_400 {
            problems.push("SANDBOXD_JOB_HOLD_SECS must be 0 (jobs don't hold a VM)..=604800 (a week)".into());
        }
        if !(1..=3600).contains(&net_check) {
            problems.push("SANDBOXD_NET_CHECK_SECS must be 1..=3600".into());
        }
        if quota_gib.is_some_and(|g| g > 65_536) {
            problems.push("SANDBOXD_DISK_QUOTA_GIB must be 0 (off)..=65536".into());
        }
        let limits = Limits {
            net_rx_mibps: rates[0].1,
            net_tx_mibps: rates[1].1,
            disk_mibps: rates[2].1,
            disk_iops: rates[3].1,
            disk_quota: match quota_gib {
                None => DiskQuota::Default(DEFAULT_DISK_QUOTA_GIB),
                Some(0) => DiskQuota::Off,
                Some(g) => DiskQuota::Set(g),
            },
        };
        let jail = JailConfig {
            jailer: var("SANDBOXD_JAILER").unwrap_or_else(|| "jailer".into()).into(),
            firecracker: var("SANDBOXD_FIRECRACKER").unwrap_or_else(|| "firecracker".into()).into(),
            uid_base: uid_base as u32,
            git_uid_base: git_uid_base as u32,
            git_mem_mib: git_mem as u32,
            mem_headroom_mib: headroom as u32,
        };
        if !problems.is_empty() {
            return Err(format!("sandboxd: invalid configuration:\n  {}", problems.join("\n  ")));
        }
        Ok(Config {
            mode,
            state_dir: var("SANDBOXD_STATE").map(PathBuf::from).unwrap_or_else(|| DEFAULT_STATE.into()),
            golden: golden.into(),
            kernel: kernel.into(),
            uplink,
            max_vms: max_vms as usize,
            idle: Duration::from_secs(idle),
            job_hold: Duration::from_secs(job_hold),
            vcpus: vcpus as u32,
            mem_mib: mem as u32,
            github_url: var("SANDBOXD_GITHUB_URL").unwrap_or_else(|| "https://github.com".into()),
            mirrors,
            jail,
            limits,
            net_check: Duration::from_secs(net_check),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn a_credential_comes_before_its_variable() {
        let t = |c: Option<&str>, e: Option<&str>| super::token(c.map(String::from), e.map(String::from), "runner-token", "SANDBOXD_RUNNER_TOKEN");
        let (v, w) = t(Some("cred"), None);
        assert_eq!((v.as_deref(), w), (Some("cred"), None));
        // Both: the credential, and a warning that the variable is ignored.
        let (v, w) = t(Some("cred"), Some("env"));
        assert_eq!(v.as_deref(), Some("cred"));
        assert!(w.unwrap().contains("ignored"));
        // The variable alone still works, loudly.
        let (v, w) = t(None, Some("env"));
        assert_eq!(v.as_deref(), Some("env"));
        assert!(w.unwrap().contains("deprecated"));
        assert_eq!(t(None, None), (None, None));
    }

    // Env is process-wide, so one test sets and checks every case in order.
    #[test]
    fn resource_limits_are_checked_before_they_are_narrowed() {
        let token = "t".repeat(32);
        for (k, v) in [("SANDBOXD_TOKEN", token.as_str()), ("SANDBOXD_GOLDEN", "/g"), ("SANDBOXD_KERNEL", "/k"), ("SANDBOXD_UPLINK", "eth0")] {
            std::env::set_var(k, v);
        }
        let ok = Config::from_env().expect("defaults are valid");
        assert_eq!((ok.vcpus, ok.mem_mib), (2, 2048));
        std::env::set_var("SANDBOXD_VCPUS", "4294967297"); // would wrap to 1 as u32
        assert!(Config::from_env().unwrap_err().contains("SANDBOXD_VCPUS"));
        std::env::set_var("SANDBOXD_VCPUS", "2");
        std::env::set_var("SANDBOXD_MEM_MIB", "4294969344"); // would wrap to 2048
        assert!(Config::from_env().unwrap_err().contains("SANDBOXD_MEM_MIB"));
        std::env::remove_var("SANDBOXD_MEM_MIB");

        // Runner mode: the token only travels over HTTPS, unless plain HTTP is opted into.
        std::env::set_var("SANDBOXD_RUNNER_TOKEN", &token);
        std::env::set_var("SANDBOXD_RUNNER_NAME", "r1");
        std::env::set_var("SANDBOXD_APP_URL", "https://lorehouse.example.com/");
        assert!(matches!(Config::from_env().expect("https is fine").mode, super::Mode::Runner { .. }));
        // The token from a systemd credential, ahead of the variable.
        let creds = std::env::temp_dir().join(format!("sandboxd-creds-{}", std::process::id()));
        std::fs::create_dir_all(&creds).unwrap();
        let from_file = "c".repeat(40);
        std::fs::write(creds.join("runner-token"), format!("{from_file}\n")).unwrap();
        std::env::set_var("CREDENTIALS_DIRECTORY", &creds);
        match Config::from_env().expect("a credential is fine").mode {
            super::Mode::Runner { token, .. } => assert_eq!(token, from_file, "the credential wins, newline trimmed"),
            other => panic!("{other:?}"),
        }
        std::env::remove_var("SANDBOXD_RUNNER_TOKEN");
        assert!(Config::from_env().is_ok(), "the credential alone is enough");
        std::fs::write(creds.join("runner-token"), "\n").unwrap();
        assert!(Config::from_env().unwrap_err().contains("is empty"));
        for bad in [format!("{from_file} \n"), format!("{from_file}\nsecond line\n"), format!("{from_file}\t")] {
            std::fs::write(creds.join("runner-token"), bad).unwrap();
            assert!(Config::from_env().unwrap_err().contains("whitespace or control"));
        }
        std::fs::remove_file(creds.join("runner-token")).unwrap();
        assert!(Config::from_env().unwrap_err().contains("runner token is required"), "neither");
        std::env::set_var("SANDBOXD_RUNNER_TOKEN", &token);
        match Config::from_env().expect("the variable still works").mode {
            super::Mode::Runner { token: t, .. } => assert_eq!(t, token),
            other => panic!("{other:?}"),
        }
        std::env::remove_var("CREDENTIALS_DIRECTORY");
        std::fs::remove_dir_all(&creds).unwrap();

        std::env::set_var("SANDBOXD_APP_URL", "http://10.0.0.5:3000");
        assert!(Config::from_env().unwrap_err().contains("must be https://"));
        std::env::set_var("SANDBOXD_ALLOW_INSECURE_HTTP", "1");
        assert!(Config::from_env().is_ok());
        std::env::set_var("SANDBOXD_ALLOW_INSECURE_HTTP", "yes"); // only "1" opts in
        assert!(Config::from_env().is_err());
        for k in ["SANDBOXD_APP_URL", "SANDBOXD_ALLOW_INSECURE_HTTP", "SANDBOXD_RUNNER_TOKEN", "SANDBOXD_RUNNER_NAME"] {
            std::env::remove_var(k);
        }

        // The mirrors' quotas and retention: the measured proposal by default, else as set.
        use crate::publish::{Policy, GIB};
        assert_eq!(ok.mirrors, Policy::default());
        assert_eq!((ok.mirrors.mirror_max, ok.mirrors.mirrors_max, ok.mirrors.free_min_pct, ok.mirrors.free_min, ok.mirrors.retention.as_secs()), (4 * GIB, 24 * GIB, 10, 20 * GIB, 14 * 86_400));
        for (k, v) in [("SANDBOXD_MIRROR_MAX_GIB", "8"), ("SANDBOXD_MIRRORS_MAX_GIB", "100"), ("SANDBOXD_MIRRORS_FREE_PCT", "5"), ("SANDBOXD_MIRRORS_FREE_GIB", "50"), ("SANDBOXD_MIRROR_RETENTION_DAYS", "30")] {
            std::env::set_var(k, v);
        }
        let set = Config::from_env().unwrap().mirrors;
        assert_eq!((set.mirror_max, set.mirrors_max, set.free_min_pct, set.free_min, set.retention.as_secs()), (8 * GIB, 100 * GIB, 5, 50 * GIB, 30 * 86_400));
        for (k, v) in [("SANDBOXD_MIRRORS_MAX_GIB", "4"), ("SANDBOXD_MIRROR_MAX_GIB", "0"), ("SANDBOXD_MIRRORS_FREE_PCT", "95"), ("SANDBOXD_MIRROR_RETENTION_DAYS", "0"), ("SANDBOXD_MIRROR_MAX_GIB", "x")] {
            let before = std::env::var(k).ok();
            std::env::set_var(k, v);
            assert!(Config::from_env().unwrap_err().contains(k), "{k}={v}");
            match before {
                Some(b) => std::env::set_var(k, b),
                None => std::env::remove_var(k),
            }
        }
        for k in ["SANDBOXD_MIRROR_MAX_GIB", "SANDBOXD_MIRRORS_MAX_GIB", "SANDBOXD_MIRRORS_FREE_PCT", "SANDBOXD_MIRRORS_FREE_GIB", "SANDBOXD_MIRROR_RETENTION_DAYS"] {
            std::env::remove_var(k);
        }

        // The jail: always on, its binaries from PATH, uids far above real users.
        let jail = Config::from_env().unwrap().jail;
        assert_eq!(jail, super::JailConfig { jailer: "jailer".into(), firecracker: "firecracker".into(), uid_base: 1_900_000_000, git_uid_base: 1_900_100_000, git_mem_mib: 2048, mem_headroom_mib: 512 });
        std::env::set_var("SANDBOXD_JAILER", "/opt/fc/jailer");
        std::env::set_var("SANDBOXD_JAIL_UID_BASE", "3000000");
        let set = Config::from_env().unwrap().jail;
        assert_eq!((set.jailer.to_str(), set.uid_base), (Some("/opt/fc/jailer"), 3_000_000));
        // Publishing's git: a range of its own, never the VMs' (3000000 + 4 VMs here).
        for v in ["1000", "4294967200", "3000000", "2999990"] {
            std::env::set_var("SANDBOXD_GIT_UID_BASE", v);
            assert!(Config::from_env().unwrap_err().contains("SANDBOXD_GIT_UID_BASE"), "{v}");
        }
        std::env::set_var("SANDBOXD_GIT_UID_BASE", "3000004");
        assert_eq!(Config::from_env().unwrap().jail.git_uid_base, 3_000_004);
        std::env::remove_var("SANDBOXD_GIT_UID_BASE");
        // git's memory: 2 GiB a run by default, a setting within bounds.
        std::env::set_var("SANDBOXD_GIT_MEM_MIB", "4096");
        assert_eq!(Config::from_env().unwrap().jail.git_mem_mib, 4096);
        for v in ["0", "255", "65537", "x"] {
            std::env::set_var("SANDBOXD_GIT_MEM_MIB", v);
            assert!(Config::from_env().unwrap_err().contains("SANDBOXD_GIT_MEM_MIB"), "{v}");
        }
        std::env::remove_var("SANDBOXD_GIT_MEM_MIB");
        // A push's ancestry check: 300 s by default.
        assert_eq!(Config::from_env().unwrap().mirrors.check_deadline, std::time::Duration::from_secs(300));
        std::env::set_var("SANDBOXD_GIT_CHECK_SECS", "900");
        assert_eq!(Config::from_env().unwrap().mirrors.check_deadline, std::time::Duration::from_secs(900));
        for v in ["0", "9", "3601", "x"] {
            std::env::set_var("SANDBOXD_GIT_CHECK_SECS", v);
            assert!(Config::from_env().unwrap_err().contains("SANDBOXD_GIT_CHECK_SECS"), "{v}");
        }
        std::env::remove_var("SANDBOXD_GIT_CHECK_SECS");
        // How far a walk of a mirror may go: a million entries by default.
        assert_eq!(Config::from_env().unwrap().mirrors.mirror_entries, 1_000_000);
        for v in ["9999", "100000001", "x"] {
            std::env::set_var("SANDBOXD_MIRROR_MAX_ENTRIES", v);
            assert!(Config::from_env().unwrap_err().contains("SANDBOXD_MIRROR_MAX_ENTRIES"), "{v}");
        }
        std::env::remove_var("SANDBOXD_MIRROR_MAX_ENTRIES");
        for (k, v) in [("SANDBOXD_JAIL_UID_BASE", "1000"), ("SANDBOXD_JAIL_UID_BASE", "4294967200"), ("SANDBOXD_VM_MEM_HEADROOM_MIB", "0")] {
            std::env::set_var(k, v);
            assert!(Config::from_env().unwrap_err().contains(k), "{k}={v}");
            std::env::remove_var(k);
        }
        // No value turns it off: "off" is just a jailer binary that jail::prepare won't find.
        std::env::set_var("SANDBOXD_JAILER", "off");
        assert_eq!(Config::from_env().unwrap().jail.jailer.to_str(), Some("off"));
        std::env::remove_var("SANDBOXD_JAILER");

        // The table check: every 10 s by default.
        assert_eq!(Config::from_env().unwrap().net_check, std::time::Duration::from_secs(10));
        std::env::set_var("SANDBOXD_NET_CHECK_SECS", "60");
        assert_eq!(Config::from_env().unwrap().net_check, std::time::Duration::from_secs(60));
        for v in ["0", "3601", "x"] {
            std::env::set_var("SANDBOXD_NET_CHECK_SECS", v);
            assert!(Config::from_env().unwrap_err().contains("SANDBOXD_NET_CHECK_SECS"), "{v}");
        }
        std::env::remove_var("SANDBOXD_NET_CHECK_SECS");

        // A running job holds its VM up for 6 h after the last request by default; 0: never.
        assert_eq!(Config::from_env().unwrap().job_hold, std::time::Duration::from_secs(6 * 3600));
        std::env::set_var("SANDBOXD_JOB_HOLD_SECS", "0");
        assert!(Config::from_env().unwrap().job_hold.is_zero());
        for v in ["604801", "x"] {
            std::env::set_var("SANDBOXD_JOB_HOLD_SECS", v);
            assert!(Config::from_env().unwrap_err().contains("SANDBOXD_JOB_HOLD_SECS"), "{v}");
        }
        std::env::remove_var("SANDBOXD_JOB_HOLD_SECS");

        // Rates and the disk quota: on by default, 0 turns each off, a set quota is explicit.
        use super::{DiskQuota, Limits};
        let limits = Config::from_env().unwrap().limits;
        assert_eq!(limits, Limits { net_rx_mibps: 50, net_tx_mibps: 10, disk_mibps: 200, disk_iops: 5000, disk_quota: DiskQuota::Default(8) });
        for (v, want) in [("0", DiskQuota::Off), ("8", DiskQuota::Set(8)), ("2", DiskQuota::Set(2))] {
            std::env::set_var("SANDBOXD_DISK_QUOTA_GIB", v);
            assert_eq!(Config::from_env().unwrap().limits.disk_quota, want, "{v}");
        }
        std::env::set_var("SANDBOXD_NET_TX_MIBPS", "0");
        assert_eq!(Config::from_env().unwrap().limits.net_tx_mibps, 0);
        for (k, v) in [("SANDBOXD_DISK_QUOTA_GIB", "70000"), ("SANDBOXD_NET_TX_MIBPS", "200000"), ("SANDBOXD_DISK_IOPS", "lots")] {
            std::env::set_var(k, v);
            assert!(Config::from_env().unwrap_err().contains(k), "{k}={v}");
            std::env::remove_var(k);
        }
    }
}
