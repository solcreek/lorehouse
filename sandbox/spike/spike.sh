#!/usr/bin/env bash
# sandbox feasibility spike — run as root on a Linux host with KVM.
#
#   sudo ./spike.sh prepare   # reflink a golden rootfs, bake guestd in, mask the CI runner unit
#   sudo ./spike.sh boot      # boot one microVM, time boot → guestd healthy, run probes
#   sudo ./spike.sh stop
#
# Measures what the agent needs from a sandbox: cold boot latency, exec round-trip,
# and whether a session's disk survives a stop/boot cycle (it's a plain file).
set -euo pipefail

DIR=${DIR:-/var/tmp/lorehouse-spike}
GOLDEN=${GOLDEN:-/var/tmp/fr-golden/ubuntu-rootfs-minimal-cache.ext4}
KERNEL=${KERNEL:-/var/tmp/fc-test/vmlinux}
GUESTD=${GUESTD:-$DIR/guestd}
VCPUS=${VCPUS:-2}
MEM_MIB=${MEM_MIB:-2048}
BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd root=/dev/vda rw"

ms() { date +%s%3N; }

prepare() {
  mkdir -p "$DIR"
  local t0; t0=$(ms)
  cp --reflink=always "$GOLDEN" "$DIR/rootfs.ext4"
  echo "reflink copy of $(du -h --apparent-size "$GOLDEN" | cut -f1) golden: $(( $(ms) - t0 )) ms"
  local mnt="$DIR/mnt"; mkdir -p "$mnt"
  mount -o loop "$DIR/rootfs.ext4" "$mnt"
  install -m 0755 "$GUESTD" "$mnt/usr/local/bin/guestd"
  cat >"$mnt/etc/systemd/system/guestd.service" <<'EOF'
[Unit]
Description=lorehouse sandbox guest agent (vsock:1024)
After=local-fs.target

[Service]
ExecStart=/usr/local/bin/guestd
Restart=always

[Install]
WantedBy=multi-user.target
EOF
  ln -sf /etc/systemd/system/guestd.service "$mnt/etc/systemd/system/multi-user.target.wants/guestd.service"
  # The CI golden boots straight into a one-shot runner that reboots the VM; not here.
  ln -sf /dev/null "$mnt/etc/systemd/system/firerunner-runner.service"
  umount "$mnt"
  echo "prepared $DIR/rootfs.ext4"
}

vm_config() {
  local args="$BOOT_ARGS" nic=""
  if [ "${NET:-0}" = 1 ]; then
    args="$args ip=$GUEST_IP::$HOST_IP:255.255.255.252::eth0:off"
    nic='"network-interfaces": [{ "iface_id": "eth0", "host_dev_name": "'"$TAP"'", "guest_mac": "06:00:ac:1e:00:02" }],'
  fi
  cat <<EOF
{
  $nic
  "boot-source": { "kernel_image_path": "$KERNEL", "boot_args": "$args" },
  "drives": [{ "drive_id": "rootfs", "path_on_host": "$DIR/rootfs.ext4", "is_root_device": true, "is_read_only": false }],
  "machine-config": { "vcpu_count": $VCPUS, "mem_size_mib": $MEM_MIB },
  "vsock": { "guest_cid": 3, "uds_path": "$DIR/vsock.sock" }
}
EOF
}

boot() {
  rm -f "$DIR/vsock.sock" "$DIR/api.sock"
  vm_config >"$DIR/vm.json"
  local t0; t0=$(ms)
  firecracker --api-sock "$DIR/api.sock" --config-file "$DIR/vm.json" >"$DIR/console.log" 2>&1 &
  echo $! >"$DIR/fc.pid"
  # Poll guestd through the vsock UDS until it answers.
  for _ in $(seq 1 300); do
    if "$DIR/vsock-http.py" "$DIR/vsock.sock" GET /healthz >/dev/null 2>&1; then
      echo "boot → guestd healthy: $(( $(ms) - t0 )) ms"
      probes
      return
    fi
    sleep 0.05
  done
  echo "guestd never answered; console tail:"; tail -30 "$DIR/console.log"; exit 1
}

probes() {
  local q="$DIR/vsock-http.py" s="$DIR/vsock.sock" t0
  t0=$(ms); "$q" "$s" POST /exec '{"command":"true"}' >/dev/null
  echo "exec round-trip (true): $(( $(ms) - t0 )) ms"
  "$q" "$s" POST /exec '{"command":"uname -r; nproc; free -m | sed -n 2p; df -h / | tail -1; cat /workspace/marker 2>/dev/null || echo no-marker-yet"}'
  "$q" "$s" POST /exec '{"command":"mkdir -p /workspace && date -Is > /workspace/marker && sync"}' >/dev/null
  "$q" "$s" PUT '/file?path=/workspace/repo/hello.txt' 'written via PUT'
  "$q" "$s" GET '/file?path=/workspace/repo/hello.txt'; echo
  "$q" "$s" POST /exec '{"command":"sleep 5","timeoutMs":500}'
}

stop() {
  # Flush the guest page cache FIRST. Killing the VMM without it loses recent
  # writes: a clone finished just before a bare `kill` came back as a broken
  # .git on the next boot (2026-09-25). With reboot=k, `reboot -f` exits the VMM.
  if [ -S "$DIR/vsock.sock" ]; then
    "$DIR/vsock-http.py" "$DIR/vsock.sock" POST /exec '{"command":"sync && (sleep 0.2; reboot -f) &"}' >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do [ -f "$DIR/fc.pid" ] && kill -0 "$(cat "$DIR/fc.pid")" 2>/dev/null || break; sleep 0.05; done
  fi
  [ -f "$DIR/fc.pid" ] && kill "$(cat "$DIR/fc.pid")" 2>/dev/null || true
  rm -f "$DIR/fc.pid"
  echo stopped
}

# ── networking (NET=1): one tap on a /30, masqueraded out the LAN iface ───────
# Same shape as firerunner's per-VM net, minus its allowlist: this spike only
# proves egress works. Everything is tagged so net-down removes exactly it.
TAP=lhtap0 HOST_IP=172.30.0.1 GUEST_IP=172.30.0.2 EXT=${EXT:-enp2s0} TAG=lorehouse-spike
net-up() {
  ip tuntap add dev "$TAP" mode tap
  ip addr add "$HOST_IP/30" dev "$TAP"
  ip link set "$TAP" up
  nft add table ip "$TAG"
  nft "add chain ip $TAG post { type nat hook postrouting priority srcnat; }"
  nft add rule ip "$TAG" post ip saddr "$GUEST_IP" oifname "$EXT" masquerade
  # docker's ip/filter FORWARD is policy drop; the accept must live in that chain.
  nft insert rule ip filter FORWARD iifname "$EXT" oifname "$TAP" ct state established,related accept comment "\"$TAG\""
  nft insert rule ip filter FORWARD iifname "$TAP" oifname "$EXT" accept comment "\"$TAG\""
  echo "net up: $TAP $HOST_IP ↔ $GUEST_IP via $EXT"
}
net-down() {
  for h in $(nft -a list chain ip filter FORWARD | awk -v t="\"$TAG\"" '$0 ~ t {print $NF}'); do
    nft delete rule ip filter FORWARD handle "$h"
  done
  nft delete table ip "$TAG" 2>/dev/null || true
  ip link del "$TAP" 2>/dev/null || true
  echo "net down"
}

"${1:?prepare|boot|stop|net-up|net-down}"
