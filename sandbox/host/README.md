# sandboxd

The sandbox host: one Firecracker microVM per sandbox id (Lorehouse uses one per Slack
thread), behind the small HTTP API that `src/sandbox-client.ts` speaks. Rust.

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
| `SANDBOXD_TOKEN` | (required) | bearer token for every `/v1` request, 32+ characters |
| `SANDBOXD_GOLDEN` | (required) | the prepared rootfs |
| `SANDBOXD_KERNEL` | (required) | guest kernel image |
| `SANDBOXD_UPLINK` | (required) | the host's internet-facing interface |
| `SANDBOXD_LISTEN` | `127.0.0.1:8787` | keep it on loopback and publish it through a tunnel |
| `SANDBOXD_STATE` | `/var/lib/lorehouse-sandboxes` | one directory per sandbox |
| `SANDBOXD_MAX_VMS` | `4` | running at once (1–64); more gets a 503 |
| `SANDBOXD_IDLE_SECS` | `900` | idle time before a VM is stopped |
| `SANDBOXD_VCPUS` `SANDBOXD_MEM_MIB` | `2`, `2048` | per VM |

Then install [`sandboxd.service`](sandboxd.service). Point Lorehouse at it with
`SANDBOX_URL` and `SANDBOX_TOKEN` (plus `GITHUB_TOKEN` for pull requests).

## Measured

On a Ryzen 7 8745HS with btrfs, using a 22 GB Ubuntu 24.04 CI image as the golden
(2026-09-28):

| | |
|---|---|
| cold boot to the first command done | ~4.0 s |
| boot again after an idle stop (disk kept, page cache warm) | 0.8 s |
| command on a running VM | 22 ms |
| golden prepared (reflink + guestd) | 0.13 s |

The acceptance run also covered:

- **Allowed:** internet (GitHub 200, DNS).
- **Blocked:** the LAN gateway, the host and the tailnet.
- **Work:** clone, write and read a file.
- **Limits:** capacity (503), a bad id (400), no token (401).
- **Lifecycle:** idle stop with the disk kept, and a clean shutdown that leaves no rules or processes behind.
