#!/usr/bin/env bash
# Update staging to the latest code: pull, install, build, back up, migrate, restart.
#   bash /opt/redclinic/src/scripts/server/deploy.sh
set -euo pipefail
SRC=/opt/redclinic/src; RUN=/opt/redclinic/run; BRANCH=${BRANCH:-phase1-app-scaffold-auth}
set -a; . /etc/redclinic/staging.env; . /etc/redclinic/staging-admin.env; set +a
cd "$SRC"
export GIT_SSH_COMMAND="ssh -i /root/.ssh/redclinic_deploy -o StrictHostKeyChecking=accept-new"
git fetch -q origin "$BRANCH" && git checkout -q "$BRANCH" && git reset -q --hard "origin/$BRANCH"
export APP_VERSION=$(git rev-parse --short HEAD)
echo "Building $APP_VERSION ..."
NODE_ENV=development npm ci --no-audit --no-fund --loglevel=error
NEXT_TELEMETRY_DISABLED=1 npm run build >/tmp/redclinic-build.log 2>&1 || { tail -40 /tmp/redclinic-build.log; exit 1; }
[ "${1:-}" = "--first-run" ] || bash scripts/backup-db.sh /var/backups/redclinic >/dev/null
bash scripts/migrate.sh
rsync -a --delete .next/standalone/ "$RUN/" 2>/dev/null || { rm -rf "$RUN"/*; cp -a .next/standalone/. "$RUN/"; }
mkdir -p "$RUN/.next" && rm -rf "$RUN/.next/static" && cp -a .next/static "$RUN/.next/static"
grep -q '^APP_VERSION=' /etc/redclinic/staging.env && sed -i "s/^APP_VERSION=.*/APP_VERSION=$APP_VERSION/" /etc/redclinic/staging.env || echo "APP_VERSION=$APP_VERSION" >> /etc/redclinic/staging.env
chown -R redclinic:redclinic "$RUN"
if systemctl list-unit-files redclinic-staging.service >/dev/null 2>&1 && [ "${1:-}" != "--first-run" ]; then
  systemctl restart redclinic-staging; sleep 4
  curl -fsS http://127.0.0.1:3000/api/health >/dev/null && echo "Deployed $APP_VERSION. Health check OK." || echo "Health check failed: journalctl -u redclinic-staging -n 50"
fi
