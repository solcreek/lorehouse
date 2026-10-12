//! The shipped systemd unit (sandboxd.service), parsed and checked: its hardening is part
//! of the daemon's security, so an edit that drops a directive fails `cargo test`.
//! Whether the directives work together on a real host is the acceptance run's job
//! (README.md, "Hardening").

use std::collections::BTreeSet;

const UNIT: &str = include_str!("../sandboxd.service");
const MODULES: &str = include_str!("../sandboxd.modules.conf");

/// The [Service] section's directives, in order; a key may repeat (DeviceAllow=).
fn service() -> Vec<(String, String)> {
    let mut section = "";
    let mut out = Vec::new();
    for line in UNIT.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            section = line;
            continue;
        }
        if section == "[Service]" {
            let (k, v) = line.split_once('=').unwrap_or_else(|| panic!("not a directive: {line}"));
            out.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    out
}

fn all(key: &str) -> Vec<String> {
    service().into_iter().filter(|(k, _)| k == key).map(|(_, v)| v).collect()
}

fn one(key: &str) -> String {
    let values = all(key);
    assert_eq!(values.len(), 1, "{key}= should be set exactly once, got {values:?}");
    values[0].clone()
}

fn words(key: &str) -> BTreeSet<String> {
    all(key).iter().flat_map(|v| v.split_whitespace().map(String::from).collect::<Vec<_>>()).collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn root_keeps_only_the_capabilities_it_uses() {
    // Taps and nftables rules. Firecracker itself needs none.
    assert_eq!(words("CapabilityBoundingSet"), set(&["CAP_NET_ADMIN"]));
    assert_eq!(one("NoNewPrivileges"), "yes");
}

#[test]
fn the_file_system_is_read_only_but_the_state_directory() {
    assert_eq!(one("ProtectSystem"), "strict");
    // systemd creates it, so the unit starts on a fresh host (a ReadWritePaths= that
    // doesn't exist yet fails the start with 226/NAMESPACE).
    assert_eq!(format!("/var/lib/{}", one("StateDirectory")), crate::config::DEFAULT_STATE);
    assert_eq!(one("StateDirectoryMode"), "0700");
    assert!(all("ReadWritePaths").is_empty());
    for key in ["ProtectHome", "PrivateTmp", "PrivateIPC"] {
        assert_eq!(one(key), "yes", "{key}");
    }
    assert_eq!(one("UMask"), "0077");
}

#[test]
fn only_kvm_and_tun_are_reachable() {
    assert_eq!(one("DevicePolicy"), "closed");
    assert_eq!(all("DeviceAllow").into_iter().collect::<BTreeSet<_>>(), set(&["/dev/kvm rw", "/dev/net/tun rw"]));
    assert_eq!(words("RestrictAddressFamilies"), set(&["AF_UNIX", "AF_INET", "AF_INET6", "AF_NETLINK"]));
    assert_eq!(one("RestrictNamespaces"), "yes");
}

#[test]
fn the_kernel_is_out_of_reach() {
    for key in [
        "ProtectKernelTunables",
        "ProtectKernelModules",
        "ProtectKernelLogs",
        "ProtectControlGroups",
        "ProtectClock",
        "ProtectHostname",
        "LockPersonality",
        "MemoryDenyWriteExecute",
        "RestrictRealtime",
        "RestrictSUIDSGID",
    ] {
        assert_eq!(one(key), "yes", "{key}");
    }
    assert_eq!(one("SystemCallArchitectures"), "native");
    assert_eq!(all("SystemCallFilter"), vec!["@system-service".to_string(), "~@privileged @resources".to_string()]);
    // With ProtectKernelModules=yes nothing in the service loads a module: what the taps
    // and the rules use is loaded at boot.
    let modules: BTreeSet<&str> = MODULES.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).collect();
    for m in ["tun", "nf_tables", "nft_ct", "nft_chain_nat", "nft_masq"] {
        assert!(modules.contains(m), "sandboxd.modules.conf lacks {m}");
    }
    // And sandboxd starts after both have been applied at boot.
    let after = UNIT.lines().filter_map(|l| l.strip_prefix("After=")).flat_map(str::split_whitespace).collect::<BTreeSet<_>>();
    for unit in ["systemd-sysctl.service", "systemd-modules-load.service"] {
        assert!(after.contains(unit), "After= lacks {unit}");
    }
}
