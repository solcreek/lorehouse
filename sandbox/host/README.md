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
- **Stopping** always flushes the guest's disk cache first.
- **Network**: a sandbox reaches the internet and nothing else. There is no route to
  private networks (LAN, tailnet, link-local, other sandboxes), no connection into the
  host, and no mail out (TCP 25, 465, 587). No IPv6 either: the guest kernel boots with
  `ipv6.disable=1`, and the host's rules (one `inet` table, so IPv4 and IPv6 alike) drop
  any IPv6 from a tap, into the host or through it. The agent inside, guestd, is reached
  over vsock.

## Needs

A Linux 5.3+ host (pidfds) with KVM, cgroup v2 and systemd, Firecracker and its `jailer` from the same
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
| `SANDBOXD_RUNNER_TOKEN` | (required with `SANDBOXD_APP_URL`) | Lorehouse's `SANDBOX_RUNNER_TOKEN` |
| `SANDBOXD_RUNNER_NAME` | the hostname | how Lorehouse knows this host (sandboxes stick to it) |
| `SANDBOXD_TRANSPORT` | `auto` | `ws`, `poll`, or `auto`: WebSocket, falling back to long poll when an upgrade is refused |
| `SANDBOXD_TOKEN` | (required without `SANDBOXD_APP_URL`) | serve mode: bearer token for every `/v1` request, 32+ characters |
| `SANDBOXD_GOLDEN` | (required) | the prepared rootfs |
| `SANDBOXD_KERNEL` | (required) | guest kernel image |
| `SANDBOXD_UPLINK` | (required) | the host's internet-facing interface |
| `SANDBOXD_JAILER` `SANDBOXD_FIRECRACKER` | `jailer`, `firecracker` | the binaries, as paths or names on `PATH`; they must be from the same release. Without a jailer sandboxd doesn't start: no setting runs a VM unjailed |
| `SANDBOXD_JAIL_UID_BASE` | `1900000000` | the VM in slot *n* runs as uid and gid base + *n*; sandboxd refuses to start if any of them belongs to a user or group |
| `SANDBOXD_NET_RX_MIBPS` `SANDBOXD_NET_TX_MIBPS` | `50`, `10` | per VM, into and out of the guest (MiB/s, 0 = unlimited); see [Limits](#limits) |
| `SANDBOXD_DISK_MIBPS` `SANDBOXD_DISK_IOPS` | `200`, `5000` | per VM, its disk (0 = unlimited) |
| `SANDBOXD_DISK_QUOTA_GIB` | `8` | what one sandbox may write to its disk. Unset: enforced where the state directory can (btrfs with quotas on), else a warning at start; set: enforced or sandboxd won't start; `0`: off. Either way, sandboxes made before quotas were on stay uncapped; `0` doesn't lift a limit already set |
| `SANDBOXD_VM_MEM_HEADROOM_MIB` | `512` | a VM's cgroup memory limit is its RAM plus this (Firecracker itself, and the page cache its disk IO is charged with) |
| `SANDBOXD_LISTEN` | `127.0.0.1:8787` | serve mode: where the API listens; keep it on loopback |
| `SANDBOXD_STATE` | `/var/lib/lorehouse-sandboxes` | one directory per sandbox |
| `SANDBOXD_MAX_VMS` | `4` | running at once (1–64); more gets a 503 |
| `SANDBOXD_IDLE_SECS` | `900` | idle time before a VM is stopped |
| `SANDBOXD_VCPUS` `SANDBOXD_MEM_MIB` | `2`, `2048` | per VM |
| `SANDBOXD_MIRROR_MAX_GIB` | `4` | the most one repo's publish mirror may use; a stage of a repo over it gets a 507 |
| `SANDBOXD_MIRRORS_MAX_GIB` | `24` | the most all mirrors may use; idle ones (over 24 h) are dropped first. New mirrors are made one at a time (a second new repo's stage waits for the first's fetch); existing mirrors growing at once can pass it by what those stages fetch (about 10 KB for a typical stage); a refused stage's bundle is collected by the gc, its refresh stays with the mirror |
| `SANDBOXD_MIRRORS_FREE_PCT` `SANDBOXD_MIRRORS_FREE_GIB` | `10`, `20` | stages are refused (507) while the state directory's filesystem has less free, whichever is larger. On a large shared disk 10% is a lot (93 GiB of 932): lower the percentage there |
| `SANDBOXD_MIRROR_RETENTION_DAYS` | `14` | a mirror is dropped this long after its last stage or push |

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

Every VM runs under Firecracker's `jailer` ([ADR 0003](../../docs/adr/0003-sandbox-host-isolation.md),
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

[`sandboxd.service`](sandboxd.service) confines sandboxd and every process it starts
(the jailer and Firecracker, `ip`, `nft`, `git`):

| | |
|---|---|
| capabilities | `CAP_NET_ADMIN` (taps, nftables), and for the jailer `SYS_ADMIN`, `SYS_CHROOT`, `MKNOD`, `CHOWN`, `SETUID`, `SETGID`; `DAC_OVERRIDE` and `KILL` to reach into and stop a jailed VM; `NoNewPrivileges=yes`. `git`, which reads what a VM hands over, runs with none of them (dropped between fork and exec) |
| environment | every process sandboxd starts gets `PATH` and `LC_ALL=C` and nothing else ([`src/child.rs`](src/child.rs)), so none of them, the jailer and Firecracker above all, inherits `SANDBOXD_RUNNER_TOKEN` or `SANDBOXD_TOKEN`; a test fails a spawn that bypasses it |
| file system | read-only (`ProtectSystem=strict`) but the state directory; no `/home` or `/root`; private `/tmp` |
| devices | `/dev/kvm` and `/dev/net/tun`, beyond the standard pseudo-devices (`DevicePolicy=closed`; `ProtectClock` adds read access to the RTC), plus making nodes of those, `/dev/userfaultfd` and `/dev/urandom` in a jail |
| sockets | `AF_UNIX` (vsock, API), `AF_INET`/`AF_INET6` (Lorehouse, GitHub), `AF_NETLINK` (ip, nft) |
| cgroups | delegated (`Delegate=yes`): sandboxd moves itself to `supervisor/` and each VM gets a cgroup under `vms/`. sandboxd refuses to start without the delegation. The whole cgroup tree is writable to it (no `ProtectControlGroups`), and with the jailer's `SYS_ADMIN` and `@mount` it could remount `/` in a namespace of its own: this confines sandboxd against mistakes, not against itself being compromised (ADR 0003) |
| kernel | tunables, modules, logs, clock and hostname read-only or out of reach; `@system-service` and `@mount` system calls only; no W+X memory, no namespaces but mount, no realtime, no set-uid files |
| stop | `KillMode=mixed`: only sandboxd gets the SIGTERM and stops each VM after the guest's sync. Firecracker dies on SIGTERM, so the default (`control-group`) killed every VM before its disk cache was flushed |

Because of that, the host sets up two things sandboxd used to do itself:
`net.ipv4.ip_forward=1` ([`sandboxd.sysctl.conf`](sandboxd.sysctl.conf); sandboxd checks
it at start and refuses to run without it) and the modules for taps and nftables
([`sandboxd.modules.conf`](sandboxd.modules.conf)).

`systemd-analyze security --offline=yes sandboxd.service` (systemd 261, 2026-10-12):
**9.4 UNSAFE** for the unit before any of this, **2.2 OK** confined, **3.9 OK** with the
jailer's privileges added. That score measures sandboxd; the VMs, which run the untrusted
code, went from root with every capability to an unprivileged uid with none. What counts
against it is what the job needs: root, the jailer's capabilities and `@mount`, a
delegated cgroup, the host's network, `/dev/kvm`, internet and netlink sockets. Cargo
tests parse the unit (`src/service_unit.rs`), so dropping one of the directives they check fails CI.

Verified on starship (2026-10-12, Firecracker 1.10.1, systemd 261): VMs boot under the
unit (jailed, above) and reach GitHub. Without the jail, the same unit's confined
Firecracker had `CapEff` `CAP_NET_ADMIN` only, `NoNewPrivs` 1 and `Seccomp` 2. A file the
guest wrote just before `systemctl stop` (not yet flushed) was there after the next boot;
with `KillMode=control-group` it was lost.

## Limits

What one sandbox can take from the host and send to the internet, each per VM:

- **Rates** (Firecracker's rate limiters, [`vm.rs`](src/vm.rs) `vm_config`): its network
  at 50 MiB/s in and 10 MiB/s out, its disk at 200 MiB/s and 5000 operations/s, each with
  a one-time burst of five seconds' worth for the boot and the start of a clone. 50 MiB/s
  in is above what GitHub gave starship (4.5–22 MB/s), so a clone is no slower; 10 MiB/s
  out bounds what a flood from a sandbox can send. Packets per second are not limited.
- **Mail**: TCP 25, 465 and 587 out are dropped (the nftables table in
  [`net.rs`](src/net.rs)). Spam from a sandbox would get the host's address blocklisted.
  The table is `inet`, so this holds for IPv6 too, though a guest has none. Other ports
  (2525) stay open.
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
