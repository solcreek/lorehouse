//! Sandbox networking: each VM gets a tap on its own /30 in 172.30.0.0/24, masqueraded
//! out of the uplink. Code in a sandbox is model-directed, so it gets the internet and
//! nothing else:
//!   • no private destinations (LAN, tailnet, link-local, other sandboxes)
//!   • no connections into the host (guestd is reached over vsock, never the network)
//!   • nothing opens a connection into a sandbox; only replies to its own traffic get in
//! One nftables table (`ip lorehouse_sbx`) holds the rules; accepts that Docker's
//! FORWARD chain (policy drop) needs are tagged so they can be removed exactly.

use tokio::process::Command;

pub const TABLE: &str = "lorehouse_sbx";
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
    let out = Command::new(args[0]).args(&args[1..]).output().await.map_err(|e| format!("{}: {e}", args[0]))?;
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
    let Ok(out) = Command::new("nft").args(["-a", "list", "chain", "ip", "filter", "FORWARD"]).output().await else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(TAG))
        .filter_map(|l| l.rsplit("handle ").next().map(|h| h.trim().to_string()))
        .collect()
}

async fn docker_forward_exists() -> bool {
    Command::new("nft").args(["list", "chain", "ip", "filter", "FORWARD"]).output().await.map(|o| o.status.success()).unwrap_or(false)
}

/// Every lhtapN interface on the host, whatever SANDBOXD_MAX_VMS was when it was made.
async fn existing_taps() -> Vec<String> {
    let Ok(out) = Command::new("ip").args(["-o", "link", "show"]).output().await else { return vec![] };
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
    let _ = run(&["nft", "delete", "table", "ip", TABLE]).await;
    for tap in existing_taps().await {
        let _ = run(&["ip", "link", "del", &tap]).await;
    }
}

const IP_FORWARD: &str = "/proc/sys/net/ipv4/ip_forward";

/// Whether the host forwards IPv4, from the contents of IP_FORWARD.
fn forwarding_on(ip_forward: &str) -> bool {
    ip_forward.trim() == "1"
}

/// Whether a sysctl config file's contents turn IPv4 forwarding on.
fn sets_forwarding(conf: &str) -> bool {
    conf.lines().any(|line| {
        let line = line.trim().trim_start_matches('-');
        line.split_once('=').is_some_and(|(k, v)| k.trim().replace('/', ".") == "net.ipv4.ip_forward" && v.trim() == "1")
    })
}

/// Whether any of the places systemd-sysctl reads at boot turns forwarding on.
async fn forwarding_set_at_boot() -> bool {
    let mut files = vec![std::path::PathBuf::from("/etc/sysctl.conf")];
    for dir in ["/etc/sysctl.d", "/run/sysctl.d", "/usr/local/lib/sysctl.d", "/usr/lib/sysctl.d", "/lib/sysctl.d"] {
        if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
            while let Ok(Some(e)) = entries.next_entry().await {
                files.push(e.path());
            }
        }
    }
    for f in files {
        if tokio::fs::read_to_string(&f).await.is_ok_and(|c| sets_forwarding(&c)) {
            return true;
        }
    }
    false
}

/// sandboxd doesn't turn forwarding on itself: its unit makes /proc/sys read-only
/// (ProtectKernelTunables=yes), so sandboxd.sysctl.conf sets it at boot and this checks it.
async fn check_forwarding() -> Result<(), String> {
    let value = tokio::fs::read_to_string(IP_FORWARD).await.map_err(|e| format!("{IP_FORWARD}: {e}"))?;
    if forwarding_on(&value) {
        // On now, possibly only because an older sandboxd (or Docker) set it at run time:
        // say so before a reboot turns it off and this check refuses the start.
        if !forwarding_set_at_boot().await {
            eprintln!("sandboxd: WARNING: net.ipv4.ip_forward is on, but no sysctl.d file turns it on at boot, so after a reboot sandboxd won't start; install sandboxd.sysctl.conf as /etc/sysctl.d/90-lorehouse-sandboxd.conf");
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

/// The table's rules, in order, as `nft` commands.
fn rules(uplink: &str) -> Vec<String> {
    vec![
        format!("add table ip {TABLE}"),
        // Priority -1: before Docker's filter chains, so a drop here is final.
        format!("add chain ip {TABLE} forward {{ type filter hook forward priority -1; }}"),
        format!("add rule ip {TABLE} forward iifname \"lhtap*\" ip daddr {PRIVATE} drop"),
        format!("add rule ip {TABLE} forward iifname \"lhtap*\" oifname != \"{uplink}\" drop"),
        format!("add rule ip {TABLE} forward iifname \"lhtap*\" tcp dport {MAIL_PORTS} drop"),
        // Into a sandbox: only replies to what it started. Nothing may open a connection to
        // a guest, whatever the host's own FORWARD policy is (Docker's drop is not assumed).
        format!("add rule ip {TABLE} forward oifname \"lhtap*\" ct state established,related accept"),
        format!("add rule ip {TABLE} forward oifname \"lhtap*\" drop"),
        format!("add chain ip {TABLE} input {{ type filter hook input priority -1; }}"),
        format!("add rule ip {TABLE} input iifname \"lhtap*\" drop"),
        format!("add chain ip {TABLE} post {{ type nat hook postrouting priority srcnat; }}"),
        format!("add rule ip {TABLE} post ip saddr 172.30.0.0/24 oifname \"{uplink}\" masquerade"),
    ]
}

/// The shared rules, set up once at start (after teardown_all).
pub async fn setup(uplink: &str) -> Result<(), String> {
    check_forwarding().await?;
    for rule in rules(uplink) {
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
        let rules = super::rules("enp2s0");
        let drop_mail = "add rule ip lorehouse_sbx forward iifname \"lhtap*\" tcp dport { 25, 465, 587 } drop";
        let at = |r: &str| rules.iter().position(|x| x == r).unwrap_or_else(|| panic!("missing: {r}\n{rules:#?}"));
        // Before anything in the chain could accept it.
        assert!(at(drop_mail) < at("add rule ip lorehouse_sbx forward oifname \"lhtap*\" ct state established,related accept"));
        // The rules from before are all still there.
        at("add rule ip lorehouse_sbx forward iifname \"lhtap*\" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } drop");
        at("add rule ip lorehouse_sbx forward iifname \"lhtap*\" oifname != \"enp2s0\" drop");
        at("add rule ip lorehouse_sbx input iifname \"lhtap*\" drop");
        at("add rule ip lorehouse_sbx post ip saddr 172.30.0.0/24 oifname \"enp2s0\" masquerade");
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
        assert!(super::sets_forwarding(conf), "{conf}");
        // What the boot-time check recognises, and what it doesn't.
        assert!(super::sets_forwarding("net/ipv4/ip_forward=1\n"));
        assert!(super::sets_forwarding("-net.ipv4.ip_forward = 1\n"));
        assert!(!super::sets_forwarding("# net.ipv4.ip_forward = 1\nnet.ipv4.ip_forward = 0\n"));
    }
}
