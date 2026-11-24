#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for RedClinic STAGING (staging.redclinic.in).
# Run as root from the cloned repo:  bash /opt/redclinic/src/scripts/server/setup.sh
# Safe to run again: it keeps existing secrets and data.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
SRC=/opt/redclinic/src
ENV_FILE=/etc/redclinic/staging.env          # read by the app
ADMIN_FILE=/etc/redclinic/staging-admin.env  # owner connection: migrations, backups, admin script only
DOMAIN_STAGING=staging.redclinic.in
DOMAIN_APP=app.redclinic.in
say() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

say "1/9 System updates and basic tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq curl git ufw fail2ban unattended-upgrades ca-certificates postgresql postgresql-contrib caddy openssl rsync
dpkg-reconfigure -f noninteractive unattended-upgrades

say "2/9 Firewall (SSH, HTTP, HTTPS only)"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable
systemctl enable --now fail2ban

say "3/9 Swap (so the build fits in memory)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "4/9 Node.js 22"
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -yq nodejs
fi
node -v

say "5/9 App user, folders and secrets"
id redclinic >/dev/null 2>&1 || useradd --system --home /opt/redclinic --shell /usr/sbin/nologin redclinic
mkdir -p /etc/redclinic /var/lib/redclinic/staging/files /var/backups/redclinic /opt/redclinic/run
chown -R redclinic:redclinic /var/lib/redclinic /opt/redclinic/run
chmod 700 /var/lib/redclinic /var/backups/redclinic
if [ ! -f "$ENV_FILE" ]; then
  r() { openssl rand -hex "$1"; }
  OWNER_PW=$(r 24); APP_PW=$(r 24)
  umask 077
  cat > "$ENV_FILE" <<ENV
APP_ENV=staging
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
APP_BASE_URL=https://$DOMAIN_STAGING
DATABASE_URL=postgresql://rc_staging_web:$APP_PW@127.0.0.1:5432/rc_staging
STORAGE_DRIVER=local
STORAGE_DIR=/var/lib/redclinic/staging/files
STORAGE_SIGNING_SECRET=$(r 32)
CRON_SECRET=$(r 32)
TELEPHONY_WEBHOOK_SECRET=$(r 32)
BILLING_WEBHOOK_SECRET=$(r 32)
ALLOW_SIMULATED_TELEPHONY=1
ALLOW_SIMULATED_PAYMENTS=1
ENV
  echo "DATABASE_ADMIN_URL=postgresql://rc_staging_owner:$OWNER_PW@127.0.0.1:5432/rc_staging" > "$ADMIN_FILE"
  chmod 600 "$ENV_FILE" "$ADMIN_FILE"
fi
set -a; . "$ENV_FILE"; . "$ADMIN_FILE"; set +a
pw() { sed -E 's|.*://[^:]+:([^@]+)@.*|\1|' <<<"$1"; }
OWNER_PW=$(pw "$DATABASE_ADMIN_URL"); APP_PW=$(pw "$DATABASE_URL")

say "6/9 PostgreSQL database and roles"
systemctl enable --now postgresql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='rc_staging_owner') THEN
    CREATE ROLE rc_staging_owner LOGIN CREATEROLE PASSWORD '$OWNER_PW';
  END IF;
END\$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='rc_staging'" | grep -q 1 || sudo -u postgres createdb -O rc_staging_owner rc_staging
# Extensions need a superuser once; everything else runs as the owner role.
sudo -u postgres psql -d rc_staging -qc "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm;"

say "7/9 Build, migrate and start the app"
bash "$SRC/scripts/server/deploy.sh" --first-run
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='rc_staging_web') THEN
    CREATE ROLE rc_staging_web LOGIN PASSWORD '$APP_PW' IN ROLE rc_app;
  END IF;
END\$\$;
SQL

cat > /etc/systemd/system/redclinic-staging.service <<UNIT
[Unit]
Description=RedClinic staging
After=network.target postgresql.service
[Service]
User=redclinic
WorkingDirectory=/opt/redclinic/run
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/redclinic/staging /opt/redclinic/run
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT

say "8/9 Every-minute scheduler and daily backup"
cat > /usr/local/bin/redclinic-cron <<'CRON'
#!/usr/bin/env bash
set -a; . /etc/redclinic/staging.env; set +a
curl -fsS -m 50 -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/dialer >/dev/null
CRON
cat > /usr/local/bin/redclinic-backup <<'BAK'
#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/redclinic/staging-admin.env; set +a
bash /opt/redclinic/src/scripts/backup-db.sh /var/backups/redclinic
find /var/backups/redclinic -name '*.dump' -mtime +14 -delete
BAK
chmod 750 /usr/local/bin/redclinic-cron /usr/local/bin/redclinic-backup
unit() { # name, description, schedule, command
  printf '[Unit]\nDescription=%s\n[Service]\nType=oneshot\nExecStart=%s\n' "$2" "$4" > /etc/systemd/system/redclinic-$1.service
  printf '[Unit]\nDescription=%s\n[Timer]\nOnCalendar=%s\nPersistent=true\n[Install]\nWantedBy=timers.target\n' "$2" "$3" > /etc/systemd/system/redclinic-$1.timer
}
unit cron "RedClinic scheduler (workflows, calls, billing)" "minutely" /usr/local/bin/redclinic-cron
unit backup "RedClinic daily backup (03:00 IST)" "*-*-* 21:30:00 UTC" /usr/local/bin/redclinic-backup
systemctl daemon-reload
systemctl enable --now redclinic-staging redclinic-cron.timer redclinic-backup.timer
systemctl restart redclinic-staging

say "9/9 HTTPS (Caddy)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN_STAGING {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
$DOMAIN_APP {
  respond "RedClinic is launching soon." 200
}
CADDY
systemctl enable caddy >/dev/null; systemctl reload caddy || systemctl restart caddy

sleep 5
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  say "Done. Staging is running."
  echo "Open https://$DOMAIN_STAGING (HTTPS can take a minute to switch on)."
  echo "Next: create your super admin login:  bash $SRC/scripts/server/create-admin.sh"
else
  echo "The app did not answer its health check. Send the output of:  journalctl -u redclinic-staging -n 50 --no-pager"
fi
