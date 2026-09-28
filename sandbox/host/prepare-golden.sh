#!/usr/bin/env bash
# Prepare the golden rootfs sandboxd reflinks for every sandbox. Run once, as root, on
# the sandbox host (btrfs or XFS, so reflinks are copy-on-write):
#
#   sudo SOURCE=/path/to/ubuntu.ext4 GUESTD=./guestd ./prepare-golden.sh /var/lib/lorehouse-golden.ext4
#
# SOURCE is any ext4 Ubuntu rootfs that boots under Firecracker (a CI runner image works).
# The golden gets:
#   • guestd, the in-VM agent, started at boot (vsock port 1024)
#   • a fixed resolver (1.1.1.1), since the guest's address comes from the kernel's ip=
#   • /workspace, where the agent works
#   • any CI runner unit that would take over the boot, masked
set -euo pipefail

GOLDEN=${1:?usage: prepare-golden.sh <golden.ext4>}
SOURCE=${SOURCE:?set SOURCE to an ext4 rootfs}
GUESTD=${GUESTD:?set GUESTD to the guestd binary (linux/amd64, static)}

cp --reflink=always "$SOURCE" "$GOLDEN.tmp"
mnt=$(mktemp -d)
trap 'umount "$mnt" 2>/dev/null || true; rmdir "$mnt"' EXIT
mount -o loop "$GOLDEN.tmp" "$mnt"

install -m 0755 "$GUESTD" "$mnt/usr/local/bin/guestd"
cat >"$mnt/etc/systemd/system/guestd.service" <<'EOF'
[Unit]
Description=Lorehouse sandbox guest agent (vsock:1024)
After=local-fs.target

[Service]
ExecStart=/usr/local/bin/guestd
Restart=always

[Install]
WantedBy=multi-user.target
EOF
ln -sf /etc/systemd/system/guestd.service "$mnt/etc/systemd/system/multi-user.target.wants/guestd.service"

rm -f "$mnt/etc/resolv.conf"
printf 'nameserver 1.1.1.1\nnameserver 1.0.0.1\n' >"$mnt/etc/resolv.conf"
mkdir -p "$mnt/workspace"

# A CI runner image boots straight into a one-shot job runner that powers the VM off.
for dir in etc/systemd/system lib/systemd/system usr/lib/systemd/system; do
  for unit in "$mnt/$dir"/*runner*.service; do
    [ -e "$unit" ] || [ -L "$unit" ] || continue
    ln -sf /dev/null "$mnt/etc/systemd/system/$(basename "$unit")"
    echo "masked $(basename "$unit") (from /$dir)"
  done
done

umount "$mnt"
mv "$GOLDEN.tmp" "$GOLDEN"
echo "golden ready: $GOLDEN"
