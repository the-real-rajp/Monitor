#!/bin/sh
# Installs or upgrades monitor-agent on a Linux box or Raspberry Pi.
#
#   curl -fsSL __BASE_URL__/install.sh | sudo sh -s -- --url __BASE_URL__ --key mon_...
#
# What it does: downloads the binary for this CPU from the project's GitHub
# releases, writes /etc/monitor-agent/agent.env, creates a system user,
# installs a systemd unit and starts the service. Re-running upgrades the
# binary and keeps the existing config unless --key is given again.
set -eu

REPO="the-real-rajp/monitor"
BIN=/usr/local/bin/monitor-agent
CONF_DIR=/etc/monitor-agent
CONF="$CONF_DIR/agent.env"
URL="__BASE_URL__"
KEY=""
VERSION="latest"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo)" >&2; exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required" >&2; exit 1
fi
if [ -z "$KEY" ] && [ ! -f "$CONF" ]; then
  echo "--key is required on first install (create a proxy in the dashboard to get one)" >&2; exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv6l|arm*) ARCH=arm ;;
  *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  ASSET="https://github.com/$REPO/releases/latest/download/monitor-agent-linux-$ARCH"
else
  ASSET="https://github.com/$REPO/releases/download/$VERSION/monitor-agent-linux-$ARCH"
fi

echo "downloading $ASSET"
TMP="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMP" "$ASSET"
else
  wget -qO "$TMP" "$ASSET"
fi
chmod 0755 "$TMP"

if ! id monitor-agent >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin monitor-agent
fi

mkdir -p "$CONF_DIR"
if [ -n "$KEY" ]; then
  umask 077
  cat > "$CONF" <<CONF_EOF
# monitor-agent configuration. Restart the service after editing:
#   sudo systemctl restart monitor-agent
MONITOR_URL=$URL
MONITOR_KEY=$KEY
# MONITOR_LOG_LEVEL=info
# MONITOR_PING_TIMEOUT=3s
CONF_EOF
  chown root:monitor-agent "$CONF"
  chmod 0640 "$CONF"
fi

# Let the service group open unprivileged ICMP sockets.
GID="$(id -g monitor-agent)"
if [ -w /proc/sys/net/ipv4/ping_group_range ]; then
  echo "$GID $GID" > /proc/sys/net/ipv4/ping_group_range || true
  mkdir -p /etc/sysctl.d
  echo "net.ipv4.ping_group_range = $GID $GID" > /etc/sysctl.d/60-monitor-agent.conf
fi

systemctl stop monitor-agent 2>/dev/null || true
mv "$TMP" "$BIN"
chown root:root "$BIN"

cat > /etc/systemd/system/monitor-agent.service <<'UNIT_EOF'
[Unit]
Description=Monitor proxy: pings local devices and reports to the Monitor website
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=monitor-agent
Group=monitor-agent
EnvironmentFile=/etc/monitor-agent/agent.env
ExecStart=/usr/local/bin/monitor-agent
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable monitor-agent >/dev/null
systemctl restart monitor-agent

echo "checking connection to $URL ..."
if sudo -u monitor-agent env "$(grep MONITOR_URL "$CONF")" "$(grep MONITOR_KEY "$CONF")" "$BIN" check; then
  echo "monitor-agent installed and running. Logs: journalctl -u monitor-agent -f"
else
  echo "installed, but the website could not be reached. Check $CONF and: journalctl -u monitor-agent -n 50" >&2
  exit 1
fi
