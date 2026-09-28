//! Configuration, all from the environment, with every problem reported at once.

use std::{env, path::PathBuf, time::Duration};

#[derive(Clone, Debug)]
pub struct Config {
    /// Where the HTTP API listens. Keep it on loopback and publish it through a tunnel.
    pub listen: String,
    /// Bearer token every /v1 request must carry.
    pub token: String,
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

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let mut missing = Vec::new();
        let mut need = |key: &str| -> String {
            env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| {
                missing.push(key.to_string());
                String::new()
            })
        };
        let token = need("SANDBOXD_TOKEN");
        let golden = need("SANDBOXD_GOLDEN");
        let kernel = need("SANDBOXD_KERNEL");
        let uplink = need("SANDBOXD_UPLINK");
        let num = |key: &str, default: u64| -> Result<u64, String> {
            match env::var(key) {
                Ok(v) if !v.is_empty() => v.parse().map_err(|_| format!("{key} must be a number, got {v:?}")),
                _ => Ok(default),
            }
        };
        let (max_vms, idle, vcpus, mem) = (
            num("SANDBOXD_MAX_VMS", 4)?,
            num("SANDBOXD_IDLE_SECS", 900)?,
            num("SANDBOXD_VCPUS", 2)?,
            num("SANDBOXD_MEM_MIB", 2048)?,
        );
        if !missing.is_empty() {
            return Err(format!("sandboxd: missing configuration: {}", missing.join(", ")));
        }
        // Checked before the casts below, so an out-of-range value fails here instead of
        // wrapping (4294967297 as u32 is 1).
        if !(1..=32).contains(&vcpus) {
            return Err("SANDBOXD_VCPUS must be 1..=32 (Firecracker's limit)".into());
        }
        if !(128..=262_144).contains(&mem) {
            return Err("SANDBOXD_MEM_MIB must be 128..=262144".into());
        }
        if !(1..=64).contains(&max_vms) {
            return Err("SANDBOXD_MAX_VMS must be 1..=64 (one /30 per VM in 172.30.0.0/24)".into());
        }
        if token.len() < 32 {
            return Err("SANDBOXD_TOKEN must be at least 32 characters".into());
        }
        Ok(Config {
            listen: env::var("SANDBOXD_LISTEN").unwrap_or_else(|_| "127.0.0.1:8787".into()),
            token,
            state_dir: env::var("SANDBOXD_STATE").map(PathBuf::from).unwrap_or_else(|_| "/var/lib/lorehouse-sandboxes".into()),
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
    }
}
