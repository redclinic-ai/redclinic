#!/usr/bin/env bash
# Serves the staging app on another domain as well (HTTPS is set up automatically) and makes it the main address
# used in emails and links.   bash /opt/redclinic/src/scripts/server/set-domain.sh webapp1.navapilot.com
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
DOMAIN="${1:-}"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "Usage: set-domain.sh app.example.com"; exit 1; }
ENV_FILE=/etc/redclinic/staging.env
MY_IP=$(curl -fsS -4 -m 10 https://api.ipify.org || hostname -I | awk '{print $1}')
DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ "$DNS_IP" != "$MY_IP" ]; then
  echo "Warning: $DOMAIN points to '${DNS_IP:-nothing yet}', this server is $MY_IP."
  echo "Add an A record for it pointing to $MY_IP. HTTPS starts working once that is live (Caddy keeps retrying)."
fi
if ! grep -q "^$DOMAIN {" /etc/caddy/Caddyfile; then
  printf '\n%s {\n  encode gzip\n  reverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
sed -i "s|^APP_BASE_URL=.*|APP_BASE_URL=https://$DOMAIN|" "$ENV_FILE"
systemctl restart redclinic-staging
sleep 4
curl -fsS http://127.0.0.1:3000/api/health >/dev/null && echo "Done. Open https://$DOMAIN (give HTTPS a minute the first time)." || echo "App health check failed: journalctl -u redclinic-staging -n 50"
