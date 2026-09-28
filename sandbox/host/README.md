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
  private networks (LAN, tailnet, link-local, other sandboxes) and no connection into the
  host. The agent inside, guestd, is reached over vsock.

## Needs

A Linux host with KVM, Firecracker on `PATH`, a guest kernel, and a btrfs or XFS
filesystem for the state and golden files. It runs as root: it creates taps and nftables
rules.

## Set up

```bash
cargo build --release                                      # → target/release/sandboxd
(cd ../guest && CGO_ENABLED=0 go build -o guestd .)        # the in-VM agent
sudo SOURCE=<ubuntu-rootfs.ext4> GUESTD=../guest/guestd ./prepare-golden.sh /var/lib/lorehouse-golden.ext4
```

`/etc/lorehouse/sandboxd.env` (mode 0600):

| env | default | |
|---|---|---|
| `SANDBOXD_APP_URL` | (none) | runner mode: Lorehouse's URL, e.g. `https://lorehouse.example.com` |
| `SANDBOXD_RUNNER_TOKEN` | (required with `SANDBOXD_APP_URL`) | Lorehouse's `SANDBOX_RUNNER_TOKEN` |
| `SANDBOXD_RUNNER_NAME` | the hostname | how Lorehouse knows this host (sandboxes stick to it) |
| `SANDBOXD_TRANSPORT` | `auto` | `ws`, `poll`, or `auto`: WebSocket, falling back to long poll when an upgrade is refused |
| `SANDBOXD_TOKEN` | (required without `SANDBOXD_APP_URL`) | serve mode: bearer token for every `/v1` request, 32+ characters |
| `SANDBOXD_GOLDEN` | (required) | the prepared rootfs |
| `SANDBOXD_KERNEL` | (required) | guest kernel image |
| `SANDBOXD_UPLINK` | (required) | the host's internet-facing interface |
| `SANDBOXD_LISTEN` | `127.0.0.1:8787` | serve mode: where the API listens; keep it on loopback |
| `SANDBOXD_STATE` | `/var/lib/lorehouse-sandboxes` | one directory per sandbox |
| `SANDBOXD_MAX_VMS` | `4` | running at once (1–64); more gets a 503 |
| `SANDBOXD_IDLE_SECS` | `900` | idle time before a VM is stopped |
| `SANDBOXD_VCPUS` `SANDBOXD_MEM_MIB` | `2`, `2048` | per VM |

Then install [`sandboxd.service`](sandboxd.service). On Lorehouse's side, set
`SANDBOX_RUNNER_TOKEN` for runners, or `SANDBOX_URL` and `SANDBOX_TOKEN` for a served
host, plus `GITHUB_TOKEN` for pull requests either way.

[`e2e.ts`](e2e.ts) checks the whole path. It runs Lorehouse in runner mode against the
conformance mock of Slack and the model, waits for a real sandboxd to connect, and asks for
a command only a microVM with internet can answer. With `E2E_NO_WS_PROXY=1` it puts a
proxy in front that strips WebSocket upgrades, so a runner on `auto` has to fall back.

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
