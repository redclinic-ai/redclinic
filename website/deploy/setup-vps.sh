#!/usr/bin/env bash
# RedClinic marketing website: install or update on an Ubuntu VPS that may already run other RedClinic services.
# Additive and safe to re-run: uses its own folder, user, port and Caddy site block; never edits other sites.
#   curl -fsSL https://raw.githubusercontent.com/redclinic-ai/redclinic/website/website/deploy/setup-vps.sh | bash
set -euo pipefail

DOMAIN="${DOMAIN:-redclinic.in}"
REPO="${REPO:-https://github.com/redclinic-ai/redclinic.git}"
BRANCH="${BRANCH:-website}"
PORT="${PORT:-8080}"
APP_USER=redclinic-web
APP_DIR=/opt/redclinic-website
DATA_DIR=/var/lib/redclinic-website
ENV_FILE=/etc/redclinic-website.env
SITE_FILE=/etc/caddy/sites/redclinic-website.caddy

[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

command -v git >/dev/null || { apt-get update -y -q; apt-get install -y -q git; }
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Node.js 22"; curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y -q nodejs
fi
command -v caddy >/dev/null || { echo "Caddy is not installed; install it first."; exit 1; }

if ss -tln | awk '{print $4}' | grep -q ":$PORT\$" && ! systemctl is-active -q redclinic-website; then
  echo "Port $PORT is already used by another program. Re-run with PORT=<free port>."; exit 1
fi

echo "==> User and folders"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR" && chown "$APP_USER:$APP_USER" "$DATA_DIR" && chmod 700 "$DATA_DIR"

echo "==> Code ($BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
( cd "$APP_DIR/website" && node build.mjs )
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  ADMIN_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-20)"
  cat > "$ENV_FILE" <<ENV
PORT=$PORT
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
User=$APP_USER
WorkingDirectory=$APP_DIR/website
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server/server.mjs
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
systemctl enable -q redclinic-website
systemctl restart redclinic-website

echo "==> Caddy site for $DOMAIN (other sites untouched)"
mkdir -p /etc/caddy/sites
cat > "$SITE_FILE" <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:$PORT
}
www.$DOMAIN {
  redir https://$DOMAIN{uri} permanent
}
CADDY
grep -q 'import /etc/caddy/sites/\*' /etc/caddy/Caddyfile || { cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%s)"; printf '\nimport /etc/caddy/sites/*\n' >> /etc/caddy/Caddyfile; }
if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  systemctl reload caddy
else
  echo "Caddy config invalid; not reloaded. See /tmp/caddy-validate.log"; tail -5 /tmp/caddy-validate.log; exit 1
fi

cat > /etc/cron.daily/redclinic-leads-backup <<'CRON'
#!/bin/sh
f=/var/lib/redclinic-website/demo-requests.jsonl
[ -f "$f" ] && mkdir -p /var/backups/redclinic && cp "$f" "/var/backups/redclinic/demo-requests-$(date +%F).jsonl" && find /var/backups/redclinic -name 'demo-requests-*' -mtime +30 -delete
CRON
chmod 755 /etc/cron.daily/redclinic-leads-backup

sleep 2
echo
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null && echo "WEBSITE RUNNING on port $PORT" || echo "WEBSITE FAILED: journalctl -u redclinic-website -n 50"
if [ "${NEW_PASSWORD:-}" = 1 ]; then
  echo
  echo "Demo requests page: https://$DOMAIN/admin/leads   user: founder"
  echo "Password: $ADMIN_PASSWORD"
  echo "Save it now. It is also stored in $ENV_FILE"
fi
