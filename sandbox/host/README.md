# sandboxd

The sandbox host: one Firecracker microVM per sandbox id (Lorehouse uses one per Slack
thread). Rust. Work reaches it one of two ways:

- **Runner** (the usual one): it connects out to Lorehouse over WebSocket or long poll
  and asks for work, like a CI runner, so it holds no open port and the sandbox API is
  never on the internet. It works from a data center, a company network or behind NAT.
  Protocol: [`docs/sandbox-runners.md`](../../docs/sandbox-runners.md).
- **Serve**: it serves an HTTP API (`src/sandbox-client.ts`) on loopback, for Lorehouse
  running on the same machine.

- **First use** reflinks the golden rootfs (copy-on-write, milliseconds) and boots it.
- **Idle** VMs are stopped after `SANDBOXD_IDLE_SECS`; the disk is kept, so a thread that
  comes back finds the same checkout.
- **Background jobs** (`POST /jobs`, `GET /jobs/{job}`, `POST /jobs/{job}/cancel` under
  `/v1/sandboxes/{id}`, or the same guest calls through a runner): a command that outlives
  its request, run by guestd in a process group of its own, its output and exit status
  kept on the VM's disk (`sandbox/guest/jobs.go`). A job id runs once: starting it again
  returns that job, so a retried start never runs a second copy. A running job counts as
  activity: an idle VM isn't stopped while guestd says a job runs, for up to
  `SANDBOXD_JOB_HOLD_SECS` after its last request. A job dies with its VM, whatever stops
  it (that hold running out, `DELETE`, sandboxd stopping, the network rules failing
  closed): after an idle stop or a shutdown its status reads `lost`, its output up to then
  kept; after `DELETE` the job is gone with the disk.
- **Stopping** always flushes the guest's disk cache first.
- **Network**: a sandbox reaches the internet and nothing else. There is no route to
  private networks (LAN, tailnet, link-local, other sandboxes), no connection into the
  host, and no mail out (TCP 25, 465, 587, 2525). A packet from a sandbox must carry its own
  address: one forging another sandbox's, or any other, is dropped. No IPv6 either: the guest kernel boots with
  `ipv6.disable=1`, and the host's rules (one `inet` table, so IPv4 and IPv6 alike) drop
  any IPv6 from a tap, into the host or through it. The agent inside, guestd, is reached
  over vsock.

## Needs

A Linux 5.3+ host (pidfds) with KVM, cgroup v2 and systemd (255 or later; run on systemd 255 with Ubuntu 24.04 and a newer one on Arch, 2026-10-16), Firecracker and its `jailer` from the same
release on `PATH`, a guest kernel, and a btrfs or XFS filesystem for the state and golden
files. It runs as root with a few capabilities: it creates taps and nftables rules, and
the jailer builds each VM's chroot before dropping to the VM's own uid. systemd confines
it (see [Hardening](#hardening)).

## Set up

```bash
cargo build --release                                      # → target/release/sandboxd
(cd ../guest && CGO_ENABLED=0 go build -o guestd .)        # the in-VM agent
sudo SOURCE=<ubuntu-rootfs.ext4> GUESTD=../guest/guestd ./prepare-golden.sh /var/lib/lorehouse-golden.ext4
# Settings sandboxd can't make itself under its unit (read-only kernel tunables, no
# module loading): IPv4 forwarding, and the modules its taps and rules use.
sudo install -m 0644 sandboxd.sysctl.conf /etc/sysctl.d/90-lorehouse-sandboxd.conf
sudo install -m 0644 sandboxd.modules.conf /etc/modules-load.d/lorehouse-sandboxd.conf
sudo sysctl --system && sudo systemctl restart systemd-modules-load
```

`/etc/lorehouse/sandboxd.env` (mode 0600):

| env | default | |
|---|---|---|
| `SANDBOXD_APP_URL` | (none) | runner mode: Lorehouse's URL, e.g. `https://lorehouse.example.com`. Must be HTTPS: the runner token travels with every request |
| `SANDBOXD_ALLOW_INSECURE_HTTP` | (off) | `1` allows an `http://` app URL, only for loopback or an already-encrypted private link (e.g. a WireGuard tailnet) in development |
| `SANDBOXD_RUNNER_TOKEN` | (required with `SANDBOXD_APP_URL`, unless the `runner-token` credential is set) | Lorehouse's `SANDBOX_RUNNER_TOKEN`. Deprecated here: pass it as a credential instead ([Tokens](#tokens)) |
| `SANDBOXD_RUNNER_NAME` | the hostname | how Lorehouse knows this host (sandboxes stick to it) |
| `SANDBOXD_TRANSPORT` | `auto` | `ws`, `poll`, or `auto`: WebSocket, falling back to long poll when an upgrade is refused |
| `SANDBOXD_TOKEN` | (required without `SANDBOXD_APP_URL`, unless the `api-token` credential is set) | serve mode: bearer token for every `/v1` request, 32+ characters. Deprecated here, like the runner token |
| `SANDBOXD_GOLDEN` | (required) | the prepared rootfs |
| `SANDBOXD_KERNEL` | (required) | guest kernel image |
| `SANDBOXD_UPLINK` | (required) | the host's internet-facing interface |
| `SANDBOXD_JAILER` `SANDBOXD_FIRECRACKER` | `jailer`, `firecracker` | the binaries, as paths or names on `PATH`; they must be from the same release. Without a jailer sandboxd doesn't start: no setting runs a VM unjailed |
| `SANDBOXD_JAIL_UID_BASE` | `1900000000` | the VM in slot *n* runs as uid and gid base + *n*; sandboxd refuses to start if any of them belongs to a user or group |
| `SANDBOXD_GIT_UID_BASE` | `1900100000` | each run of publishing's git runs as a uid and gid of its own from base + 0..31 ([Publishing's git](#publishings-git)); like the VMs', sandboxd refuses to start if any of them belongs to a user or group, or overlaps the VMs' range |
| `SANDBOXD_GIT_MEM_MIB` | `2048` | the most memory one run of publishing's git may use, no swap (256–65536); past it that run alone is killed. A gc of a mirror near `SANDBOXD_MIRROR_MAX_GIB` may need more |
| `SANDBOXD_NET_RX_MIBPS` `SANDBOXD_NET_TX_MIBPS` | `50`, `10` | per VM, into and out of the guest (MiB/s, 0 = unlimited); see [Limits](#limits) |
| `SANDBOXD_DISK_MIBPS` `SANDBOXD_DISK_IOPS` | `200`, `5000` | per VM, its disk (0 = unlimited) |
| `SANDBOXD_DISK_QUOTA_GIB` | `8` | what one sandbox may write to its disk. Unset: enforced where the state directory can (btrfs with quotas on), else a warning at start; set: enforced or sandboxd won't start; `0`: off. Either way, sandboxes made before quotas were on stay uncapped; `0` doesn't lift a limit already set |
| `SANDBOXD_VM_MEM_HEADROOM_MIB` | `512` | a VM's cgroup memory limit is its RAM plus this (Firecracker itself, and the page cache its disk IO is charged with) |
| `SANDBOXD_NET_CHECK_SECS` | `10` | how often the nftables table is checked against what sandboxd loaded (1–3600); see [Network rules](#network-rules) |
| `SANDBOXD_LISTEN` | `127.0.0.1:8787` | serve mode: where the API listens; keep it on loopback |
| `SANDBOXD_STATE` | `/var/lib/lorehouse-sandboxes` | one directory per sandbox |
| `SANDBOXD_MAX_VMS` | `4` | running at once (1–64); more gets a 503 |
| `SANDBOXD_IDLE_SECS` | `900` | idle time before a VM is stopped |
| `SANDBOXD_JOB_HOLD_SECS` | `21600` | how long after its last request a VM with a running background job is kept from its idle stop (0–604800; 0: jobs don't hold a VM). The guest says whether a job runs, so this caps how long a guest can keep its slot that way; 6 h is guestd's longest job timeout |
| `SANDBOXD_VCPUS` `SANDBOXD_MEM_MIB` | `2`, `2048` | per VM |
| `SANDBOXD_MIRROR_MAX_GIB` | `4` | the most one repo's publish mirror may use; a stage of a repo over it gets a 507 |
| `SANDBOXD_MIRRORS_MAX_GIB` | `24` | the most all mirrors may use; idle ones (over 24 h) are dropped first. New mirrors are made one at a time (a second new repo's stage waits for the first's fetch); existing mirrors growing at once can pass it by what those stages fetch (about 10 KB for a typical stage); a refused stage's bundle is collected by the gc, its refresh stays with the mirror |
| `SANDBOXD_MIRRORS_FREE_PCT` `SANDBOXD_MIRRORS_FREE_GIB` | `10`, `20` | stages are refused (507) while the state directory's filesystem has less free, whichever is larger. On a large shared disk 10% is a lot (93 GiB of 932): lower the percentage there |
| `SANDBOXD_MIRROR_RETENTION_DAYS` | `14` | a mirror is dropped this long after its last stage or push |

### Tokens

The runner token (and serve mode's API token) are best passed as systemd credentials:
a root-only file that systemd hands to sandboxd alone, in `$CREDENTIALS_DIRECTORY`, and
that is never part of any process's environment. A variable in `sandboxd.env` ends up in
sandboxd's environment, readable in `/proc/<pid>/environ` by root for as long as it runs
(sandboxd starts every child with a clean environment, so they don't inherit it).

| credential | file (suggested) | replaces |
|---|---|---|
| `runner-token` | `/etc/lorehouse/sandboxd-runner-token` | `SANDBOXD_RUNNER_TOKEN` |
| `api-token` | `/etc/lorehouse/sandboxd-api-token` | `SANDBOXD_TOKEN` |

sandboxd reads the credential first. The variable still works, with a deprecation
warning at every start; with both set, the credential wins and the warning says the
variable is ignored. To switch a host:

```bash
sudo install -m 0600 /dev/null /etc/lorehouse/sandboxd-runner-token
# write the token into it (from where it is now, never through argv), then
# uncomment LoadCredential=runner-token:/etc/lorehouse/sandboxd-runner-token in
# the unit, remove SANDBOXD_RUNNER_TOKEN from sandboxd.env, and:
sudo systemctl daemon-reload && sudo systemctl restart sandboxd
```

A token rotation then writes that file instead of `sandboxd.env`. The unit ships with
the line commented out: `LoadCredential=` naming a missing file fails the start.

Then install [`sandboxd.service`](sandboxd.service). It creates the default state
directory itself (`StateDirectory=`); with another `SANDBOXD_STATE`, create it and add a
`ReadWritePaths=` for it: sandboxd refuses to start when it can't write there. Keep the
golden, the kernel and the state out of `/home` and `/root` (`ProtectHome=yes`).

**Upgrading a host** from a sandboxd that predates the unit's hardening: install
`sandboxd.sysctl.conf` and `sandboxd.modules.conf` as above *before the next reboot*.
The old sandboxd turned forwarding on at every start, so it is on now and the new one
starts fine (with a warning that nothing sets it at boot); after a reboot it would be
off, and sandboxd refuses to start without it.

On Lorehouse's side, set
`SANDBOX_RUNNER_TOKEN` for runners, or `SANDBOX_URL` and `SANDBOX_TOKEN` for a served
host, plus `GITHUB_TOKEN` for pull requests either way.

[`e2e.ts`](e2e.ts) checks the whole path. It runs Lorehouse in runner mode against the
conformance mock of Slack and the model, waits for a real sandboxd to connect, and asks for
a command only a microVM with internet can answer. Two options test the hard paths:

- `E2E_NO_WS_PROXY=1` puts a proxy in front that strips WebSocket upgrades, so a runner on
  `auto` has to fall back to long poll.
- `E2E_DROP=1` routes the runner through a TCP relay that cuts every connection for 5 s
  in the middle of a 12 s job. The runner must reconnect and deliver the result it
  finished while cut off, and the job must run only once.

## Hardening

The code in a sandbox is model-written, and KVM guest-to-host escapes exist (one was
confirmed through Vercel's sandbox bounty on 2026-10-03, still unpatched a week later:
[The Register](https://www.theregister.com/offbeat/2026/10/06/security-researcher-claims-they-found-kvm-guest-host-escape-flaw/5301267)). So the host is set up assuming a guest may
get out of its VM, and what it lands in should hold as little as possible.

Every VM runs under Firecracker's `jailer` ([ADR 0003](../../docs/adr/0003-sandbox-trust-boundaries.md),
[`src/jail.rs`](src/jail.rs)):

| | |
|---|---|
| user | its slot's own uid and gid (`SANDBOXD_JAIL_UID_BASE` + slot), no capabilities, `NoNewPrivs` |
| files | chrooted into `<state>/<sandbox>/jail/firecracker/lorehouse-<slot>/root`: a hard link to its disk (owned by its uid while it runs, root's again after), a copy of the kernel, its config and sockets. Rebuilt from nothing at every boot, removed at every stop |
| cgroup | `<sandboxd.service>/vms/lorehouse-<slot>`: `cpu.max` its vCPUs + 1, `memory.max` its RAM + `SANDBOXD_VM_MEM_HEADROOM_MIB`, `pids.max` 64, `io.weight` 50 |
| system calls | Firecracker's default seccomp filter (`socket()` for `AF_UNIX` only), on top of the unit's |
| network | its tap, owned by its uid, in the host's namespace with the nftables rules as before (no network namespace: the ADR says why) |

Verified on starship (2026-10-12): the VM's Firecracker had `Uid`/`Gid` 1900000000,
`CapEff` 0, `NoNewPrivs` 1, `Seccomp` 2; its `/proc/<pid>/root` was the jail directory
(same device and inode) holding only `api.sock dev firecracker firecracker.pid rootfs.ext4
run vm.json vmlinux vsock.sock`; its cgroup `…/vms/lorehouse-0` had `cpu.max 300000
100000`, `memory.max 2684354560`, `pids.max 64` (5 in use), `io.weight 50`, and its tap
`user 1900000000 group 1900000000`. Cold boot 4.0 s, as before; after an idle stop the
jail, cgroup and tap were gone, the disk root's again, and the next request booted the
same disk in 0.94 s. With sandboxd SIGKILLed, systemd killed the VM and restarted it in
6 s, disk intact.

### Publishing's git

The `git` that reads what a VM hands over (a stage's bundle, then its objects in the
mirror: verify, describe, push, gc) runs isolated from sandboxd
([`src/gitjail.rs`](src/gitjail.rs), ADR 0003 layer 3), so a git bug a VM's objects reach
gets one repo's mirror and nothing more:

| | |
|---|---|
| user | a uid and gid of its own for each run, from `SANDBOXD_GIT_UID_BASE` + 0..31, back in the pool only once nothing of the run is left. Not 0, not a VM's; sandboxd refuses to start if any of them is a user or group. Two runs at once never share one. No capabilities, `NoNewPrivs`, no core dumps |
| files | its own mount namespace: an empty tmpfs root holding `/usr` (and `/nix/store`, for a Nix-built git) read-only, the merged-usr links, `/etc/ld.so.cache`, `/dev/null`, `zero`, `full`, `random`, `urandom`, a private `/tmp`, and its mirror at `/repo` (no exec), chowned to the run's uid first. No `/etc/lorehouse`, `/run/credentials`, `/proc`, `/sys` or cgroup tree, no other mirror, no sandbox. sandboxd keeps nothing of its own in a mirror (the upkeep state is in `<mirrors>/.upkeep`), writes there only new files, and reads there without following a link, waiting on a FIFO or reading past a cap (`src/publish.rs`, "What sandboxd reads in a mirror") |
| network | its own network namespace, with nothing in it. A run that fetches from or pushes to GitHub gets one whose only address is a listener sandboxd serves (`http://127.0.0.1:<port>/<owner>/<name>.git`): sandboxd forwards that repo's upload-pack (fetch) or receive-pack (push) to GitHub, nothing else, and adds the token itself ([`src/publish/remote.rs`](src/publish/remote.rs)). No git process ever holds a token. A push may send only the one update its stage recorded, `<old> <staged sha> refs/heads/<branch>`, where sandboxd read `<old>` from GitHub itself and checked the push is a fast-forward from it (refusing, and dropping, a mirror with grafts, a shallow file, alternates or replace refs). A run's proxy takes at most 4 connections at once (one more is closed), and all runs' request bodies share 256 MiB in sandboxd (a request past it gets a 503) |
| IPC | its own IPC namespace: no SysV or POSIX IPC object outlives its run |
| cgroup | `<sandboxd.service>/git/u<uid>`, beside `vms/`, `pids.max` 512, `memory.max` `SANDBOXD_GIT_MEM_MIB` with no swap and `memory.oom.group` 1 (at the limit the run alone is killed, never sandboxd or a VM); killed whole (`cgroup.kill`) once the run is over, however it ended, so a process that left git's process group (`setsid`) is gone too before the uid or the mirror's lock is released |

None of it can be turned off: at start, sandboxd runs `git version` through all of it and
refuses to start if that fails, and a run that can't be set up doesn't run.

Verified on the lab (GCE `n4-standard-16`, Ubuntu 24.04, systemd 255, git 2.43, 2026-10-16),
the repo's unit, a stage from a real VM against github.com (a public repo, no token), then a
stage and push against a local smart-HTTP remote with made-up tokens, every git process
polled every 2 ms: all 16 seen had uid and gid 1900100000, `CapEff` and `CapPrm` 0,
`NoNewPrivs` 1, cgroup `…/sandboxd.service/git/u1900100000`, mount and network namespaces
not the host's, a root of only `bin dev etc lib lib64 repo sbin tmp usr`, an `/etc` of only
`ld.so.cache`, no `/proc`, and no token or `Authorization` in its environment. During the
push, its network namespace had only `lo` and sandboxd's listener; 1.1.1.1 was unreachable
and so was the host's loopback. The remote got the read token on upload-pack and the write
token on receive-pack, from sandboxd. From git's uids on the host, writing another mirror, a
sandbox's disk, `vms/cgroup.procs` or `git/cgroup.procs` was refused, and so was signalling
sandboxd. `isolated_git_as_root` (`cargo test -- --ignored`, as root in a
`systemd-run --scope -p Delegate=yes`, and under the unit's own confinement) passes there:
a `setsid` escapee is gone when its run returns, and two runs at once had different uids.

[`sandboxd.service`](sandboxd.service) confines sandboxd and every process it starts
(the jailer and Firecracker, `ip`, `nft`, `git`):

| | |
|---|---|
| capabilities | `CAP_NET_ADMIN` (taps, nftables), and for the jailer `SYS_ADMIN`, `SYS_CHROOT`, `MKNOD`, `CHOWN`, `SETUID`, `SETGID`; `DAC_OVERRIDE` and `KILL` to reach into and stop a jailed VM; `NoNewPrivileges=yes`. `git`, which reads what a VM hands over, runs with none of them, as a uid of its own ([above](#publishings-git)) |
| environment | every process sandboxd starts begins from a clean environment, `PATH` and `LC_ALL=C` and nothing inherited ([`src/child.rs`](src/child.rs)), so none of them, the jailer and Firecracker above all, inherits `SANDBOXD_RUNNER_TOKEN` or `SANDBOXD_TOKEN`; a test fails a spawn that bypasses it. A caller adds only what its tool needs on top: `git` gets its own `HOME` and `GIT_*` settings, and never a token: sandboxd adds that request's short-lived token to what it forwards to GitHub ([`src/publish.rs`](src/publish.rs)) |
| file system | read-only (`ProtectSystem=strict`) but the state directory; no `/home` or `/root`; private `/tmp` |
| devices | `/dev/kvm` and `/dev/net/tun`, beyond the standard pseudo-devices (`DevicePolicy=closed`; `ProtectClock` adds read access to the RTC), plus making nodes of those, `/dev/userfaultfd` and `/dev/urandom` in a jail |
| sockets | `AF_UNIX` (vsock, API), `AF_INET`/`AF_INET6` (Lorehouse, GitHub), `AF_NETLINK` (ip, nft) |
| cgroups | delegated (`Delegate=yes`): sandboxd moves itself to `supervisor/`, each VM gets a cgroup under `vms/` and each run of publishing's git one under `git/`. sandboxd refuses to start without the delegation. The whole cgroup tree is writable to it (no `ProtectControlGroups`), and with the jailer's `SYS_ADMIN` and `@mount` it could remount `/` in a namespace of its own: this confines sandboxd against mistakes, not against itself being compromised (ADR 0003) |
| kernel | tunables, modules, logs, clock and hostname read-only or out of reach; `@system-service` and `@mount` system calls only; no W+X memory, no namespaces but mount, network and IPC (the jailer's, and git's), no realtime, no set-uid files |
| stop | `KillMode=mixed`: only sandboxd gets the SIGTERM and stops each VM after the guest's sync. Firecracker dies on SIGTERM, so the default (`control-group`) killed every VM before its disk cache was flushed |

Because of that, the host sets up two things sandboxd used to do itself:
`net.ipv4.ip_forward=1` ([`sandboxd.sysctl.conf`](sandboxd.sysctl.conf); sandboxd checks
it at start and refuses to run without it) and the modules for taps and nftables
([`sandboxd.modules.conf`](sandboxd.modules.conf)).

`systemd-analyze security --offline=yes sandboxd.service` (systemd 261, 2026-10-12):
**9.4 UNSAFE** for the unit before any of this, **2.2 OK** confined, **3.9 OK** with the
jailer's privileges added; letting it make network and IPC namespaces for git
(`RestrictNamespaces=mnt net ipc`, #143) costs 0.2 more: 3.9 → 4.1 (systemd 261, starship,
2026-10-17; `mnt net` alone was 4.0 there and on the lab's systemd 255). That score measures sandboxd; the VMs, which run the untrusted
code, went from root with every capability to an unprivileged uid with none. What counts
against it is what the job needs: root, the jailer's capabilities and `@mount`, a
delegated cgroup, the host's network, `/dev/kvm`, internet and netlink sockets. Cargo
tests parse the unit (`src/service_unit.rs`), so dropping one of the directives they check fails CI.

Verified on starship (2026-10-12, Firecracker 1.10.1, systemd 261): VMs boot under the
unit (jailed, above) and reach GitHub. Without the jail, the same unit's confined
Firecracker had `CapEff` `CAP_NET_ADMIN` only, `NoNewPrivs` 1 and `Seccomp` 2. A file the
guest wrote just before `systemctl stop` (not yet flushed) was there after the next boot;
with `KillMode=control-group` it was lost.

## Network rules

One nftables table, `inet lorehouse_sbx` ([`net.rs`](src/net.rs)), so every rule covers
IPv4 and IPv6:

| chain | |
|---|---|
| `spoof` | from tap *n*, only slot *n*'s guest address gets through; anything else is counted and dropped |
| `forward` (priority -1, before Docker's) | from a tap: IPv6 dropped (guests have none), then the source check, private destinations (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16), anything but the uplink, and mail ports (TCP 25, 465, 587, 2525) dropped; to a tap: only replies (`ct state established,related`) |
| `input` (priority -1) | nothing from a tap reaches the host, IPv4 or IPv6 (spoofed sources counted first) |
| `post` | masquerade of 172.30.0.0/24 out of the uplink |

The table is loaded as one `nft -f`
transaction: the old one (or an older build's `ip lorehouse_sbx`) is deleted and the new
one added together, or nothing changes.

The guest kernel boots with `ipv6.disable=1`, and the host's side of each tap gets no
IPv6 address either (`addrgenmode none`).

The host is shared, so the table is checked against what sandboxd loaded every
`SANDBOXD_NET_CHECK_SECS` (10 s) and before every boot: an `nft flush ruleset`, a deleted
table or a rule added to it is noticed, logged (`ALERT: nftables table inet lorehouse_sbx
is gone …; loading it again`) and the table loaded again, along with sandboxd's accepts in
Docker's FORWARD chain if those went too. If it can't be loaded, sandboxd fails closed:
every tap goes down at once, every running VM is stopped, and none boots until a later
check loads it. A VM whose tap is confirmed down is stopped gracefully (its guest syncs
first); one whose tap can't be confirmed down is killed at once through its pidfd, without
a sync, and logged: isolation comes before its disk only there. sandboxd keeps running,
refusing boots, so the runner reports the state. Between a flush and the next check (up to `SANDBOXD_NET_CHECK_SECS`)
running guests are unfiltered; a smaller value narrows that, at one `nft list` per check.
Every `nft` and `ip` run is cut off after 10 s, so a hung one can't stall the checks. An
nft upgrade that lists the same rules differently shows up as one ALERT and one reload,
not as a loop.

## Limits

What one sandbox can take from the host and send to the internet, each per VM:

- **Rates** (Firecracker's rate limiters, [`vm.rs`](src/vm.rs) `vm_config`): its network
  at 50 MiB/s in and 10 MiB/s out, its disk at 200 MiB/s and 5000 operations/s, each with
  a one-time burst of five seconds' worth for the boot and the start of a clone. 50 MiB/s
  in is above what GitHub gave starship (4.5–22 MB/s), so a clone is no slower; 10 MiB/s
  out bounds what a flood from a sandbox can send. Packets per second are not limited.
- **Mail**: TCP 25, 465, 587 and 2525 (the alternative submission port mail services
  offer) out are dropped (the nftables table in [`net.rs`](src/net.rs)). Spam from a
  sandbox would get the host's address blocklisted. The table is `inet`, so this holds for
  IPv6 too, though a guest has none.
- **Disk**: a sandbox's disk is a reflink of the golden, so it costs only what the guest
  writes, and that is capped at `SANDBOXD_DISK_QUOTA_GIB` (8 GiB). A write past it fails:
  the guest sees I/O errors on its disk, and ext4 may abort its journal and go read-only
  until the next boot (in the run below, guestd kept answering and small writes still
  worked). [`quota.rs`](src/quota.rs). Booting a sandbox that is already full wasn't
  tried: the jail's kernel and Firecracker copies are reflinks when they sit on the same
  filesystem as the state, so they shouldn't count, but `vm.json` and the console log do.
  - **btrfs** (what sandboxd sets up): each new sandbox directory is a subvolume with a
    limit on its exclusive bytes (`btrfs qgroup limit -e`), so what it shares with the
    golden doesn't count. It needs quotas on for the state directory's filesystem,
    once: `sudo btrfs quota enable --simple <mount>`. Only simple quotas (kernel 6.7+)
    are used: they are cheap, and an extent counts against whoever wrote it for good.
    Under full qgroups "exclusive" is recomputed as sharing changes, so replacing the
    golden would put every sandbox over its limit at once; sandboxd treats full qgroups
    like quotas off (`btrfs quota status` tells which). Note
    that quotas are per filesystem: on a host whose state directory shares one btrfs with
    everything else, that turns them on for all of it. A sandbox made before quotas were
    on isn't a subvolume and stays uncapped (it says so when it boots). When `btrfs quota
    status` says `Inconsistent: yes` (the accounting is off; for simple quotas a rescan may not be possible, only disabling and re-enabling them; unverified), the default limit is
    still set, with a warning, and an explicit `SANDBOXD_DISK_QUOTA_GIB` refuses the
    start. What the kernel does with a limit while simple-quota accounting is
    inconsistent is not verified. Quotas are not enabled on starship: its state shares the
    root btrfs, and enabling them there was decided against (2026-10-12).
  - **XFS**: project quotas are the tool, and sandboxd doesn't set them up. As far as we
    know XFS charges a reflinked file for every block it maps, shared or not, so the hard
    limit has to be the golden's size plus the cap. By hand: mount with `prjquota`, then
    per sandbox directory
    `xfs_quota -x -c 'project -s -p <dir> <id>' -c 'limit -p bhard=<golden + cap> <id>' <mount>`
    (not tried: no XFS host was at hand).
  - Anywhere else, or with quotas off, sandboxd starts with a warning and no cap, unless
    `SANDBOXD_DISK_QUOTA_GIB` was set explicitly: then it refuses to start.
  The console log sits in the sandbox's directory, so it counts against the cap too.

Verified on starship (2026-10-12; the disk quota on a scratch btrfs with simple quotas,
since starship's own has quotas off):

| | |
|---|---|
| default limits, `git clone expressjs/express` + `npm install` (304 packages) | 7.8 s + 47.9 s; with every rate limit off, 6.4 s + 49.3 s. `sveltejs/svelte` (129 MB) cloned in 34 s, at GitHub's pace that afternoon |
| limits set to 2 / 1 / 5 MiB/s (rx / tx / disk), after the burst | downloads at 2.04 MB/s, uploads at 1.02 MB/s, disk writes at 5.0 MB/s |
| mail | `smtp.gmail.com` 465 and 587 refused from the guest, open from the host |
| still blocked | the LAN gateway, the Pi-hole, the host (LAN and tap addresses), two tailnet peers, 169.254.169.254; GitHub and npm reachable |
| disk quota 2 GiB | a guest `dd` of 3000 MiB stopped at 2008 MiB with I/O errors on its disk; the host's qgroup read 2.00 GiB of 2.00 GiB; guestd still answered; `DELETE` removed the subvolume |

## Measured

On a Ryzen 7 8745HS with btrfs, using a 22 GB Ubuntu 24.04 CI image as the golden
(2026-09-28):

| | |
|---|---|
| cold boot to the first command done | ~4.0 s |
| boot again after an idle stop (disk kept, page cache warm) | 0.8 s |
| command on a running VM | 22 ms |
| golden prepared (reflink + guestd) | 0.13 s |
| end to end, runner mode: "Slack" mention → command in a cold microVM → answer | 4.6 s over WebSocket, 4.7 s over long poll |
| every connection cut for 5 s during a 12 s job | the result still arrived after the reconnect, the job ran once: 16.1 s over WebSocket and over long poll |

The end-to-end run (2026-09-28) connected the runner over the tailnet to a Lorehouse on
another machine. The command's output came from the microVM itself: 2 vCPUs, its own
kernel, git, and GitHub reachable. Behind a proxy that strips WebSocket upgrades, `auto`
got a 426 and fell back to long poll.

The acceptance run also covered:

- **Allowed:** internet (GitHub 200, DNS).
- **Blocked:** the LAN gateway, the host and the tailnet.
- **Work:** clone, write and read a file.
- **Limits:** capacity (503), a bad id (400), no token (401).
- **Lifecycle:** idle stop with the disk kept, and a clean shutdown that leaves no rules or processes behind.
