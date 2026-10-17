# ADR 0003: Sandbox trust boundaries, from the guest out

Status: proposed, 2026-10-16. Rewritten from the 2026-10-12 version, "Every sandbox VM
runs jailed, on a confined host daemon" (in git history). Its decisions are kept as
layer 2 and part of layer 3. What it left out is added: the guest's trust model, the
host as a boundary, the egress channel #110 needs, and isolation between tenants.

## Context

sandboxd (`sandbox/host`) runs model-written code in one Firecracker microVM per
sandbox (one per Slack thread today). The 2026-10-12 version of this ADR decided how a
VM is contained on its host: the jailer, a confined daemon, and the network rules. Four
days of building on it showed that it was right about what it covered, but it covered
too little:

- **No trust model for the guest.** Whether guestd's inputs are a vulnerability was argued
  per review finding. CodeQL flagged path and command injection in guestd, and #141
  proposes storing job ownership in guestd. Both need a stated rule about what the guest
  may be trusted with.
- **An unmet precondition.** The old text said "the sandbox host should run nothing else
  of value", but starship, the one production host, is a shared development machine. It
  runs other agents with password-less sudo, Docker, and the runner token. Nothing said
  whether that is allowed.
- **Planned work crosses its rules.** #110's egress proxy needs a path from the guest to
  something on the host, which the network rules forbid. A hosted, multi-tenant
  Lorehouse needs isolation between tenants, which it never mentioned.
- **Hardware-level controls were missing.** Nested virtualization (enabled on starship,
  `kvm_amd nested=1`, 2026-10-16), the CPU features exposed to guests, and SMT existed
  only in issues and chat.

Facts this ADR relies on:
- A KVM guest-to-host escape was confirmed through Vercel's sandbox bounty on
  2026-10-03, with no CVE or patch as of 2026-10-08.
- Firecracker had CVEs of its own in 2026 (CVE-2026-5747, CVE-2026-1386).
- On a GCE `n4-standard-16` with nested virtualization, a sandbox cold-boots in 2.4 s
  against 0.82 s on bare metal, and 64 boot at once (`sandbox/lab/README.md`,
  2026-10-16).

## Decision

Five layers. Each says what it trusts, what it must hold against the layer inside it,
and what exists today. A layer never relies on an inner one for its own safety.

### Layer 1: the guest is the attacker

**Everything in the VM is under the model's control:** the kernel's userland, guestd, the
repo's dependencies, and whatever an indexed Slack thread talked the model into.
**guestd is a convenience, not a boundary**: it runs as root in the guest and does what
it's asked.

- **Inputs to guestd are not a vulnerability.** guestd runs commands, reads and writes
  files, and keeps job records, all as the guest. Path or command "injection" into
  guestd gives the caller nothing it doesn't already have. Code-scanning alerts of
  those classes in `sandbox/guest` are dismissed with a link to this section. The rules
  stay on, and every new alert is still read, because a guestd bug that matters is one
  that touches the *host's* side of a channel.
- **Anything that comes out of the guest is data, never authority.** That covers command
  output, files, job status and records, the console log, timing and git bundles.
  - The host never authorizes, attributes or publishes from a claim the guest makes.
  - Publishing already works this way: the host verifies a bundle in its own mirror and
    computes the diff, files and authors itself (#31, #32).
  - A guest-held fact may decide only something the guest could do to itself anyway.
    For example, who may cancel a job (#141): the guest can kill its own processes, so
    lying about who started one grants nothing.
- **Nothing secret goes in** (ADR 0004): no token in the environment, the disk, the golden
  or a snapshot. Credentials a guest needs are added on the wire (layer 3).
  - Exception: the short-lived read token clone and fetch use today, until #110.
  - Exception: dev-mode `GITHUB_TOKEN` (#77).

### Layer 2: the VMM is jailed

This layer is kept from the 2026-10-12 decision, unchanged.

- **Every VM runs through Firecracker's `jailer`**, with no setting to turn it off.
  sandboxd fails closed when the jailer is missing, comes from another release than
  Firecracker's, or isn't given its delegated cgroup, and when the VMs' uids belong to
  an existing user or group.
- **How each VM runs:**
  - as its slot's own uid and gid (`SANDBOXD_JAIL_UID_BASE + slot`), with no
    capabilities;
  - chrooted into a jail rebuilt from an empty, root-owned directory at every boot;
  - in its own cgroup (CPU, memory, pids, IO);
  - with Firecracker's seccomp filter on, which allows `socket()` for `AF_UNIX` only.
- **What an escape into the VMM gets:** an unprivileged uid that owns nothing outside its
  jail and can't open an IP socket.

### Layer 3: sandboxd and the channels a guest can reach

sandboxd runs confined by `sandboxd.service`, as before. It has only the capabilities the
jailer and the network setup need, sees a read-only file system except its state
directory, reaches only `/dev/kvm` and `/dev/net/tun`, and runs under a system call allow
list. `src/service_unit.rs` checks these directives. Every process it starts gets a clean
environment. Tokens come as systemd credentials.

**This confinement doesn't contain sandboxd itself once it's compromised.** The jailer
needs `CAP_SYS_ADMIN`, `@mount` and mount namespaces, and the delegated cgroup tree is
writable, so sandboxd, or any child that keeps its capabilities (`ip`, `nft`), could
make a namespace of its own and remount `/` writable (`sandbox/host/README.md`,
"Hardening"). The boundary this layer adds is between a VM and sandboxd. It isn't
around sandboxd. So:
- **Every child that reads what a VM produced runs with no capabilities and
  `no_new_privs`.** Today that's `git`, which verifies a VM's bundles in the publishing
  mirror (`publish.rs`, `jail::drop_capabilities`). A git bug reached through a bundle
  gets root's file ownership in the state directory, not the jailer's privileges.
- **Any new child that parses guest output follows the same rule.** The other children
  keep the capabilities they need.
- Follow-ups: drop capabilities from every child that doesn't need them, and
  `ProtectControlGroups=private` (systemd 257+) once the jail's cgroup paths are checked
  under a cgroup namespace.

**A guest reaches exactly two things, and each one is a channel sandboxd parses as
hostile input:**

1. **guestd's vsock, host to guest only.** sandboxd connects in; the guest has no listener
   on the host. The host side of this channel is the security-relevant parser: response
   sizes are bounded by the host, which caps every guestd response body at 64 MiB
   (`vsock.rs`) whatever guestd claims. guestd's own limits (16 MiB per file, 4 MiB per
   output stream) are layer 1 behaviour: useful defaults, never a bound the host relies
   on. Every answer is treated as layer 1 data.
2. **The internet, through the uplink, and nothing else.**
   - Private ranges, the host, other sandboxes, IPv6 and outbound mail (TCP 25, 465, 587,
     2525) are dropped.
   - There is one `inet` table, loaded in one transaction and checked against what was
     loaded every 10 s and before every boot. It fails closed (taps down, VMs stopped)
     when it can't be put back.
   - A packet must carry its slot's own address.
   - This is the 2026-10-12 addendum, kept. Known gaps are in #106: a few special ranges,
     hairpin through the router, and the flush window.

**#110's egress proxy goes over vsock, guest to host, not over IP.**
- Firecracker forwards a guest-initiated vsock connection on port N to a Unix socket
  (`<uds>_N`) inside that VM's jail.
- sandboxd listens there per VM, so the proxy knows which sandbox is calling without
  trusting anything the guest says.
- It enforces the sandbox's egress allowlist and adds the credentials its profile was
  granted.
- In the guest, a small forwarder (part of guestd) offers `HTTP(S)_PROXY` on loopback.
- Over IP, the guest stays unable to reach the host. A proxy on the tap address, or a
  network namespace per VM, was rejected: it would reopen exactly the guest-to-host IP
  path the rules close.
- Once the allowlist is on, direct internet from the guest goes away, and all egress is
  through the proxy.

There is still no network namespace per VM. The reason holds: it would protect only a
VMM that has already escaped seccomp, which takes a kernel bug, and then the namespace
doesn't hold either.

### Layer 4: the host is disposable, or holds nothing of value

A guest-to-host kernel escape (the KVM class) defeats layers 2 and 3. Only the host
being worthless to an attacker contains it. A host that runs sandboxd for anyone must:

- **Run nothing else of value.** No other services, agents, Docker, development
  checkouts, or users with standing sudo.
- **Hold no long-lived secret but the runner token.** That token is a systemd credential,
  and per runner once #96 lands. Publishing tokens are short-lived and minted per push
  by Lorehouse (ADR 0004).
- **Give guests no nested virtualization.**
  - The host's KVM module loads with `nested=0`.
  - Guests get a CPU template that hides VMX/SVM.
  - A guest's `/proc/cpuinfo` shows neither. sandboxd checks the module parameter at
    start and refuses `nested=1` (fails closed, like the jailer).
- **Be replaceable from code**, with no hand-made state. That means a bare-metal host
  from the fleet's provisioning (ansible) or a cloud VM made by `sandbox/lab/lab.sh`'s
  successor.

Two kinds of host meet this:
- **A dedicated machine**, bare metal: the fastest.
- **A disposable cloud VM running sandboxd under nested virtualization** (the "L1"). Its
  own hypervisor (the cloud's) is a second hardware boundary. A KVM escape lands in an
  L1 that holds only the runner token and can be deleted. Measured on GCE: 2.4 s cold
  boot.

**starship is the one exception, and only for the maintainer's own use.** It's a shared
development machine, so it fails this layer. It may keep serving the maintainer's own
workspace, on these terms:
- The trade is written down here.
- `nested=0` and the CPU template are still required on it.
- It never serves a second tenant.
- Moving off it is the plan, not a someday.

### Layer 5: tenants never share what they can affect

Before Lorehouse runs sandboxes for more than one workspace on one host, each of these
must hold. Until all of them do, a host serves one tenant.

- **Mirrors are keyed by tenant.** Today they are keyed by `owner/name` only.
- **Memory is checked against the host's free memory before a boot.** Overcommit stays at
  or below 1.25×. That is an estimate from the 2026-10-14 capacity study, not a
  measurement; the study expects 1.5× to get VMs OOM-killed. The lab measures it before
  anyone relies on it.
- **SMT is off**, or the scheduler is core-aware, so two tenants never share a physical
  core.
- **Disk:** per-sandbox quotas are enforced, and stopped sandboxes' disks are removed on a
  retention policy.
- **Egress:** a separate address per host (or per tenant tier), rate limits on new
  connections, and the proxy's per-tenant allowlist (#110).
- **Logs and metrics** name the tenant and the sandbox, and one tenant's data never
  appears in another's.

## What exists today

As of 2026-10-16, on main:

| | layer | status |
|---|---|---|
| guestd not a boundary; guest output is data | 1 | **done**: publishing verified on the host (#31, #32). Alert dismissals follow this ADR |
| no secret in the guest | 1 | partial: the clone/fetch read token until #110, plus dev-mode `GITHUB_TOKEN` (#77) |
| jailer, uid, chroot, cgroup, seccomp | 2 | **done** (#102) |
| confined sandboxd, credentials | 3 | **done** (#101). The unit works on systemd 255 since #135 |
| internet-only network rules, IPv6, anti-spoof | 3 | **done** (#105). Gaps in #106 |
| egress proxy over vsock | 3 | not started (#110, now with this channel) |
| host `nested=0`, CPU template, startup check | 4 | not started. starship has `nested=1` (2026-10-16) |
| a host that meets layer 4 | 4 | none in production yet. The lab (`sandbox/lab`) is a disposable L1 for testing |
| tenant isolation | 5 | not started. A single tenant until then |

## Consequences

- **Code-scanning alerts on guestd's inputs** (path and command injection) are dismissed as
  "won't fix", with a link to layer 1. New alerts are still read one by one. The rules
  aren't scoped out: CodeQL can only skip a whole directory, which would hide real bugs.
- **Data from the guest:**
  - Reviewers judge a feature that trusts guest-held data by layer 1. It may decide only
    what the guest could do to itself.
  - The host's parsing of guest data (vsock answers, files, bundles, proxy requests) is
    where hardening goes.
- **#110 is designed around a vsock listener per VM.** guestd grows a small forwarder,
  and egress becomes allowlisted.
- **New work for layer 4:**
  - a sandboxd startup check for `nested`;
  - a CPU template in `vm.rs`;
  - setting `kvm_amd nested=0` on starship, in a maintenance window, once the maintainer
    confirms nothing else there needs nested virtualization.
- **Hosting for others needs layer 4 and layer 5 complete**, a dedicated or disposable
  host, and a written decision to move off starship.
- **Relationship to other ADRs.** This ADR depends on ADR 0004 (where secrets live) and
  states its sandbox half. ADR 0002's "rules no profile can change" includes layers 1–3:
  a profile can request resources and egress within an install's maxima, never a
  weaker boundary.
