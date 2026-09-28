//! Configuration, all from the environment, with every problem reported at once.

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
    pub vcpus: u32,
    pub mem_mib: u32,
}

fn var(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
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

        let mode = if let Some(app_url) = var("SANDBOXD_APP_URL") {
            let token = var("SANDBOXD_RUNNER_TOKEN").unwrap_or_default();
            if token.len() < 32 {
                problems.push("SANDBOXD_RUNNER_TOKEN is required with SANDBOXD_APP_URL (32+ characters, the app's SANDBOX_RUNNER_TOKEN)".into());
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
            let token = var("SANDBOXD_TOKEN").unwrap_or_default();
            if token.len() < 32 {
                problems.push("SANDBOXD_TOKEN is required to serve the API (32+ characters); or set SANDBOXD_APP_URL to connect out".into());
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
        if !problems.is_empty() {
            return Err(format!("sandboxd: invalid configuration:\n  {}", problems.join("\n  ")));
        }
        Ok(Config {
            mode,
            state_dir: var("SANDBOXD_STATE").map(PathBuf::from).unwrap_or_else(|| "/var/lib/lorehouse-sandboxes".into()),
            golden: golden.into(),
            kernel: kernel.into(),
            uplink,
            max_vms: max_vms as usize,
            idle: Duration::from_secs(idle),
            vcpus: vcpus as u32,
            mem_mib: mem as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

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
        std::env::set_var("SANDBOXD_APP_URL", "http://10.0.0.5:3000");
        assert!(Config::from_env().unwrap_err().contains("must be https://"));
        std::env::set_var("SANDBOXD_ALLOW_INSECURE_HTTP", "1");
        assert!(Config::from_env().is_ok());
        std::env::set_var("SANDBOXD_ALLOW_INSECURE_HTTP", "yes"); // only "1" opts in
        assert!(Config::from_env().is_err());
        for k in ["SANDBOXD_APP_URL", "SANDBOXD_ALLOW_INSECURE_HTTP", "SANDBOXD_RUNNER_TOKEN", "SANDBOXD_RUNNER_NAME"] {
            std::env::remove_var(k);
        }
    }
}
