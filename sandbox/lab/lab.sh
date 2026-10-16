#!/usr/bin/env bash
# lab.sh — a real-KVM sandboxd on a throwaway GCE VM (nested virtualization), for proving
# sandbox changes before a deploy. See README.md in this directory.
#
#   lab.sh up              create the VM (or start it), wait for SSH
#   lab.sh deploy          build this working tree's sandbox/ there (uncommitted changes
#                          included) and (re)start sandboxd in serve mode
#   lab.sh bench ARGS...   run bench.py there (bench.py's own usage)
#   lab.sh ssh CMD...      run a command there; its output, then {"ok":…,"exit":N}
#   lab.sh status          the VM's state
#   lab.sh stop            stop the VM (disks kept, ~$20/month for them)
#   lab.sh down --yes      delete the VM and its disks
#
# Env: LAB_PROJECT (required), LAB_ZONE (us-east4-a), LAB_NAME (sbx-lab),
# LAB_TYPE (n4-standard-16), LAB_DISK_GB (200).
# Every command ends with one JSON line on stdout; progress goes to stderr.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
P=${LAB_PROJECT:?set LAB_PROJECT to the GCP project the lab VM lives in}
Z=${LAB_ZONE:-us-east4-a} N=${LAB_NAME:-sbx-lab} T=${LAB_TYPE:-n4-standard-16} DISK=${LAB_DISK_GB:-200}
g() { gcloud --project "$P" --quiet "$@"; }
# ssh exits 255 on its own connection failures (seen: a banner-exchange timeout); retry those.
remote() {
  local rc
  for i in 1 2 3; do
    rc=0; g compute ssh "$N" --zone "$Z" --command "$*" -- -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR -o ConnectTimeout=15 || rc=$?
    [ "$rc" = 255 ] || return "$rc"
    echo "lab: ssh connection failed (try $i of 3)" >&2; sleep 3
  done
  return 255
}
push() { local i; for i in 1 2 3; do g compute scp "$@" --zone "$Z" >/dev/null && return 0; echo "lab: scp failed (try $i of 3)" >&2; sleep 3; done; return 1; }
now() { python3 -c 'import time; print(time.time())'; }
state() { g compute instances describe "$N" --zone "$Z" --format='value(status)' 2>/dev/null || echo ABSENT; }

wait_ssh() {
  for _ in $(seq 1 60); do remote true >/dev/null 2>&1 && return 0; sleep 2; done
  echo "{\"ok\":false,\"error\":\"no SSH to $N after 120 s\"}"; exit 1
}

cmd=${1:-}; shift || true
case "$cmd" in
  up)
    t0=$(now); s=$(state)
    case "$s" in
      ABSENT)
        echo "lab: creating $N ($T, $Z)" >&2
        g compute instances create "$N" --zone "$Z" --machine-type "$T" --enable-nested-virtualization \
          --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
          --boot-disk-type hyperdisk-balanced --boot-disk-size 50GB \
          --create-disk="name=$N-data,size=${DISK}GB,type=hyperdisk-balanced,device-name=data,auto-delete=yes" \
          --labels purpose=sandbox-lab >&2 ;;
      TERMINATED|STOPPED) echo "lab: starting $N" >&2; g compute instances start "$N" --zone "$Z" >&2 ;;
      RUNNING) ;;
      *) echo "{\"ok\":false,\"error\":\"$N is $s; wait and retry\"}"; exit 1 ;;
    esac
    wait_ssh
    ip=$(g compute instances describe "$N" --zone "$Z" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
    kvm=$(remote 'test -c /dev/kvm && echo yes || echo no')
    printf '{"ok":true,"name":"%s","was":"%s","ip":"%s","kvm":"%s","ready_s":%.1f}\n' "$N" "$s" "$ip" "$kvm" "$(python3 -c "print($(now)-$t0)")" ;;
  deploy)
    [ "$(state)" = RUNNING ] || { echo '{"ok":false,"error":"the VM is not running; run lab.sh up"}'; exit 1; }
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    # This working tree's files (tracked and new, not ignored), so uncommitted work is what gets tested;
    # COMMIT is HEAD plus "+dirty" when any of them (new files too) differs from it.
    # A path deleted or renamed but not staged is still in the index: drop the ones gone from
    # disk (lexists keeps a symlink, even a dangling one), or tar would abort on them.
    (cd "$root" && { git ls-files -z --cached --others --exclude-standard sandbox/host sandbox/guest; } \
      | python3 -c 'import os, sys; sys.stdout.buffer.write(b"".join(p + b"\0" for p in sys.stdin.buffer.read().split(b"\0") if p and os.path.lexists(p)))' \
      | tar --null -T - -czf "$tmp/lab-src.tgz" \
      && { git rev-parse --short HEAD | tr -d '\n'; [ -z "$(git status --porcelain -- sandbox/host sandbox/guest)" ] || printf '+dirty'; } >"$tmp/COMMIT")
    (cd "$tmp" && mkdir s && tar -xzf lab-src.tgz -C s && cp COMMIT s/ && tar -czf lab-src.tgz -C s .)
    push "$tmp/lab-src.tgz" "$here/host.sh" "$here/bench.py" "$N:/tmp/"
    t0=$(now)
    for step in setup golden start; do
      echo "lab: host.sh $step" >&2
      out=$(remote "sudo bash /tmp/host.sh $step") || { echo "$out" | tail -1; exit 1; }
      echo "$out" | tail -1 >&2
    done
    printf '{"ok":true,"commit":"%s","deploy_s":%.1f}\n' "$(cat "$tmp/COMMIT")" "$(python3 -c "print($(now)-$t0)")" ;;
  bench)
    [ $# -gt 0 ] || { echo '{"ok":false,"error":"usage: lab.sh bench cold|burst|stagger|work|workpar|cpupar|clean ..."}'; exit 2; }
    push "$here/bench.py" "$N:/tmp/bench.py"
    remote "sudo python3 /tmp/bench.py $*" ;;
  ssh)
    # The command's own output as it comes, then the JSON line; the exit status is the command's.
    rc=0; remote "$@" || rc=$?
    echo "{\"ok\":$([ "$rc" = 0 ] && echo true || echo false),\"exit\":$rc}"; exit "$rc" ;;
  status) printf '{"ok":true,"name":"%s","state":"%s","zone":"%s","type":"%s"}\n' "$N" "$(state)" "$Z" "$T" ;;
  stop) g compute instances stop "$N" --zone "$Z" >&2; echo "{\"ok\":true,\"state\":\"$(state)\"}" ;;
  down)
    [ "${1:-}" = --yes ] || { echo '{"ok":false,"error":"down deletes the VM and its disks; pass --yes"}'; exit 2; }
    g compute instances delete "$N" --zone "$Z" >&2; echo '{"ok":true,"state":"ABSENT"}' ;;
  *) sed -n '2,18p' "$0" >&2; exit 2 ;;
esac
