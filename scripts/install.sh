#!/bin/sh
# install.sh — install or upgrade Lorehouse on a Linux server with systemd.
#
#   curl -fsSL <release>/install.sh | sudo sh -s -- --tunnel quick
#   sudo lorehouse setup --channels general     # creates and installs the Slack app
#
# Safe to run again: it upgrades the binary, keeps the data and the settings, and restarts
# the service only when something changed. It never asks a question, so an agent can run it.
# The service starts even with nothing configured: it waits in setup mode for `lorehouse setup`.
#
# Options:
#   --env-file PATH   settings to install into /etc/lorehouse/lorehouse.env (never printed,
#                     never passed on a command line). Optional: `lorehouse setup` stores
#                     what it creates itself.
#   --tunnel quick    reach Slack through a Cloudflare quick tunnel, for a server with no
#                     domain. The app runs it, and repoints Slack at its new URL on each start.
#   --public-url URL  the server's fixed HTTPS URL instead (behind your own proxy)
#   --tunnel none     neither: forget the tunnel or public URL an earlier run set
#                     (without --tunnel or --public-url, a re-run keeps what was set)
#   --no-start        install and enable, but don't start
#
# Environment:
#   LOREHOUSE_RELEASE_URL   where lorehouse-linux-<arch> and SHA256SUMS are downloaded from
set -eu

RELEASE_URL=${LOREHOUSE_RELEASE_URL:-https://github.com/solcreek/lorehouse/releases/latest/download}
BIN=/usr/local/bin/lorehouse
DATA=/var/lib/lorehouse
ETC=/etc/lorehouse
ENV_FILE=$ETC/lorehouse.env
UNIT=/etc/systemd/system/lorehouse.service
TUNNEL_UNIT=/etc/systemd/system/lorehouse-tunnel.service
MANAGED='LOREHOUSE_DB|SESSIONS_DB|LOREHOUSE_TUNNEL|LOREHOUSE_PUBLIC_URL'

env_src='' tunnel='' public_url='' start=1 changed=''
while [ $# -gt 0 ]; do
  case $1 in
    --env-file) env_src=$2; shift 2 ;;
    --tunnel) tunnel=$2; shift 2 ;;
    --public-url) public_url=$2; shift 2 ;;
    --no-start) start=; shift ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { printf '• %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || die "run as root (sudo sh)"
[ "$(uname -s)" = Linux ] || die "Linux only"
[ -d /run/systemd/system ] || die "needs systemd"
command -v curl >/dev/null || die "needs curl"
command -v sha256sum >/dev/null || die "needs sha256sum (coreutils)"
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
[ -z "$env_src" ] || [ -r "$env_src" ] || die "can't read $env_src"
case $tunnel in "" | quick | none) ;; *) die "--tunnel takes: quick, none" ;; esac
[ -z "$tunnel" ] || [ -z "$public_url" ] || die "--tunnel and --public-url are alternatives: pick one"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# ── binary ───────────────────────────────────────────────────────────────────────────────
asset=lorehouse-linux-$arch
step "downloading $asset"
curl -fsSL -o "$tmp/$asset" "$RELEASE_URL/$asset" || die "download failed: $RELEASE_URL/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$RELEASE_URL/SHA256SUMS" || die "download failed: $RELEASE_URL/SHA256SUMS"
(cd "$tmp" && grep " $asset\$" SHA256SUMS | sha256sum -c --status) || die "checksum mismatch for $asset"
if ! cmp -s "$tmp/$asset" "$BIN" 2>/dev/null; then
  install -m 755 "$tmp/$asset" "$BIN.new" && mv -f "$BIN.new" "$BIN"
  changed=1
  step "installed $BIN"
else
  step "$BIN is already this version"
fi

# ── user, data, settings ─────────────────────────────────────────────────────────────────
id lorehouse >/dev/null 2>&1 || { useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin lorehouse; step "created user lorehouse"; }
install -d -o lorehouse -g lorehouse -m 750 "$DATA"
install -d -o root -g lorehouse -m 750 "$ETC"

# The user's settings (from --env-file, or the file already there), then the lines this
# script owns. The binary reads this file itself, so `sudo lorehouse doctor` needs nothing else.
if [ -n "$env_src" ]; then src=$env_src; elif [ -f "$ENV_FILE" ]; then src=$ENV_FILE; else src=/dev/null; fi
# Without --tunnel or --public-url, keep how the last run reached Slack: dropping it would
# restart the service with no public URL, and leave Slack pointed at a dead one.
# Read the way the binary's parseEnvFile does: optional `export`, spaces around `=`, one
# layer of quotes.
prev() {
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" 2>/dev/null | tail -n 1 |
    sed -E -e 's/[[:space:]]+$//' -e 's/^"(.*)"$/\1/' -e t -e "s/^'(.*)'\$/\\1/"
}
if [ -z "$tunnel" ] && [ -z "$public_url" ]; then
  tunnel=$(prev LOREHOUSE_TUNNEL)
  public_url=$(prev LOREHOUSE_PUBLIC_URL)
fi
{
  grep -v -E "^[[:space:]]*(export[[:space:]]+)?($MANAGED)[[:space:]]*=|^# managed by install.sh" "$src" || true
  echo "# managed by install.sh"
  echo "LOREHOUSE_DB=$DATA/lorehouse.db"
  echo "SESSIONS_DB=$DATA/sessions.db"
  if [ "$tunnel" = quick ]; then echo "LOREHOUSE_TUNNEL=quick"; fi
  if [ -n "$public_url" ]; then echo "LOREHOUSE_PUBLIC_URL=$public_url"; fi
} > "$tmp/env"
if ! cmp -s "$tmp/env" "$ENV_FILE" 2>/dev/null; then
  [ -f "$ENV_FILE" ] && cp -p "$ENV_FILE" "$ENV_FILE.bak"
  install -o root -g lorehouse -m 640 "$tmp/env" "$ENV_FILE"
  changed=1
  step "installed settings $ENV_FILE"
fi

# ── service ──────────────────────────────────────────────────────────────────────────────
unit=$(cat <<EOF
[Unit]
Description=Lorehouse
After=network-online.target
Wants=network-online.target

[Service]
User=lorehouse
Group=lorehouse
WorkingDirectory=$DATA
ExecStart=$BIN
# always: finishing setup exits to restart configured
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
)
if [ "$unit" != "$(cat "$UNIT" 2>/dev/null)" ]; then
  printf '%s\n' "$unit" > "$UNIT"
  changed=1
  step "installed $UNIT"
fi

# Cloudflare's static binary, not the .deb: it runs on any Linux, not only Debian's family.
if [ "$tunnel" = quick ] && ! command -v cloudflared >/dev/null; then
  step "installing cloudflared"
  cf_arch=amd64; [ "$arch" = arm64 ] && cf_arch=arm64
  curl -fsSL -o "$tmp/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cf_arch" ||
    die "download failed: cloudflared-linux-$cf_arch"
  install -m 755 "$tmp/cloudflared" /usr/local/bin/cloudflared
fi
# Earlier versions ran the tunnel as its own unit; the app runs it now.
if [ -f "$TUNNEL_UNIT" ]; then
  systemctl disable -q --now lorehouse-tunnel 2>/dev/null || true
  rm -f "$TUNNEL_UNIT"
  changed=1
fi

systemctl daemon-reload
systemctl enable -q lorehouse

# ── start ────────────────────────────────────────────────────────────────────────────────
[ -n "$start" ] || { say "LOREHOUSE_INSTALL status=installed"; exit 0; }
if [ -n "$changed" ] || ! systemctl is-active -q lorehouse; then
  systemctl restart lorehouse
  step "started lorehouse"
fi
# The port the service listens on: PORT in its settings, else the binary's default.
port=$(prev PORT)
health=
for _ in $(seq 30); do
  health=$(curl -fsS "http://localhost:${port:-3000}/healthz" 2>/dev/null) && break
  sleep 1
done
[ -n "$health" ] || { journalctl -u lorehouse -n 20 --no-pager >&2; die "lorehouse did not come up; logs above"; }

say ""
if [ "$health" = ok ]; then
  say "Lorehouse is running. Check it with: sudo lorehouse doctor"
  say "LOREHOUSE_INSTALL status=running"
else
  say "Lorehouse is waiting for setup. Next, with a Slack app configuration token"
  say "(api.slack.com/apps → Your App Configuration Tokens → Generate):"
  say "  sudo lorehouse setup --channels <channel-name>"
  say "LOREHOUSE_INSTALL status=needs-setup next=\"sudo lorehouse setup --channels <channel-name>\""
fi
