#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_ROOT/scripts/run-fixed-odds-vps.sh"
SERVICE="/etc/systemd/system/rmc-fixed-odds.service"
TIMER="/etc/systemd/system/rmc-fixed-odds.timer"
RUN_USER="${SUDO_USER:-$USER}"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

command -v git >/dev/null || { apt-get update; apt-get install -y git; }
command -v curl >/dev/null || { apt-get update; apt-get install -y curl; }
command -v flock >/dev/null || { apt-get update; apt-get install -y util-linux; }

if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

cd "$REPO_ROOT"
git fetch origin main
if ! git push --dry-run origin HEAD:main >/dev/null 2>&1; then
  echo "GitHub mainへのpush認証がありません。VPSにGitHub SSHキー/PAT等の書込認証を設定してから再実行してください。" >&2
  exit 1
fi
COUNTRY="$(curl -fsS https://www.cloudflare.com/cdn-cgi/trace | awk -F= '$1=="loc"{print $2}' | tr -d '\r\n' || true)"
if [ "$COUNTRY" != "JP" ]; then
  echo "VPSの外向きIPがJPではありません (loc=${COUNTRY:-unknown})。東京リージョンを確認してください。" >&2
  exit 1
fi
npm install --no-save playwright@1.55.0
npx playwright install --with-deps chromium
chmod +x "$RUNNER"

cat > "$SERVICE" <<EOF
[Unit]
Description=RMC BET CHANNEL fixed-odds/eSports Japan VPS acquisition
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_ROOT
Environment=RMC_SOURCE_MACHINE=japan_vps_linux
Environment=RMC_SOURCE_REGION=JP
ExecStart=/bin/bash $RUNNER
TimeoutStartSec=25min
EOF

cat > "$TIMER" <<'EOF'
[Unit]
Description=RMC fixed-odds acquisition at 05:20/11:20/17:20/22:20 JST

[Timer]
OnCalendar=*-*-* 05:20:00 Asia/Tokyo
OnCalendar=*-*-* 11:20:00 Asia/Tokyo
OnCalendar=*-*-* 17:20:00 Asia/Tokyo
OnCalendar=*-*-* 22:20:00 Asia/Tokyo
Persistent=true
AccuracySec=1min
Unit=rmc-fixed-odds.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now rmc-fixed-odds.timer

echo "RMC Japan VPS timer installed."
systemctl list-timers rmc-fixed-odds.timer --all

echo "Running first acquisition now..."
systemctl start rmc-fixed-odds.service
systemctl --no-pager --full status rmc-fixed-odds.service || {
  journalctl -u rmc-fixed-odds.service -n 100 --no-pager
  exit 1
}
echo "Initial acquisition succeeded. PC is no longer required for fixed-odds acquisition."
