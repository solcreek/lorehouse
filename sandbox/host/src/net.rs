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
//! the rules, loaded in one transaction; accepts that Docker's FORWARD chain (policy drop)
//! needs are tagged so they can be removed exactly.
//!
//! The table is checked against what sandboxd loaded every SANDBOXD_NET_CHECK_SECS and
//! before every boot (Firewall): starship is shared, and an `nft flush ruleset` there
//! (by hand, or a tool reloading its own firewall) would leave running guests unfiltered.
//! A table that is gone or changed is loaded again, and logged; one that can't be loaded
//! again fails closed: no VM boots and every running one is stopped until it is back.

use crate::child::command;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

/// The most any `ip` or `nft` run may take: one that hangs (a netlink lock, a stuck
/// kernel) must not hold the table's checks, and with them every boot, forever.
const TOOL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// A command's output, killed past TOOL_DEADLINE.
async fn output(cmd: &mut tokio::process::Command) -> Result<std::process::Output, String> {
    let program = cmd.as_std().get_program().to_string_lossy().into_owned();
    match tokio::time::timeout(TOOL_DEADLINE, cmd.kill_on_drop(true).output()).await {
        Ok(r) => r.map_err(|e| format!("{program}: {e}")),
        Err(_) => Err(format!("{program}: no answer within {} s", TOOL_DEADLINE.as_secs())),
    }
}

async fn run(args: &[&str]) -> Result<(), String> {
    let out = output(command(args[0]).args(&args[1..])).await?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

async fn nft(rule: &str) -> Result<(), String> {
    run(&["nft", rule]).await
}

/// Docker's `ip filter FORWARD`, listed with handles; None when there is no such chain,
/// an error when nft couldn't tell (a failure or a timeout is not an absent chain).
async fn docker_forward() -> Result<Option<String>, String> {
    let out = output(command("nft").args(["-a", "list", "chain", "ip", "filter", "FORWARD"])).await?;
    forward_listing(out.status.success(), &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr))
}

/// What `nft -a list chain ip filter FORWARD` said: the listing, None when the chain (or
/// its table) isn't there, else nft's error.
fn forward_listing(success: bool, stdout: &str, stderr: &str) -> Result<Option<String>, String> {
    if success {
        Ok(Some(stdout.to_string()))
    } else if stderr.contains("No such file or directory") {
        Ok(None)
    } else {
        Err(format!("nft list chain ip filter FORWARD: {}", stderr.trim()))
    }
}

/// Handles of the tagged rules in a listing of Docker's FORWARD.
fn tagged_handles(listing: &str) -> Vec<String> {
    listing.lines().filter(|l| l.contains(TAG)).filter_map(|l| l.rsplit("handle ").next().map(|h| h.trim().to_string())).collect()
}

/// Handles of the tagged rules in Docker's `ip filter FORWARD`, if that chain exists.
async fn tagged_forward_handles() -> Vec<String> {
    docker_forward().await.ok().flatten().map(|l| tagged_handles(&l)).unwrap_or_default()
}

/// Our two accepts in Docker's FORWARD (policy drop), where that chain exists: without
/// them sandboxes have no internet. Put back when either is missing, e.g. after a flush
/// and a Docker restart. Whether they had to be.
async fn ensure_forward_accepts(uplink: &str) -> Result<bool, String> {
    let Some(listing) = docker_forward().await? else { return Ok(false) };
    let handles = tagged_handles(&listing);
    if handles.len() == 2 {
        return Ok(false);
    }
    for h in handles {
        let _ = run(&["nft", "delete", "rule", "ip", "filter", "FORWARD", "handle", &h]).await;
    }
    nft(&format!("insert rule ip filter FORWARD iifname \"{uplink}\" oifname \"lhtap*\" ct state established,related accept comment \"{TAG}\"")).await?;
    nft(&format!("insert rule ip filter FORWARD iifname \"lhtap*\" oifname \"{uplink}\" accept comment \"{TAG}\"")).await?;
    Ok(true)
}

/// Every lhtapN interface on the host, whatever SANDBOXD_MAX_VMS was when it was made; an
/// error when `ip` couldn't list them.
async fn list_taps() -> Result<Vec<String>, String> {
    let out = output(command("ip").args(["-o", "link", "show"])).await?;
    if !out.status.success() {
        return Err(format!("ip -o link show: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split(": ").nth(1))
        .map(|name| name.split('@').next().unwrap_or(name).to_string())
        .filter(|name| name.strip_prefix("lhtap").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
        .collect())
}

/// list_taps, with nothing when it fails (teardown: best effort).
async fn existing_taps() -> Vec<String> {
    list_taps().await.unwrap_or_default()
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

/// What taps_down could confirm: the taps seen to go down, and what went wrong with the
/// rest. A tap not in `down` (it failed, it hung, or the taps couldn't even be listed) may
/// still carry its guest's traffic.
#[derive(Debug, Default, PartialEq)]
pub struct TapsDown {
    pub down: std::collections::HashSet<String>,
    pub errors: Vec<String>,
}

impl TapsDown {
    /// Whether `tap` was seen to go down.
    pub fn confirmed(&self, tap: &str) -> bool {
        self.down.contains(tap)
    }
}

/// Every sandbox's tap down at once: no packet in or out of any VM from here on, before
/// they are stopped. For when the table is gone for good. A tap it can't confirm down is
/// named in `errors`, and its VM is killed rather than stopped gracefully (vm.rs fail_closed).
pub async fn taps_down() -> TapsDown {
    all_down(list_taps().await, |tap| async move { run(&["ip", "link", "set", "dev", &tap, "down"]).await }).await
}

/// `down` for every tap in `taps`, all at once: one `ip` that hangs (up to TOOL_DEADLINE)
/// doesn't hold back the others.
pub(crate) async fn all_down<F, Fut>(taps: Result<Vec<String>, String>, down: F) -> TapsDown
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    let mut result = TapsDown::default();
    let taps = match taps {
        Ok(t) => t,
        Err(e) => {
            result.errors.push(format!("the taps couldn't be listed ({e}), so none is confirmed down"));
            return result;
        }
    };
    let mut set = tokio::task::JoinSet::new();
    for tap in &taps {
        let (fut, tap) = (down(tap.clone()), tap.clone());
        set.spawn(async move { (fut.await, tap) });
    }
    while let Some(done) = set.join_next().await {
        match done {
            Ok((Ok(()), tap)) => {
                result.down.insert(tap);
            }
            Ok((Err(e), tap)) => result.errors.push(format!("{tap}: {e}")),
            Err(e) => result.errors.push(e.to_string()),
        }
    }
    if !result.errors.is_empty() {
        result.errors.sort();
        let n = result.errors.len();
        result.errors.insert(0, format!("{n} of {} taps not confirmed down", taps.len()));
    }
    result
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

/// The ports mail goes out on: SMTP, SMTPS, submission, and 2525, the alternative
/// submission port mail services (SendGrid, Mailgun, Postmark, …) offer where 587 is
/// blocked. A sandbox has no business sending mail, and spam from it would get the host's
/// address blocklisted (and, at some providers, the server locked).
pub const MAIL_PORTS: &str = "{ 25, 465, 587, 2525 }";

/// The table, as `nft -f` reads it, for slots `0..slots`. It is `inet`, so a rule with no
/// family match (`iifname "lhtap*" drop`) covers IPv4 and IPv6 alike.
///
/// - `spoof`: anti-spoofing. From tap N only slot N's guest address gets past it; any
///   other source (another guest's, the host's, the internet's) is counted and dropped, so
///   masquerade only ever rewrites a guest's own address.
/// - `forward` (priority -1: before Docker's filter chains, so a drop here is final):
///   IPv6 first (guests have no IPv6 route, nor any IPv6 with ipv6.disable=1), then the
///   source check, private destinations, anything but the uplink, mail. Into a sandbox only
///   replies to what it started: nothing may open a connection to a guest, whatever the
///   host's own FORWARD policy is (Docker's drop is not assumed).
/// - `input`: nothing from a tap reaches the host, IPv4 or IPv6 (a tap has an IPv6
///   link-local address by default, and starship's ufw allows sshd over IPv6 from
///   anywhere). Spoofed sources are counted on the way.
/// - `post`: masquerade, only the sandboxes' range and only out of the uplink.
fn table(uplink: &str, slots: usize) -> String {
    let own: String = (0..slots)
        .map(|index| {
            let slot = Slot { index };
            format!("\t\tiifname \"{}\" ip saddr {} return\n", slot.tap(), slot.guest_ip())
        })
        .collect();
    format!(
        "table {FAMILY} {TABLE} {{
\tchain spoof {{
{own}\t\tcounter drop
\t}}
\tchain forward {{
\t\ttype filter hook forward priority -1; policy accept;
\t\tiifname \"lhtap*\" meta nfproto ipv6 drop
\t\tiifname \"lhtap*\" jump spoof
\t\tiifname \"lhtap*\" ip daddr {PRIVATE} drop
\t\tiifname \"lhtap*\" oifname != \"{uplink}\" drop
\t\tiifname \"lhtap*\" tcp dport {MAIL_PORTS} drop
\t\toifname \"lhtap*\" ct state established,related accept
\t\toifname \"lhtap*\" drop
\t}}
\tchain input {{
\t\ttype filter hook input priority -1; policy accept;
\t\tiifname \"lhtap*\" jump spoof
\t\tiifname \"lhtap*\" drop
\t}}
\tchain post {{
\t\ttype nat hook postrouting priority srcnat; policy accept;
\t\tip saddr 172.30.0.0/24 oifname \"{uplink}\" masquerade
\t}}
}}
"
    )
}

/// What `nft -f -` loads, as one transaction: whatever table is there (this build's, or an
/// older build's `ip` one) is deleted and the new one added, or, if any of it fails, none
/// of it happens. There is never a moment with the old table gone and the new one not yet
/// whole. (Adding an empty table first makes the delete succeed when there is none.)
fn batch(uplink: &str, slots: usize) -> String {
    format!("table ip {TABLE} {{}}\ndelete table ip {TABLE}\ntable {FAMILY} {TABLE} {{}}\ndelete table {FAMILY} {TABLE}\n{}", table(uplink, slots))
}

/// `nft -f -` with `text` on its stdin: one atomic transaction.
async fn load(text: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut child =
        command("nft").args(["-f", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| format!("nft: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("nft: no stdin")?;
    let run = async {
        stdin.write_all(text.as_bytes()).await.map_err(|e| format!("nft -f -: {e}"))?;
        drop(stdin);
        child.wait_with_output().await.map_err(|e| format!("nft: {e}"))
    };
    let out = tokio::time::timeout(TOOL_DEADLINE, run).await.map_err(|_| format!("nft -f -: no answer within {} s", TOOL_DEADLINE.as_secs()))??;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("nft -f -: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// The shared rules, set up once at start (after teardown_all).
pub async fn setup(fw: &Firewall) -> Result<(), String> {
    check_forwarding().await?;
    fw.apply().await?;
    // Docker's FORWARD policy is drop; our accepts must live in that chain.
    fw.nft.forward_accepts(&fw.uplink).await.map(|_| ())
}

type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How the Firewall reads and loads the table: nft, or a stand-in in tests.
pub trait Nft: Send + Sync {
    /// `nft list table inet lorehouse_sbx`: Ok(None) when it isn't there, an error when
    /// nft couldn't tell.
    fn list(&self) -> Boxed<'_, Result<Option<String>, String>>;
    /// `nft -f -`.
    fn load<'a>(&'a self, text: &'a str) -> Boxed<'a, Result<(), String>>;
    /// ensure_forward_accepts.
    fn forward_accepts<'a>(&'a self, uplink: &'a str) -> Boxed<'a, Result<bool, String>>;
}

struct System;

impl Nft for System {
    fn list(&self) -> Boxed<'_, Result<Option<String>, String>> {
        Box::pin(async {
            let out = output(command("nft").args(["list", "table", FAMILY, TABLE])).await?;
            let stderr = String::from_utf8_lossy(&out.stderr);
            if out.status.success() {
                Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
            } else if stderr.contains("No such file or directory") {
                Ok(None)
            } else {
                Err(format!("nft list table: {}", stderr.trim()))
            }
        })
    }
    fn load<'a>(&'a self, text: &'a str) -> Boxed<'a, Result<(), String>> {
        Box::pin(load(text))
    }
    fn forward_accepts<'a>(&'a self, uplink: &'a str) -> Boxed<'a, Result<bool, String>> {
        Box::pin(ensure_forward_accepts(uplink))
    }
}

/// A table listing with what changes on its own taken out: counters' values, blank
/// lines, indentation. Two listings of the same rules give the same text.
fn normalize(listing: &str) -> String {
    let mut out = String::new();
    for line in listing.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let words: Vec<&str> = line.split_whitespace().collect();
        let mut i = 0;
        let mut kept = Vec::with_capacity(words.len());
        while i < words.len() {
            // `counter packets N bytes M` → `counter`
            if words[i] == "packets" && i > 0 && words[i - 1] == "counter" && words.get(i + 2) == Some(&"bytes") {
                i += 4;
                continue;
            }
            kept.push(words[i]);
            i += 1;
        }
        out.push_str(&kept.join(" "));
        out.push('\n');
    }
    out
}

/// Whether the live table is what was loaded.
#[derive(Debug, PartialEq)]
enum Drift {
    InSync,
    /// Not there at all (a flush, a delete).
    Missing,
    /// There, but not as loaded (a rule added, removed or changed; a chain flushed).
    Changed,
}

fn drift(expected: &str, live: Option<&str>) -> Drift {
    match live {
        None => Drift::Missing,
        Some(l) if normalize(l) == expected => Drift::InSync,
        Some(_) => Drift::Changed,
    }
}

/// Whether a listing has the chains `table` declares, each with as many lines: nft
/// rewrites a rule's text (`priority -1` as `priority filter - 1`, a set's order), so the
/// text itself can't be compared, but nothing may be missing or added.
fn same_shape(declared: &str, listing: &str) -> bool {
    let count = |t: &str| chains(t).into_iter().map(|(n, lines)| (n, lines.len())).collect::<Vec<_>>();
    count(declared) == count(listing)
}

/// sandboxd's nftables table, kept as loaded.
pub struct Firewall {
    uplink: String,
    slots: usize,
    nft: Box<dyn Nft>,
    /// The live table, normalized, right after sandboxd loaded it; None until a load has
    /// succeeded, and again after one failed: no VM may boot until a load succeeds.
    expected: std::sync::Mutex<Option<String>>,
    /// Shutting down: teardown removes the table, and nothing may put it back.
    closed: AtomicBool,
    /// One check or load at a time.
    turn: tokio::sync::Mutex<()>,
    /// Woken when a boot finds the table broken, so the VMs are stopped at once.
    pub alarm: tokio::sync::Notify,
}

impl Firewall {
    pub fn new(uplink: &str, slots: usize) -> Arc<Firewall> {
        Firewall::with(uplink, slots, Box::new(System))
    }

    pub fn with(uplink: &str, slots: usize, nft: Box<dyn Nft>) -> Arc<Firewall> {
        Arc::new(Firewall {
            uplink: uplink.to_string(),
            slots,
            nft,
            expected: std::sync::Mutex::new(None),
            closed: AtomicBool::new(false),
            turn: tokio::sync::Mutex::new(()),
            alarm: tokio::sync::Notify::new(),
        })
    }

    /// Load the table (one transaction) and remember what nft then lists as the table to keep.
    pub async fn apply(&self) -> Result<(), String> {
        let _turn = self.turn.lock().await;
        self.apply_locked().await
    }

    async fn apply_locked(&self) -> Result<(), String> {
        self.nft.load(&batch(&self.uplink, self.slots)).await?;
        let listing = self.list().await?.ok_or_else(|| format!("{FAMILY} {TABLE} isn't there right after it was loaded"))?;
        if !same_shape(&table(&self.uplink, self.slots), &listing) {
            return Err(format!("{FAMILY} {TABLE} as listed isn't the table loaded:\n{listing}"));
        }
        *self.expected.lock().unwrap_or_else(|e| e.into_inner()) = Some(normalize(&listing));
        Ok(())
    }

    /// The live table; a failure to list it is tried once more before it counts.
    async fn list(&self) -> Result<Option<String>, String> {
        match self.nft.list().await {
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                self.nft.list().await
            }
            done => done,
        }
    }

    /// Check the live table against what was loaded; load it again if it differs (and log
    /// it loudly). An error means it couldn't be, or sandboxd is shutting down: the caller
    /// must not boot a VM, and (unless shutting down) the running ones must stop.
    pub async fn ensure(&self) -> Result<(), String> {
        let _turn = self.turn.lock().await;
        if self.is_closed() {
            return Err("sandboxd is shutting down".into());
        }
        let expected = self.expected.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let what = match (expected, self.list().await) {
            (None, _) => "not loaded (the last load failed)".to_string(),
            (Some(_), Err(e)) => format!("unreadable ({e})"),
            (Some(e), Ok(live)) => match drift(&e, live.as_deref()) {
                Drift::InSync => {
                    self.keep_forward_accepts().await;
                    return Ok(());
                }
                Drift::Missing => "gone (flushed or deleted)".into(),
                Drift::Changed => "not what sandboxd loaded (rules added, removed or changed)".into(),
            },
        };
        eprintln!("sandboxd: ALERT: nftables table {FAMILY} {TABLE} is {what}; loading it again");
        match self.apply_locked().await {
            Ok(()) => {
                eprintln!("sandboxd: nftables table {FAMILY} {TABLE} loaded again; sandboxes are filtered");
                self.keep_forward_accepts().await;
                Ok(())
            }
            Err(e) => {
                *self.expected.lock().unwrap_or_else(|e| e.into_inner()) = None;
                eprintln!("sandboxd: ALERT: nftables table {FAMILY} {TABLE} couldn't be loaded again ({e}): every tap goes down, every running VM is stopped, and none boots until it is");
                Err(format!("the sandboxes' network rules are missing and couldn't be restored: {e}"))
            }
        }
    }

    /// Docker's FORWARD accepts, put back if they went (sandboxes would have no internet:
    /// that fails closed, so it is only logged).
    async fn keep_forward_accepts(&self) {
        match self.nft.forward_accepts(&self.uplink).await {
            Ok(true) => eprintln!("sandboxd: WARNING: sandboxd's accepts in Docker's FORWARD chain were gone; added again"),
            Ok(false) => {}
            Err(e) => eprintln!("sandboxd: WARNING: sandboxd's accepts in Docker's FORWARD chain: {e}; sandboxes may have no internet"),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// No more checks or loads: teardown is about to remove the table.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _turn = self.turn.lock().await; // a check under way finishes first
    }
}

/// Each chain of a table as `nft` writes it (and `table` does): its name and its lines,
/// the `type …` line included, trimmed.
fn chains(text: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut current: Option<(String, Vec<String>)> = None;
    for line in text.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix("chain ").and_then(|l| l.strip_suffix(" {")) {
            current = Some((name.to_string(), Vec::new()));
        } else if line == "}" {
            if let Some(chain) = current.take() {
                out.push(chain);
            }
        } else if let Some((_, lines)) = current.as_mut() {
            if !line.is_empty() {
                lines.push(line.to_string());
            }
        }
    }
    out
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
    // No IPv6 link-local address on the host's side either: nothing for a guest to reach
    // over IPv6 even if the rules were gone. (Fails where the host has no IPv6: ignored.)
    let _ = run(&["ip", "link", "set", "dev", &tap, "addrgenmode", "none"]).await;
    run(&["ip", "link", "set", &tap, "up"]).await
}

pub async fn tap_down(slot: &Slot) {
    let _ = run(&["ip", "link", "del", &slot.tap()]).await;
}

/// nft as a table in memory, for tests: `load` keeps the declared table, and a test
/// changes `live` behind the Firewall's back, makes loads fail, or listing fail.
#[cfg(test)]
pub mod fake {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct Fake {
        pub live: Mutex<Option<String>>,
        pub loads: AtomicUsize,
        pub fail: AtomicBool,
        /// This many lists fail before one works.
        pub unreadable: AtomicUsize,
    }

    pub struct Shared(pub Arc<Fake>);

    impl super::Nft for Shared {
        fn list(&self) -> super::Boxed<'_, Result<Option<String>, String>> {
            let unreadable = self.0.unreadable.load(SeqCst);
            if unreadable > 0 {
                self.0.unreadable.store(unreadable - 1, SeqCst);
                return Box::pin(async { Err("netlink: Device or resource busy".to_string()) });
            }
            let live = self.0.live.lock().unwrap().clone();
            Box::pin(async move { Ok(live) })
        }
        fn load<'a>(&'a self, text: &'a str) -> super::Boxed<'a, Result<(), String>> {
            Box::pin(async move {
                if self.0.fail.load(SeqCst) {
                    return Err("netlink: Operation not permitted".into());
                }
                self.0.loads.fetch_add(1, SeqCst);
                let table = &text[text.find("table inet lorehouse_sbx {\n").unwrap()..];
                *self.0.live.lock().unwrap() = Some(table.to_string());
                Ok(())
            })
        }
        fn forward_accepts<'a>(&'a self, _: &'a str) -> super::Boxed<'a, Result<bool, String>> {
            Box::pin(async { Ok(false) })
        }
    }
}

#[cfg(test)]
mod tests {
    /// The lines of one chain of `table`.
    fn chain(uplink: &str, slots: usize, name: &str) -> Vec<String> {
        super::chains(&super::table(uplink, slots)).into_iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no chain {name}")).1
    }

    fn at(lines: &[String], line: &str) -> usize {
        lines.iter().position(|x| x == line).unwrap_or_else(|| panic!("missing: {line}\n{lines:#?}"))
    }

    #[test]
    fn a_sandbox_reaches_the_internet_but_not_mail_ports() {
        let forward = chain("enp2s0", 4, "forward");
        let drop_mail = at(&forward, "iifname \"lhtap*\" tcp dport { 25, 465, 587, 2525 } drop");
        // Before anything in the chain could accept it.
        assert!(drop_mail < at(&forward, "oifname \"lhtap*\" ct state established,related accept"));
        // The rules from before are all still there.
        at(&forward, "iifname \"lhtap*\" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } drop");
        at(&forward, "iifname \"lhtap*\" oifname != \"enp2s0\" drop");
        at(&forward, "oifname \"lhtap*\" drop");
        at(&chain("enp2s0", 4, "input"), "iifname \"lhtap*\" drop");
        at(&chain("enp2s0", 4, "post"), "ip saddr 172.30.0.0/24 oifname \"enp2s0\" masquerade");
    }

    #[test]
    fn ipv6_from_a_sandbox_goes_nowhere() {
        // One inet table: every rule sees IPv4 and IPv6. An `ip` table never sees IPv6, which
        // left the host's sshd reachable over a tap's link-local address.
        let table = super::table("enp2s0", 4);
        assert!(table.starts_with("table inet lorehouse_sbx {\n"), "{table}");
        assert_eq!(table.matches("table ").count(), 1);
        let forward = chain("enp2s0", 4, "forward");
        // Through the host: dropped first, before any rule could accept it.
        assert_eq!(forward[0], "type filter hook forward priority -1; policy accept;");
        assert_eq!(forward[1], "iifname \"lhtap*\" meta nfproto ipv6 drop");
        // Into the host: the input drop names no family, so it covers both.
        let input = chain("enp2s0", 4, "input");
        assert_eq!(input[0], "type filter hook input priority -1; policy accept;");
        assert_eq!(input.last().unwrap(), "iifname \"lhtap*\" drop");
    }

    #[test]
    fn a_guest_sends_only_from_its_own_address() {
        let spoof = chain("enp2s0", 3, "spoof");
        // Each tap lets through its own guest's address, and nothing else.
        let own: Vec<usize> = (0..3)
            .map(|i| {
                let slot = super::Slot { index: i };
                at(&spoof, &format!("iifname \"lhtap{i}\" ip saddr {} return", slot.guest_ip()))
            })
            .collect();
        assert_eq!(spoof.len(), 4, "one per slot, then the drop: {spoof:#?}");
        assert_eq!(spoof.last().unwrap(), "counter drop", "the drop ends the chain");
        assert!(own.iter().all(|&i| i < 3));
        // The addresses: slot 2's guest is 172.30.0.10, its tap lhtap2.
        at(&spoof, "iifname \"lhtap2\" ip saddr 172.30.0.10 return");
        // Checked on the way through the host, before anything there accepts...
        let forward = chain("enp2s0", 3, "forward");
        let jump = at(&forward, "iifname \"lhtap*\" jump spoof");
        assert!(jump < at(&forward, "oifname \"lhtap*\" ct state established,related accept"));
        assert!(jump < at(&forward, "iifname \"lhtap*\" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } drop"));
        // ...and into it.
        let input = chain("enp2s0", 3, "input");
        assert!(at(&input, "iifname \"lhtap*\" jump spoof") < at(&input, "iifname \"lhtap*\" drop"));
        // Masquerade is unchanged: only the sandboxes' range, only out of the uplink.
        assert_eq!(chain("enp2s0", 3, "post")[1..], ["ip saddr 172.30.0.0/24 oifname \"enp2s0\" masquerade".to_string()]);
    }

    #[test]
    fn the_table_is_replaced_in_one_transaction() {
        let batch = super::batch("enp2s0", 2);
        // Old table out (this build's and an older build's ip one), new one in: one
        // `nft -f` batch, so a failure anywhere changes nothing.
        let prelude = "table ip lorehouse_sbx {}\ndelete table ip lorehouse_sbx\ntable inet lorehouse_sbx {}\ndelete table inet lorehouse_sbx\n";
        assert_eq!(batch, format!("{prelude}{}", super::table("enp2s0", 2)));
        // Declarations only: no flush, no rule added after the fact.
        for word in ["flush", "add rule", "insert", "nft "] {
            assert!(!batch.contains(word), "{word} in {batch}");
        }
        // Every chain, whole, in the one table.
        let names: Vec<String> = super::chains(&batch).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["spoof", "forward", "input", "post"]);
        // And it is loaded with one nft run, not rule by rule.
        let src = include_str!("net.rs");
        let apply = &src[src.find("async fn apply_locked").unwrap()..];
        let apply = &apply[..apply.find("\n    }\n").unwrap()];
        assert!(apply.contains("self.nft.load(&batch(&self.uplink, self.slots))"), "{apply}");
        assert!(!src.contains(&["for rule in ", "rules("].concat()));
    }

    /// What nft 1.1.7 lists for `table("enp2s0", 2)` (starship, 2026-10-12): its own
    /// spelling of priorities, set order and counters.
    const LISTED: &str = "table inet lorehouse_sbx {
\tchain spoof {
\t\tiifname \"lhtap0\" ip saddr 172.30.0.2 return
\t\tiifname \"lhtap1\" ip saddr 172.30.0.6 return
\t\tcounter packets 0 bytes 0 drop
\t}

\tchain forward {
\t\ttype filter hook forward priority filter - 1; policy accept;
\t\tiifname \"lhtap*\" meta nfproto ipv6 drop
\t\tiifname \"lhtap*\" jump spoof
\t\tiifname \"lhtap*\" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop
\t\tiifname \"lhtap*\" oifname != \"enp2s0\" drop
\t\tiifname \"lhtap*\" tcp dport { 25, 465, 587, 2525 } drop
\t\toifname \"lhtap*\" ct state established,related accept
\t\toifname \"lhtap*\" drop
\t}

\tchain input {
\t\ttype filter hook input priority filter - 1; policy accept;
\t\tiifname \"lhtap*\" jump spoof
\t\tiifname \"lhtap*\" drop
\t}

\tchain post {
\t\ttype nat hook postrouting priority srcnat; policy accept;
\t\tip saddr 172.30.0.0/24 oifname \"enp2s0\" masquerade
\t}
}
";

    #[test]
    fn drift_is_a_change_in_rules_not_in_counters() {
        use super::{drift, normalize, Drift};
        let expected = normalize(LISTED);
        assert_eq!(drift(&expected, Some(LISTED)), Drift::InSync);
        // Counters count, indentation and blank lines vary: still the same table.
        let counted = LISTED.replace("counter packets 0 bytes 0 drop", "counter packets 17 bytes 1428 drop").replace("\n\n", "\n").replace('\t', "  ");
        assert_eq!(drift(&expected, Some(&counted)), Drift::InSync);
        // Flushed, deleted: not there.
        assert_eq!(drift(&expected, None), Drift::Missing);
        // A chain flushed, a rule added in front, a rule changed: changed.
        let flushed = LISTED.replace("\t\tiifname \"lhtap*\" jump spoof\n\t\tiifname \"lhtap*\" drop\n", "");
        assert_eq!(drift(&expected, Some(&flushed)), Drift::Changed);
        let opened = LISTED.replace("policy accept;\n\t\tiifname \"lhtap*\" meta nfproto ipv6 drop", "policy accept;\n\t\tiifname \"lhtap*\" accept\n\t\tiifname \"lhtap*\" meta nfproto ipv6 drop");
        assert_eq!(drift(&expected, Some(&opened)), Drift::Changed);
        assert_eq!(drift(&expected, Some(&LISTED.replace("172.30.0.2 return", "172.30.0.3 return"))), Drift::Changed);
        assert_eq!(drift(&expected, Some(&LISTED.replace("{ 25, 465, 587, 2525 }", "{ 25, 465, 587 }"))), Drift::Changed);
        // nft's listing has the shape of what was declared; a short one doesn't.
        assert!(super::same_shape(&super::table("enp2s0", 2), LISTED));
        assert!(!super::same_shape(&super::table("enp2s0", 2), &flushed));
        assert!(!super::same_shape(&super::table("enp2s0", 3), LISTED));
    }

    #[tokio::test]
    async fn a_flushed_or_changed_table_is_loaded_again_or_boots_stop() {
        use super::fake::{Fake, Shared};
        use std::sync::atomic::Ordering::SeqCst;
        let fake = std::sync::Arc::new(Fake::default());
        let fw = super::Firewall::with("enp2s0", 2, Box::new(Shared(fake.clone())));
        fw.apply().await.unwrap();
        assert_eq!(fake.loads.load(SeqCst), 1);
        // In place: nothing to do.
        fw.ensure().await.unwrap();
        assert_eq!(fake.loads.load(SeqCst), 1);
        // `nft flush ruleset`: loaded again.
        *fake.live.lock().unwrap() = None;
        fw.ensure().await.unwrap();
        assert_eq!(fake.loads.load(SeqCst), 2);
        assert!(fake.live.lock().unwrap().as_deref().unwrap().contains("meta nfproto ipv6 drop"));
        // A rule slipped in ahead of ours: loaded again, the rule gone.
        let tampered = fake.live.lock().unwrap().clone().unwrap().replace("\tchain input {\n", "\tchain input {\n\t\tiifname \"lhtap0\" accept\n");
        *fake.live.lock().unwrap() = Some(tampered);
        fw.ensure().await.unwrap();
        assert_eq!(fake.loads.load(SeqCst), 3);
        assert!(!fake.live.lock().unwrap().as_deref().unwrap().contains("\"lhtap0\" accept"));
        // Gone, and can't be loaded again: an error (no boots, VMs stopped), every time,
        // even once the table looks right again by itself...
        fake.fail.store(true, SeqCst);
        *fake.live.lock().unwrap() = None;
        assert!(fw.ensure().await.is_err());
        *fake.live.lock().unwrap() = Some(super::table("enp2s0", 2));
        assert!(fw.ensure().await.is_err());
        // ...until a load succeeds.
        fake.fail.store(false, SeqCst);
        fw.ensure().await.unwrap();
        fw.ensure().await.unwrap();
        assert_eq!(fake.loads.load(SeqCst), 4);
        // nft failing to list it once: tried again, and in place, nothing to do.
        fake.unreadable.store(1, SeqCst);
        fw.ensure().await.unwrap();
        assert_eq!(fake.loads.load(SeqCst), 4);
        // Failing on and on: not assumed fine, loaded again.
        fake.unreadable.store(3, SeqCst);
        fw.ensure().await.unwrap();
        assert_eq!(fake.loads.load(SeqCst), 5);
        // Shutting down: teardown removes it, nothing puts it back, and no boot passes.
        fw.close().await;
        *fake.live.lock().unwrap() = None;
        assert!(fw.ensure().await.unwrap_err().contains("shutting down"));
        assert_eq!(fake.loads.load(SeqCst), 5);
    }

    /// The batch loaded by the real nft, in a network namespace of its own (as root in a
    /// user namespace, no privileges needed): nft takes it, lists the shape declared, and
    /// a second listing reads as no drift. Skipped where nft or user namespaces aren't
    /// available (it ran on starship, nft 1.1.7).
    #[test]
    fn nft_itself_takes_the_batch() {
        use std::io::Write;
        let script = "nft -f - && nft list table inet lorehouse_sbx";
        let spawned = std::process::Command::new("unshare")
            .args(["-rn", "sh", "-c", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let Ok(mut child) = spawned else {
            eprintln!("skipped: no unshare");
            return;
        };
        child.stdin.take().unwrap().write_all(super::batch("enp2s0", 4).as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() && (stderr.contains("not found") || stderr.contains("Operation not permitted") || stderr.contains("unshare failed")) {
            eprintln!("skipped: {stderr}");
            return;
        }
        assert!(out.status.success(), "nft refused the batch: {stderr}");
        let listing = String::from_utf8_lossy(&out.stdout);
        assert!(super::same_shape(&super::table("enp2s0", 4), &listing), "{listing}");
        assert_eq!(super::drift(&super::normalize(&listing), Some(&listing)), super::Drift::InSync);
        for rule in ["meta nfproto ipv6 drop", "jump spoof", "iifname \"lhtap3\" ip saddr 172.30.0.14 return", "tcp dport { 25, 465, 587, 2525 } drop"] {
            assert!(listing.contains(rule), "{rule} not in {listing}");
        }
    }

    #[tokio::test]
    async fn taps_go_down_together_and_failures_are_reported() {
        use std::sync::Arc;
        let taps = |n: usize| Ok((0..n).map(|i| format!("lhtap{i}")).collect::<Vec<_>>());
        // All at once: each `down` waits for all three to have started, which one after
        // another would never reach.
        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let down = |_tap: String| {
            let b = barrier.clone();
            async move {
                b.wait().await;
                Ok(())
            }
        };
        let together = tokio::time::timeout(std::time::Duration::from_secs(5), super::all_down(taps(3), down)).await.expect("taps went down one after another");
        assert_eq!(together.down.len(), 3);
        assert!(together.errors.is_empty(), "{:?}", together.errors);
        // One that fails is named, and is not confirmed; the others are.
        let r = super::all_down(taps(3), |tap: String| async move { if tap == "lhtap1" { Err("ip: no answer within 10 s".to_string()) } else { Ok(()) } }).await;
        assert!(r.confirmed("lhtap0") && r.confirmed("lhtap2") && !r.confirmed("lhtap1"));
        let errors = r.errors.join("; ");
        assert!(errors.contains("1 of 3") && errors.contains("lhtap1: ip: no answer"), "{errors}");
        // Not listed: none is confirmed down.
        let r = super::all_down(Err("ip: no answer within 10 s".into()), |_: String| async { Ok(()) }).await;
        assert!(r.down.is_empty() && r.errors.join("").contains("couldn't be listed"), "{r:?}");
        assert_eq!(super::all_down(taps(0), |_: String| async { Ok(()) }).await, super::TapsDown::default());
    }

    #[test]
    fn a_failed_forward_listing_is_not_an_absent_chain() {
        use super::forward_listing;
        assert_eq!(forward_listing(true, "table ip filter {", ""), Ok(Some("table ip filter {".to_string())));
        // No Docker (no such table or chain): nothing to keep, nothing wrong.
        assert_eq!(forward_listing(false, "", "Error: No such file or directory\nlist chain ip filter FORWARD\n"), Ok(None));
        // Anything else is an error, so keep_forward_accepts warns instead of passing it.
        let err = forward_listing(false, "", "netlink: Error: cache initialization failed: Operation not permitted\n").unwrap_err();
        assert!(err.contains("Operation not permitted"), "{err}");
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
