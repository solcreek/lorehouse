//! Every process sandboxd starts (the jailer and so Firecracker, `ip`, `nft`, `cp`,
//! `btrfs`, `git`) gets a clean environment: PATH and the C locale, nothing inherited.
//! sandboxd's own environment can hold its secrets (`SANDBOXD_RUNNER_TOKEN`,
//! `SANDBOXD_TOKEN` from an EnvironmentFile=), and a child that inherited them would hand
//! them to whatever runs or breaks in there: the VMM a guest escapes into, above all.

use std::ffi::{OsStr, OsString};
use tokio::process::Command;

/// PATH when sandboxd has none (systemd always sets one).
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// The only variables `command` gives a child (callers may add their own, as git does).
#[cfg(test)]
pub const ALLOWED: [&str; 2] = ["PATH", "LC_ALL"];

fn path() -> OsString {
    std::env::var_os("PATH").filter(|p| !p.is_empty()).unwrap_or_else(|| DEFAULT_PATH.into())
}

/// `Command::new(program)` with the environment cleared and only ALLOWED set. Every
/// process sandboxd starts is made here (a test checks the sources).
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_clear().env("PATH", path()).env("LC_ALL", "C");
    cmd
}

/// What `env` prints when started as `cmd`, as names (for tests).
#[cfg(test)]
pub fn names_seen_by_a_child(mut cmd: Command) -> Vec<String> {
    let out = cmd.as_std_mut().output().expect("env runs");
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.split_once('=').map(|(k, _)| k.to_string())).collect()
}

#[cfg(test)]
mod tests {
    use super::names_seen_by_a_child;

    #[test]
    fn a_child_inherits_nothing_but_path_and_locale() {
        // A name no other test touches (the environment is process-wide).
        std::env::set_var("SANDBOXD_CHILD_ENV_PROBE", "secret");
        let names = names_seen_by_a_child(super::command("env"));
        assert!(!names.is_empty(), "env printed nothing");
        assert!(names.iter().all(|n| super::ALLOWED.contains(&n.as_str())), "{names:?}");
        assert!(!names.iter().any(|n| n.starts_with("SANDBOXD_")), "{names:?}");
    }

    #[test]
    fn every_process_sandboxd_starts_goes_through_command() {
        // Outside tests, no source but this one calls Command::new: a new spawn that forgot
        // env_clear would inherit the tokens.
        let sources = [
            ("config.rs", include_str!("config.rs")),
            ("jail.rs", include_str!("jail.rs")),
            ("main.rs", include_str!("main.rs")),
            ("net.rs", include_str!("net.rs")),
            ("pidfd.rs", include_str!("pidfd.rs")),
            ("publish.rs", include_str!("publish.rs")),
            ("publish/upkeep.rs", include_str!("publish/upkeep.rs")),
            ("quota.rs", include_str!("quota.rs")),
            ("runner.rs", include_str!("runner.rs")),
            ("vm.rs", include_str!("vm.rs")),
            ("vsock.rs", include_str!("vsock.rs")),
        ];
        let test_mod = ["mod tests", " {"].concat();
        let spawn = ["Command::", "new("].concat();
        for (name, src) in sources {
            let end = src.find(&test_mod).unwrap_or(src.len());
            assert!(!src[..end].contains(&spawn), "{name} starts a process without child::command");
        }
        let main = include_str!("main.rs");
        assert!(main.contains("mod child;"));
    }
}
