//! Sandbox networking: each VM gets a tap on its own /30 in 172.30.0.0/24, masqueraded
//! out of the uplink. Code in a sandbox is model-directed, so it gets the internet and
//! nothing else:
//!   • no private destinations (LAN, tailnet, link-local, other sandboxes)
//!   • no connections into the host (guestd is reached over vsock, never the network)
//!   • nothing opens a connection into a sandbox; only replies to its own traffic get in
//!   • no forged sources: a packet from a tap must carry that slot's guest address, so a
//!     guest can't pass as another sandbox or as anything else
//!   • no IPv6 at all: guests have no IPv6 route, so whatever IPv6 a tap carries (a
//!     link-local address, the host's sshd over fe80::) is dropped, both into the host and
//!     through it; the guest kernel also boots with `ipv6.disable=1` (vm.rs)
//! One nftables table (`inet lorehouse_sbx`, so every rule covers IPv4 and IPv6) holds
//! the rules; accepts that Docker's FORWARD chain (policy drop) needs are tagged so they
//! can be removed exactly.

use crate::child::command;

pub const TABLE: &str = "lorehouse_sbx";
/// `inet`: one table for both IPv4 and IPv6. Builds up to 5811498 used an `ip` table,
/// which IPv6 never passed through; teardown removes that one too.
pub const FAMILY: &str = "inet";
const TAG: &str = "lorehouse-sbx";
const PRIVATE: &str = "{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 }";

pub struct Slot {
    pub index: usize,
}

impl Slot {
    pub fn tap(&self) -> String {
        format!("lhtap{}", self.index)
    }
    pub fn host_ip(&self) -> String {
        format!("172.30.0.{}", self.index * 4 + 1)
    }
    pub fn guest_ip(&self) -> String {
        format!("172.30.0.{}", self.index * 4 + 2)
    }
    pub fn guest_mac(&self) -> String {
        format!("06:00:ac:1e:00:{:02x}", self.index)
    }
    /// Kernel `ip=` argument: static address, gateway, /30 mask, eth0, no autoconf.
    pub fn kernel_ip_arg(&self) -> String {
        format!("ip={}::{}:255.255.255.252::eth0:off", self.guest_ip(), self.host_ip())
    }
}

async fn run(args: &[&str]) -> Result<(), String> {
    let out = command(args[0]).args(&args[1..]).output().await.map_err(|e| format!("{}: {e}", args[0]))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

async fn nft(rule: &str) -> Result<(), String> {
    run(&["nft", rule]).await
}

/// Handles of the tagged rules in Docker's `ip filter FORWARD`, if that chain exists.
async fn tagged_forward_handles() -> Vec<String> {
    let Ok(out) = command("nft").args(["-a", "list", "chain", "ip", "filter", "FORWARD"]).output().await else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(TAG))
        .filter_map(|l| l.rsplit("handle ").next().map(|h| h.trim().to_string()))
        .collect()
}

async fn docker_forward_exists() -> bool {
    command("nft").args(["list", "chain", "ip", "filter", "FORWARD"]).output().await.map(|o| o.status.success()).unwrap_or(false)
}

/// Every lhtapN interface on the host, whatever SANDBOXD_MAX_VMS was when it was made.
async fn existing_taps() -> Vec<String> {
    let Ok(out) = command("ip").args(["-o", "link", "show"]).output().await else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split(": ").nth(1))
        .map(|name| name.split('@').next().unwrap_or(name).to_string())
        .filter(|name| name.strip_prefix("lhtap").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
        .collect()
}

/// Remove everything this daemon ever added: its table, its tagged FORWARD accepts and
/// every lhtap interface (found on the host, not assumed from the current limit). Safe to
/// run when nothing is there.
pub async fn teardown_all() {
    for h in tagged_forward_handles().await {
        let _ = run(&["nft", "delete", "rule", "ip", "filter", "FORWARD", "handle", &h]).await;
    }
    let _ = run(&["nft", "delete", "table", FAMILY, TABLE]).await;
    let _ = run(&["nft", "delete", "table", "ip", TABLE]).await; // from an older build
    for tap in existing_taps().await {
        let _ = run(&["ip", "link", "del", &tap]).await;
    }
}

const IP_FORWARD: &str = "/proc/sys/net/ipv4/ip_forward";

/// Whether the host forwards IPv4, from the contents of IP_FORWARD.
fn forwarding_on(ip_forward: &str) -> bool {
    ip_forward.trim() == "1"
}

/// The value a sysctl config file's last assignment gives net.ipv4.ip_forward, if any.
fn forwarding_value(conf: &str) -> Option<bool> {
    conf.lines().rev().find_map(|line| {
        let (k, v) = line.trim().trim_start_matches('-').split_once('=')?;
        (k.trim().replace('/', ".") == "net.ipv4.ip_forward").then(|| v.trim() == "1")
    })
}

/// Where systemd-sysctl reads its files at boot, highest precedence first.
/// (/etc/sysctl.conf counts only through a link in one of them, as distributions ship it.)
const SYSCTL_DIRS: [&str; 5] = ["/etc/sysctl.d", "/run/sysctl.d", "/usr/local/lib/sysctl.d", "/usr/lib/sysctl.d", "/lib/sysctl.d"];

/// Whether forwarding is on once systemd-sysctl has applied `files` — (file name, contents)
/// in SYSCTL_DIRS order — the way it does: only `*.conf`, a name in an earlier directory
/// hides the same name in a later one (a link to /dev/null masks it), the rest applied in
/// file name order, the last assignment winning.
fn forwarding_after(files: Vec<(String, String)>) -> bool {
    let mut by_name = std::collections::BTreeMap::new();
    for (name, contents) in files {
        if name.ends_with(".conf") {
            by_name.entry(name).or_insert(contents);
        }
    }
    by_name.values().rev().find_map(|c| forwarding_value(c)).unwrap_or(false)
}

/// Whether forwarding will still be on after a reboot, from what systemd-sysctl reads.
async fn forwarding_set_at_boot() -> bool {
    let mut files = Vec::new();
    for dir in SYSCTL_DIRS {
        let Ok(mut entries) = tokio::fs::read_dir(dir).await else { continue };
        let mut names = Vec::new();
        while let Ok(Some(e)) = entries.next_entry().await {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        for name in names {
            if let Ok(contents) = tokio::fs::read_to_string(std::path::Path::new(dir).join(&name)).await {
                files.push((name, contents));
            }
        }
    }
    forwarding_after(files)
}

/// sandboxd doesn't turn forwarding on itself: its unit makes /proc/sys read-only
/// (ProtectKernelTunables=yes), so sandboxd.sysctl.conf sets it at boot and this checks it.
async fn check_forwarding() -> Result<(), String> {
    let value = tokio::fs::read_to_string(IP_FORWARD).await.map_err(|e| format!("{IP_FORWARD}: {e}"))?;
    if forwarding_on(&value) {
        // On now, possibly only because an older sandboxd (or Docker) set it at run time:
        // say so before a reboot turns it off and this check refuses the start.
        if !forwarding_set_at_boot().await {
            eprintln!("sandboxd: WARNING: net.ipv4.ip_forward is on, but the sysctl.d files applied at boot leave it off, so after a reboot sandboxd won't start; install sandboxd.sysctl.conf as /etc/sysctl.d/90-lorehouse-sandboxd.conf, with no later-named file setting it to 0");
        }
        Ok(())
    } else {
        Err(format!(
            "net.ipv4.ip_forward is {}, so sandboxes would have no internet. Install sandboxd.sysctl.conf as /etc/sysctl.d/90-lorehouse-sandboxd.conf and run `sysctl --system`; sandboxd doesn't set it itself (its unit makes kernel tunables read-only)",
            value.trim()
        ))
    }
}

/// The ports mail goes out on: SMTP, SMTPS and submission. A sandbox has no business
/// sending mail, and spam from it would get the host's address blocklisted (and, at
/// some providers, the server locked).
pub const MAIL_PORTS: &str = "{ 25, 465, 587 }";

/// The table's rules, in order, as `nft` commands, for slots `0..slots`. The table is
/// `inet`, so a rule with no family match (`iifname "lhtap*" drop`) covers IPv4 and IPv6.
fn rules(uplink: &str, slots: usize) -> Vec<String> {
    let t = format!("{FAMILY} {TABLE}");
    let mut rules = vec![
        format!("add table {t}"),
        // Anti-spoofing: from tap N only slot N's guest address gets past this chain; any
        // other source (another guest's, the host's, the internet's) is counted and
        // dropped. Masquerade then only ever rewrites a guest's own address.
        format!("add chain {t} spoof"),
    ];
    for index in 0..slots {
        let slot = Slot { index };
        rules.push(format!("add rule {t} spoof iifname \"{}\" ip saddr {} return", slot.tap(), slot.guest_ip()));
    }
    rules.extend([
        format!("add rule {t} spoof counter drop"),
        // Priority -1: before Docker's filter chains, so a drop here is final.
        format!("add chain {t} forward {{ type filter hook forward priority -1; }}"),
        // Guests have no IPv6 route (and no IPv6 at all with ipv6.disable=1): nothing of it
        // goes through the host, whatever the host's own IPv6 forwarding is.
        format!("add rule {t} forward iifname \"lhtap*\" meta nfproto ipv6 drop"),
        format!("add rule {t} forward iifname \"lhtap*\" jump spoof"),
        format!("add rule {t} forward iifname \"lhtap*\" ip daddr {PRIVATE} drop"),
        format!("add rule {t} forward iifname \"lhtap*\" oifname != \"{uplink}\" drop"),
        format!("add rule {t} forward iifname \"lhtap*\" tcp dport {MAIL_PORTS} drop"),
        // Into a sandbox: only replies to what it started. Nothing may open a connection to
        // a guest, whatever the host's own FORWARD policy is (Docker's drop is not assumed).
        format!("add rule {t} forward oifname \"lhtap*\" ct state established,related accept"),
        format!("add rule {t} forward oifname \"lhtap*\" drop"),
        // Into the host from a tap, IPv4 and IPv6: a tap has an IPv6 link-local address by
        // default, and the host's IPv6 firewall (ufw on starship) allows sshd from anywhere.
        // Spoofed sources are counted first, then everything is dropped.
        format!("add chain {t} input {{ type filter hook input priority -1; }}"),
        format!("add rule {t} input iifname \"lhtap*\" jump spoof"),
        format!("add rule {t} input iifname \"lhtap*\" drop"),
        format!("add chain {t} post {{ type nat hook postrouting priority srcnat; }}"),
        format!("add rule {t} post ip saddr 172.30.0.0/24 oifname \"{uplink}\" masquerade"),
    ]);
    rules
}

/// The shared rules, set up once at start (after teardown_all).
pub async fn setup(uplink: &str, slots: usize) -> Result<(), String> {
    check_forwarding().await?;
    for rule in rules(uplink, slots) {
        nft(&rule).await?;
    }
    if docker_forward_exists().await {
        // Docker's FORWARD policy is drop; our accepts must live in that chain.
        nft(&format!("insert rule ip filter FORWARD iifname \"{uplink}\" oifname \"lhtap*\" ct state established,related accept comment \"{TAG}\"")).await?;
        nft(&format!("insert rule ip filter FORWARD iifname \"lhtap*\" oifname \"{uplink}\" accept comment \"{TAG}\"")).await?;
    }
    Ok(())
}

/// `ip tuntap add` for a slot's tap, owned by the uid its jailed Firecracker runs as:
/// without that, attaching to the tap would need CAP_NET_ADMIN, which the VM never has.
fn tap_add(tap: &str, owner: u32) -> Vec<String> {
    let owner = owner.to_string();
    ["ip", "tuntap", "add", "dev", tap, "mode", "tap", "user", &owner, "group", &owner].map(String::from).to_vec()
}

pub async fn tap_up(slot: &Slot, owner: u32) -> Result<(), String> {
    let tap = slot.tap();
    let _ = run(&["ip", "link", "del", &tap]).await; // a leftover from a crash
    let add = tap_add(&tap, owner);
    run(&add.iter().map(String::as_str).collect::<Vec<_>>()).await?;
    run(&["ip", "addr", "add", &format!("{}/30", slot.host_ip()), "dev", &tap]).await?;
    run(&["ip", "link", "set", &tap, "up"]).await
}

pub async fn tap_down(slot: &Slot) {
    let _ = run(&["ip", "link", "del", &slot.tap()]).await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_sandbox_reaches_the_internet_but_not_mail_ports() {
        let rules = super::rules("enp2s0", 4);
        let drop_mail = "add rule inet lorehouse_sbx forward iifname \"lhtap*\" tcp dport { 25, 465, 587 } drop";
        let at = |r: &str| rules.iter().position(|x| x == r).unwrap_or_else(|| panic!("missing: {r}\n{rules:#?}"));
        // Before anything in the chain could accept it.
        assert!(at(drop_mail) < at("add rule inet lorehouse_sbx forward oifname \"lhtap*\" ct state established,related accept"));
        // The rules from before are all still there.
        at("add rule inet lorehouse_sbx forward iifname \"lhtap*\" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } drop");
        at("add rule inet lorehouse_sbx forward iifname \"lhtap*\" oifname != \"enp2s0\" drop");
        at("add rule inet lorehouse_sbx input iifname \"lhtap*\" drop");
        at("add rule inet lorehouse_sbx post ip saddr 172.30.0.0/24 oifname \"enp2s0\" masquerade");
    }

    #[test]
    fn ipv6_from_a_sandbox_goes_nowhere() {
        let rules = super::rules("enp2s0", 4);
        // One inet table: every rule sees IPv4 and IPv6. An `ip` table never sees IPv6, which
        // left the host's sshd reachable over a tap's link-local address.
        assert!(rules.iter().all(|r| r.contains(" inet lorehouse_sbx")), "{rules:#?}");
        assert!(!rules.iter().any(|r| r.contains(" ip lorehouse_sbx")));
        let at = |r: &str| rules.iter().position(|x| x == r).unwrap_or_else(|| panic!("missing: {r}\n{rules:#?}"));
        // Through the host: dropped first, before any rule could accept it.
        let v6 = at("add rule inet lorehouse_sbx forward iifname \"lhtap*\" meta nfproto ipv6 drop");
        let forward = at("add chain inet lorehouse_sbx forward { type filter hook forward priority -1; }");
        assert_eq!(v6, forward + 1, "the first rule of the forward chain");
        // Into the host: the input drop names no family, so it covers both.
        at("add rule inet lorehouse_sbx input iifname \"lhtap*\" drop");
        assert!(at("add chain inet lorehouse_sbx input { type filter hook input priority -1; }") < at("add rule inet lorehouse_sbx input iifname \"lhtap*\" drop"));
    }

    #[test]
    fn a_guest_sends_only_from_its_own_address() {
        let rules = super::rules("enp2s0", 3);
        let at = |r: &str| rules.iter().position(|x| x == r).unwrap_or_else(|| panic!("missing: {r}\n{rules:#?}"));
        // Each tap lets through its own guest's address, and nothing else.
        let own: Vec<usize> = (0..3)
            .map(|i| {
                let slot = super::Slot { index: i };
                at(&format!("add rule inet lorehouse_sbx spoof iifname \"lhtap{i}\" ip saddr {} return", slot.guest_ip()))
            })
            .collect();
        assert_eq!(rules.iter().filter(|r| r.contains(" spoof iifname")).count(), 3, "one per slot");
        let drop = at("add rule inet lorehouse_sbx spoof counter drop");
        assert!(own.iter().all(|&i| i < drop), "the drop ends the chain");
        assert!(at("add chain inet lorehouse_sbx spoof") < own[0]);
        // Checked on the way through the host, before anything there accepts...
        let jump = at("add rule inet lorehouse_sbx forward iifname \"lhtap*\" jump spoof");
        assert!(jump < at("add rule inet lorehouse_sbx forward oifname \"lhtap*\" ct state established,related accept"));
        assert!(jump < at("add rule inet lorehouse_sbx forward iifname \"lhtap*\" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } drop"));
        // ...and into it.
        assert!(at("add rule inet lorehouse_sbx input iifname \"lhtap*\" jump spoof") < at("add rule inet lorehouse_sbx input iifname \"lhtap*\" drop"));
        // The addresses: slot 2's guest is 172.30.0.10, its tap lhtap2.
        assert!(rules.contains(&"add rule inet lorehouse_sbx spoof iifname \"lhtap2\" ip saddr 172.30.0.10 return".to_string()));
        // Masquerade is unchanged: only the sandboxes' range, only out of the uplink.
        at("add rule inet lorehouse_sbx post ip saddr 172.30.0.0/24 oifname \"enp2s0\" masquerade");
    }

    #[test]
    fn a_tap_belongs_to_its_vms_uid() {
        assert_eq!(super::tap_add("lhtap3", 1_900_000_003).join(" "), "ip tuntap add dev lhtap3 mode tap user 1900000003 group 1900000003");
    }

    #[test]
    fn forwarding_is_read_not_written() {
        assert!(super::forwarding_on("1\n"));
        assert!(!super::forwarding_on("0\n"));
        assert!(!super::forwarding_on(""));
        // Nothing in the daemon may write a sysctl: under ProtectKernelTunables=yes it
        // can't, and the setting belongs to sandboxd.sysctl.conf.
        let src = include_str!("net.rs");
        let call = ["\"sys", "ctl\""].concat();
        assert!(!src.contains(&call), "net.rs runs sysctl");
        let conf = include_str!("../sandboxd.sysctl.conf");
        assert_eq!(super::forwarding_value(conf), Some(true), "{conf}");
        // What the boot-time check recognises, and what it doesn't.
        assert_eq!(super::forwarding_value("net/ipv4/ip_forward=1\n"), Some(true));
        assert_eq!(super::forwarding_value("-net.ipv4.ip_forward = 1\n"), Some(true));
        assert_eq!(super::forwarding_value("# net.ipv4.ip_forward = 1\nnet.ipv4.ip_forward = 0\n"), Some(false));
        assert_eq!(super::forwarding_value("net.ipv4.ip_forward = 1\nnet.ipv4.ip_forward = 0\n"), Some(false));
        assert_eq!(super::forwarding_value("kernel.sysrq = 1\n"), None);
    }

    #[test]
    fn boot_forwarding_follows_systemd_sysctl_order() {
        let f = |files: &[(&str, &str)]| super::forwarding_after(files.iter().map(|(n, c)| (n.to_string(), c.to_string())).collect());
        let on = "net.ipv4.ip_forward = 1\n";
        let off = "net.ipv4.ip_forward = 0\n";
        assert!(f(&[("90-lorehouse-sandboxd.conf", on)]));
        assert!(!f(&[]));
        // A later file name turns it off again: a reboot would leave it off.
        assert!(!f(&[("90-lorehouse-sandboxd.conf", on), ("99-local.conf", off)]));
        assert!(f(&[("10-local.conf", off), ("90-lorehouse-sandboxd.conf", on)]));
        // File name order, not directory order: /etc's 99 (read first) is applied after
        // /usr/lib's 90.
        assert!(!f(&[("99-local.conf", off), ("90-lorehouse-sandboxd.conf", on)]));
        // An /etc file (listed first) hides /usr/lib's of the same name, e.g. a /dev/null mask.
        assert!(!f(&[("90-lorehouse-sandboxd.conf", ""), ("90-lorehouse-sandboxd.conf", on)]));
        // Only *.conf is read.
        assert!(!f(&[("90-lorehouse-sandboxd.conf.bak", on)]));
    }
}
