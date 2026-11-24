#!/usr/bin/env bash
# Creates your RedClinic super admin login on staging. The password is typed here, never sent anywhere else.
set -euo pipefail
set -a; . /etc/redclinic/staging.env; . /etc/redclinic/staging-admin.env; set +a
read -rp "Your email: " SUPER_ADMIN_EMAIL
read -rp "Your name: " SUPER_ADMIN_NAME
read -rsp "Choose a password (14+ characters): " SUPER_ADMIN_PASSWORD; echo
export SUPER_ADMIN_EMAIL SUPER_ADMIN_NAME SUPER_ADMIN_PASSWORD
cd /opt/redclinic/src && npx tsx scripts/create-super-admin.mts
