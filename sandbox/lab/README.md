# sandbox lab: a real-KVM sandboxd on demand

`lab.sh` runs this working tree's `sandbox/` (sandboxd, guestd, the unit) on a throwaway
Google Compute Engine VM with nested virtualization. It boots real Firecracker microVMs
there and measures them. Use it to prove a sandbox change on real KVM before it reaches
a production host, and never point it at one: the lab is its own VM, in its own project.

```bash
export LAB_PROJECT=<gcp project>       # once: a project with billing and Compute Engine on
sandbox/lab/lab.sh up                  # create or start the VM, wait for SSH (≈50 s new)
sandbox/lab/lab.sh deploy              # build and start sandboxd from this tree (≈40 s; ≈90 s the first time)
sandbox/lab/lab.sh bench cold 5        # cold boots
sandbox/lab/lab.sh bench burst 32      # 32 boots at once
sandbox/lab/lab.sh bench work          # clone + npm install, go build, CPU, disk
sandbox/lab/lab.sh bench cpupar 16     # 16 × go build -a at the same moment
sandbox/lab/lab.sh ssh 'sudo journalctl -u sandboxd -n 50 --no-pager'
sandbox/lab/lab.sh stop                # stop paying for compute (disks stay, ≈$20/month)
sandbox/lab/lab.sh down --yes          # delete the VM and its disks
```

Every command ends with one JSON line on stdout (`{"ok": …}`; `ssh` prints the command's
output first, then `{"ok": …, "exit": N}`), and progress goes to
stderr, so an agent can read the result without parsing prose. `deploy` copies the
tracked and new (not ignored) files under `sandbox/host` and `sandbox/guest`, so
uncommitted work is what gets tested. Its `commit` says `+dirty` when that work differs
from `HEAD`.

What it sets up (`host.sh`):
- **OS and storage:** Ubuntu 24.04, a 200 GB XFS data disk (reflinks) at `/srv/sbx`.
- **Firecracker:** Firecracker and the jailer v1.15.1, and Firecracker's CI guest kernel for that release.
- **Golden:** an 8 GiB Ubuntu 24.04 golden with git, build tools, Node 24 and Go 1.26, built once and kept. Later deploys only refresh guestd in it; `REBUILD=1` in host.sh's environment rebuilds it.
- **sandboxd:** in serve mode on loopback, under the repo's unit as-is, except for two changes:
  - the API token comes as a systemd credential generated on the VM, and never leaves it;
  - the state directory is on the data disk.

  Disk quotas are off (`SANDBOXD_DISK_QUOTA_GIB=0`: XFS quotas are not set up), and `SANDBOXD_MAX_VMS=64`.

Env: `LAB_ZONE` (`us-east4-a`), `LAB_NAME` (`sbx-lab`), `LAB_TYPE` (`n4-standard-16`: 16
vCPU, 64 GB, ≈$0.73/h on demand), `LAB_DISK_GB` (`200`).

Measured on `n4-standard-16`, us-east4-a, 2026-10-16. For comparison, the same golden,
kernel and sandboxd on bare metal (a 32-thread Zen 5 desktop):

| | lab (nested) | bare metal |
|---|---|---|
| cold boot → first exec | 2.4 s | 0.82 s |
| 16 boots at once, all done | 9.0 s | 1.6 s |
| 64 boots at once | 33.5 s, all ok, 18 GB host RAM | — |
| clone + `npm install` (express) | 0.6 + 16.9 s | — |
| `go build -a` (cobra), 1 / 16 at once | 11.7 s / 37 s | 5.7 s / 10.8 s |

Nested virtualization costs most at boot, about 3×, and more when many VMs boot at once. Steady CPU work
mostly reflects the host's slower clock. Numbers from the lab are for comparing changes
with each other, not for sizing a bare-metal host.
