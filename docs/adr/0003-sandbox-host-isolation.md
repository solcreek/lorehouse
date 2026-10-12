# ADR 0003: Every sandbox VM runs jailed, on a confined host daemon

Status: proposed, 2026-10-12

## Context

sandboxd (`sandbox/host`) runs model-written code in one Firecracker microVM per
Slack thread. Until now it ran as unrestricted root and started Firecracker directly,
also as root: no chroot, no separate uid, no cgroup limits. The VM boundary was the only
boundary, so a guest that broke out of KVM, or a bug in Firecracker's device emulation,
landed as root on the host.

That boundary is not enough on its own. A KVM guest-to-host escape was confirmed through
Vercel's sandbox bounty on 2026-10-03, with no CVE or patch as of 2026-10-08, and
Firecracker had CVEs of its own in 2026 (CVE-2026-5747, CVE-2026-1386). The maintainer
asked for the host to be hardened on 2026-10-12.

## Decision

1. **sandboxd always runs every VM through Firecracker's `jailer`.** There is no setting
   that turns it off, and sandboxd refuses to start (fails closed) when the jailer is
   missing, its release differs from Firecracker's, its cgroup isn't delegated to it, or
   the VMs' uids belong to an existing user or group. Each VM runs:
   - as its own uid and gid, `SANDBOXD_JAIL_UID_BASE + slot` (one per slot, so two
     running VMs never share one), with no capabilities;
   - chrooted into `<state>/<sandbox>/jail/…/root`, which holds a hard link to its disk,
     a copy of the kernel, its config and its sockets, and is rebuilt from nothing at
     every boot;
   - in its own cgroup under sandboxd's (`Delegate=yes`), with CPU, memory, pids and IO
     limits;
   - with Firecracker's default seccomp filter on.
2. **sandboxd itself runs confined** by `sandboxd.service`: only the capabilities the
   jailer and the network setup need, a read-only file system but its state directory,
   `/dev/kvm` and `/dev/net/tun` only, a system call allow list, and the rest in
   `sandbox/host/README.md` ("Hardening"). `src/service_unit.rs` checks the directives
   in the tests.
3. **No network namespace per VM.** The taps and nftables rules stay in the host's
   namespace, as before.

## Consequences

- A guest that escapes into the VMM process lands as an unprivileged uid that owns
  nothing outside its jail, sees only its jail's files, can't open an IP socket
  (Firecracker's seccomp filter allows `socket()` for `AF_UNIX` only), and is bounded by
  its cgroup. A kernel-level escape (the KVM class) still gets the kernel, and with it
  the host: only a separate machine contains that. The sandbox host should run nothing
  else of value.
- Per slot rather than per VM uid: the range is small and fixed (`SANDBOXD_MAX_VMS`
  ids), and a stopped sandbox's disk goes back to root (after a crash, at that
  sandbox's next boot), and every VM is in its own chroot anyway. The cost: a uid is
  reused across sandboxes over time, never at the same time.
- No network namespace: it would mean a veth pair and a second address plan per VM to
  keep today's "internet, nothing private" rules. What it would add over seccomp's
  `AF_UNIX`-only rule is protection for a VMM that has already escaped its seccomp
  filter, which takes a kernel bug, and then the namespace doesn't hold either.
- No `SANDBOXD_JAILER=off`. Development and tests run the jailer too; outside the unit,
  `systemd-run -p Delegate=yes` gives sandboxd the cgroup it needs. An escape hatch would
  be one environment line away from running production VMs as root.
- The jailer copies the Firecracker binary into each jail. Releases before 1.13.2 /
  1.14.1 follow a link planted at that destination (CVE-2026-1386); sandboxd rebuilds
  each jail from an empty, root-owned directory before the jailer runs, so no VM ever
  had the chance to plant one. Upgrading Firecracker and the jailer together is still
  the fix.
- Hosts need cgroup v2 and systemd's delegation, and the unit's privileges grow
  (`systemd-analyze security`: 2.2 for the unit without the jailer, 3.9 with it). That
  score measures sandboxd; the VMs, which run the untrusted code, went from root with
  every capability to an unprivileged uid with none.
- The unit confines sandboxd less than it did without the jailer. With `CAP_SYS_ADMIN`,
  `@mount` and mount namespaces, sandboxd or any child that keeps its capabilities
  (`ip`, `nft`, `git`) could make a namespace of its own and remount `/` writable, and
  without `ProtectControlGroups` it can write anywhere in the cgroup tree. That matters
  only once sandboxd itself is compromised; the boundary this ADR adds is between a VM
  and sandboxd. Follow-ups: drop all capabilities for `git` and the other children, and
  `ProtectControlGroups=private` (systemd 257+) once the jail's cgroup paths are checked
  under a cgroup namespace.
