//! Sandbox networking: each VM gets a tap on its own /30 in 172.30.0.0/24, masqueraded
//! out of the uplink. Code in a sandbox is model-directed, so it gets the internet and
//! nothing else:
//!   • no private destinations (LAN, tailnet, link-local, other sandboxes)
//!   • no connections into the host (guestd is reached over vsock, never the network)
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

/// Remove everything this daemon ever added: its table, its tagged FORWARD accepts and
/// every lhtap interface. Safe to run when nothing is there.
pub async fn teardown_all(max_vms: usize) {
    for h in tagged_forward_handles().await {
        let _ = run(&["nft", "delete", "rule", "ip", "filter", "FORWARD", "handle", &h]).await;
    }
    let _ = run(&["nft", "delete", "table", "ip", TABLE]).await;
    for i in 0..max_vms {
        let _ = run(&["ip", "link", "del", &Slot { index: i }.tap()]).await;
    }
}

/// The shared rules, set up once at start (after teardown_all).
pub async fn setup(uplink: &str) -> Result<(), String> {
    run(&["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"]).await?;
    nft(&format!("add table ip {TABLE}")).await?;
    // Priority -1: before Docker's filter chains, so a drop here is final.
    nft(&format!("add chain ip {TABLE} forward {{ type filter hook forward priority -1; }}")).await?;
    nft(&format!("add rule ip {TABLE} forward iifname \"lhtap*\" ip daddr {PRIVATE} drop")).await?;
    nft(&format!("add rule ip {TABLE} forward iifname \"lhtap*\" oifname != \"{uplink}\" drop")).await?;
    nft(&format!("add chain ip {TABLE} input {{ type filter hook input priority -1; }}")).await?;
    nft(&format!("add rule ip {TABLE} input iifname \"lhtap*\" drop")).await?;
    nft(&format!("add chain ip {TABLE} post {{ type nat hook postrouting priority srcnat; }}")).await?;
    nft(&format!("add rule ip {TABLE} post ip saddr 172.30.0.0/24 oifname \"{uplink}\" masquerade")).await?;
    if docker_forward_exists().await {
        // Docker's FORWARD policy is drop; our accepts must live in that chain.
        nft(&format!("insert rule ip filter FORWARD iifname \"{uplink}\" oifname \"lhtap*\" ct state established,related accept comment \"{TAG}\"")).await?;
        nft(&format!("insert rule ip filter FORWARD iifname \"lhtap*\" oifname \"{uplink}\" accept comment \"{TAG}\"")).await?;
    }
    Ok(())
}

pub async fn tap_up(slot: &Slot) -> Result<(), String> {
    let tap = slot.tap();
    let _ = run(&["ip", "link", "del", &tap]).await; // a leftover from a crash
    run(&["ip", "tuntap", "add", "dev", &tap, "mode", "tap"]).await?;
    run(&["ip", "addr", "add", &format!("{}/30", slot.host_ip()), "dev", &tap]).await?;
    run(&["ip", "link", "set", &tap, "up"]).await
}

pub async fn tap_down(slot: &Slot) {
    let _ = run(&["ip", "link", "del", &slot.tap()]).await;
}
