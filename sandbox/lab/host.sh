#!/usr/bin/env bash
# Runs as root on a lab host (Ubuntu 24.04 with /dev/kvm); lab.sh copies it there with
# the sources in /tmp/lab-src.tgz.
#
#   host.sh setup    XFS data disk at /srv/sbx, packages, Firecracker + jailer, toolchains,
#                    and sandboxd + guestd built from /tmp/lab-src.tgz
#   host.sh golden   an 8 GiB Ubuntu 24.04 golden (git, build tools, Node 24, Go 1.26) from
#                    Firecracker's CI rootfs, plus guestd via prepare-golden.sh; kept if present
#   host.sh start    serve-mode sandboxd on loopback with the repo's unit, its API token a
#                    systemd credential generated here (it never leaves the host)
#
# Each prints one JSON line last. Versions match starship (2026-10-16).
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
FC=v1.15.1 GO=1.26.0 NODE=v24.11.0
BUCKET=https://s3.amazonaws.com/spec.ccfc.min
FC_CI=$BUCKET/firecracker-ci/v1.15/x86_64
SRC=/opt/lorehouse
MAX_VMS=${MAX_VMS:-64}

# A failing command still ends the output with one JSON line, naming what failed.
trap 'rc=$?; [ "$BASH_SUBSHELL" -eq 0 ] || exit $rc; echo "{\"ok\":false,\"step\":\"${STEP:-}\",\"error\":\"line $LINENO: $(printf %s "$BASH_COMMAND" | tr -d \"\\\\ | cut -c1-160)\"}"; exit $rc' ERR

setup() {
  if ! mountpoint -q /srv/sbx; then
    dev=/dev/disk/by-id/google-data
    [ -e "$dev" ] || { echo '{"ok":false,"error":"no data disk at /dev/disk/by-id/google-data"}'; exit 1; }
    blkid "$dev" >/dev/null 2>&1 || mkfs.xfs -q -f -m reflink=1 "$dev"
    mkdir -p /srv/sbx
    grep -q google-data /etc/fstab || echo "$dev /srv/sbx xfs defaults,noatime 0 2" >>/etc/fstab
    mount /srv/sbx
  fi
  mkdir -p /srv/sbx/state /usr/local/lib/lorehouse
  apt-get update -qq
  apt-get install -y -qq build-essential pkg-config git curl squashfs-tools e2fsprogs nftables jq iproute2 >/dev/null
  if ! firecracker --version 2>/dev/null | grep -q "${FC#v}"; then
    curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FC/firecracker-$FC-x86_64.tgz" | tar -xz -C /tmp
    install -m 0755 "/tmp/release-$FC-x86_64/firecracker-$FC-x86_64" /usr/local/bin/firecracker
    install -m 0755 "/tmp/release-$FC-x86_64/jailer-$FC-x86_64" /usr/local/bin/jailer
  fi
  [ -x /usr/local/go/bin/go ] || curl -fsSL "https://go.dev/dl/go$GO.linux-amd64.tar.gz" | tar -xz -C /usr/local
  [ -x /root/.cargo/bin/cargo ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal -q >/dev/null
  export PATH=/usr/local/go/bin:/root/.cargo/bin:$PATH
  # The guest kernel: Firecracker's CI build for this release, unless one was copied in.
  if [ ! -s /usr/local/lib/lorehouse/vmlinux ]; then
    k=$(curl -fsSL "$BUCKET?list-type=2&prefix=firecracker-ci/v1.15/x86_64/vmlinux-" | grep -oE 'vmlinux-[0-9]+\.[0-9]+\.[0-9]+' | sort -uV | tail -1)
    # To a temporary name first: a download cut short must not leave a non-empty kernel that
    # the -s check above would then keep using.
    curl -fsSL -o /usr/local/lib/lorehouse/vmlinux.part "$FC_CI/$k"
    mv /usr/local/lib/lorehouse/vmlinux.part /usr/local/lib/lorehouse/vmlinux
  fi
  rm -rf "$SRC" && mkdir -p "$SRC" && tar -xzf /tmp/lab-src.tgz -C "$SRC"
  (cd "$SRC/sandbox/guest" && CGO_ENABLED=0 go build -o guestd .)
  (cd "$SRC/sandbox/host" && cargo build --release --locked -q)
  install -m 0755 "$SRC/sandbox/host/target/release/sandboxd" /usr/local/bin/sandboxd
  install -m 0644 "$SRC/sandbox/host/sandboxd.sysctl.conf" /etc/sysctl.d/90-lorehouse-sandboxd.conf
  install -m 0644 "$SRC/sandbox/host/sandboxd.modules.conf" /etc/modules-load.d/lorehouse-sandboxd.conf
  sysctl --system >/dev/null && systemctl restart systemd-modules-load
  printf '{"ok":true,"step":"setup","firecracker":"%s","kernel":"%s","commit":"%s"}\n' \
    "$(firecracker --version | head -1 | awk '{print $2}')" "$( (strings /usr/local/lib/lorehouse/vmlinux | grep -oE 'Linux version [^ ]+' | head -1 | awk '{print $3}') || true)" "$(cat "$SRC/COMMIT" 2>/dev/null || echo unknown)"
}

golden() {
  G=/srv/sbx/golden.ext4
  if [ -s "$G" ] && [ "${REBUILD:-0}" != 1 ]; then
    # guestd is part of the golden: refresh just it when sources changed.
    if ! cmp -s "$SRC/sandbox/guest/guestd" /srv/sbx/golden-guestd 2>/dev/null; then
      mnt=$(mktemp -d); mount -o loop "$G" "$mnt"
      install -m 0755 "$SRC/sandbox/guest/guestd" "$mnt/usr/local/bin/guestd"; umount "$mnt"; rmdir "$mnt"
      cp "$SRC/sandbox/guest/guestd" /srv/sbx/golden-guestd
      echo '{"ok":true,"step":"golden","golden":"kept","guestd":"refreshed"}'
    else
      echo '{"ok":true,"step":"golden","golden":"kept","guestd":"current"}'
    fi
    return
  fi
  W=/srv/sbx/build; rm -rf "$W"; mkdir -p "$W"; cd "$W"
  curl -fsSL -o rootfs.squashfs "$FC_CI/ubuntu-24.04.squashfs"
  unsquashfs -q -d root rootfs.squashfs
  # The CI rootfs leaves out directories apt needs.
  mkdir -p root/tmp root/var/cache/apt/archives/partial root/var/lib/apt/lists/partial root/var/log/apt && chmod 1777 root/tmp
  rm -f root/etc/resolv.conf && cp /etc/resolv.conf root/etc/resolv.conf
  for m in proc sys dev; do mount --bind "/$m" "root/$m"; done
  trap 'for m in dev sys proc; do umount -l "'"$W"'/root/$m" 2>/dev/null || true; done' EXIT
  chroot root /bin/bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates curl build-essential python3 xz-utils >/dev/null && apt-get clean'
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C root/usr/local --strip-components=1
  curl -fsSL "https://go.dev/dl/go$GO.linux-amd64.tar.gz" | tar -xz -C root/usr/local
  ln -sf /usr/local/go/bin/go root/usr/local/bin/go
  for m in dev sys proc; do umount -l "root/$m"; done
  trap - EXIT
  truncate -s 8G source.ext4 && mkfs.ext4 -q -d root -F source.ext4
  SOURCE="$W/source.ext4" GUESTD="$SRC/sandbox/guest/guestd" "$SRC/sandbox/host/prepare-golden.sh" "$G" >&2
  cp "$SRC/sandbox/guest/guestd" /srv/sbx/golden-guestd
  cd / && rm -rf "$W"
  echo '{"ok":true,"step":"golden","golden":"built"}'
}

start() {
  uplink=$(ip -o route get 1.1.1.1 | sed -n 's/.* dev \([^ ]*\).*/\1/p')
  mkdir -p /etc/lorehouse
  if [ ! -s /etc/lorehouse/sandboxd-api-token ]; then
    install -m 0600 /dev/null /etc/lorehouse/sandboxd-api-token
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >/etc/lorehouse/sandboxd-api-token
  fi
  install -m 0600 /dev/null /etc/lorehouse/sandboxd.env
  cat >/etc/lorehouse/sandboxd.env <<EOF
SANDBOXD_GOLDEN=/srv/sbx/golden.ext4
SANDBOXD_KERNEL=/usr/local/lib/lorehouse/vmlinux
SANDBOXD_UPLINK=$uplink
SANDBOXD_STATE=/srv/sbx/state
SANDBOXD_MAX_VMS=$MAX_VMS
SANDBOXD_IDLE_SECS=900
SANDBOXD_DISK_QUOTA_GIB=0
EOF
  # The repo's unit, with two lab-only changes: the API token as a credential, and the
  # state directory on the data disk.
  sed -e 's|^#LoadCredential=runner-token:.*|LoadCredential=api-token:/etc/lorehouse/sandboxd-api-token|' \
      -e 's|^StateDirectoryMode=0700|StateDirectoryMode=0700\nReadWritePaths=/srv/sbx/state|' \
      "$SRC/sandbox/host/sandboxd.service" >/etc/systemd/system/sandboxd.service
  systemctl daemon-reload
  systemctl restart sandboxd
  for _ in $(seq 1 20); do curl -fsS -m 1 http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 0.5; done
  if systemctl is-active -q sandboxd && curl -fsS -m 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo "{\"ok\":true,\"step\":\"start\",\"max_vms\":$MAX_VMS,\"uplink\":\"$uplink\"}"
  else
    journalctl -u sandboxd -n 20 --no-pager -o cat | grep -v -i token >&2
    echo '{"ok":false,"step":"start","error":"sandboxd did not come up; see the journal above"}'
    exit 1
  fi
}

STEP=${1:-}
case "$STEP" in
  setup) setup ;;
  golden) golden ;;
  start) start ;;
  *) echo "usage: host.sh setup|golden|start" >&2; exit 2 ;;
esac
