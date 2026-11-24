#!/usr/bin/env bash
# RedClinic website: one-time setup and updates on an Ubuntu VPS (Hostinger KVM).
# Run as root:
#   curl -fsSL https://raw.githubusercontent.com/redclinic-ai/redclinic/website/website/deploy/setup-vps.sh | bash
# Safe to run again: it updates the code, rebuilds and restarts.
set -euo pipefail

DOMAIN="${DOMAIN:-redclinic.in}"
REPO="${REPO:-https://github.com/redclinic-ai/redclinic.git}"
BRANCH="${BRANCH:-website}"
APP_DIR=/opt/redclinic
DATA_DIR=/var/lib/redclinic-website
ENV_FILE=/etc/redclinic-website.env

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -q
apt-get install -y -q curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy (web server with automatic HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -q && apt-get install -y -q caddy
fi

echo "==> App user and folders"
id -u redclinic >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin redclinic
mkdir -p "$DATA_DIR"
chown redclinic:redclinic "$DATA_DIR"
chmod 700 "$DATA_DIR"

echo "==> Code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR/website"
node build.mjs
chown -R redclinic:redclinic "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Settings (first run)"
  ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)"
  cat > "$ENV_FILE" <<ENV
PORT=8080
TRUST_PROXY=1
LEAD_STORAGE=file
LEADS_FILE=$DATA_DIR/demo-requests.jsonl
ADMIN_USER=founder
ADMIN_PASSWORD=$ADMIN_PASSWORD
ENV
  chmod 600 "$ENV_FILE"
  NEW_PASSWORD=1
fi

echo "==> Service"
cat > /etc/systemd/system/redclinic-website.service <<UNIT
[Unit]
Description=RedClinic marketing website
After=network.target

[Service]
User=redclinic
WorkingDirectory=$APP_DIR/website
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now redclinic-website
systemctl restart redclinic-website

echo "==> HTTPS and domain"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
www.$DOMAIN {
  redir https://$DOMAIN{uri} permanent
}
CADDY
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# Daily backup of demo requests, 30 days kept
cat > /etc/cron.daily/redclinic-leads-backup <<'CRON'
#!/bin/sh
f=/var/lib/redclinic-website/demo-requests.jsonl
[ -f "$f" ] && mkdir -p /var/backups/redclinic && cp "$f" "/var/backups/redclinic/demo-requests-$(date +%F).jsonl" && find /var/backups/redclinic -name 'demo-requests-*' -mtime +30 -delete
CRON
chmod 755 /etc/cron.daily/redclinic-leads-backup

sleep 2
echo
if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then echo "Website is running."; else echo "Website did not start: run  journalctl -u redclinic-website -n 50"; fi
echo "Server IP: $(curl -fsS -4 https://ifconfig.me || hostname -I | awk '{print $1}')"
if [ "${NEW_PASSWORD:-}" = 1 ]; then
  echo
  echo "Demo requests: https://$DOMAIN/admin/leads"
  echo "  user:     founder"
  echo "  password: $ADMIN_PASSWORD"
  echo "Save this password now. It is stored in $ENV_FILE on this server."
fi
