#!/usr/bin/env bash
# Starts Postgres with TLS required; the key is copied in because Postgres only accepts one it owns with 0600.
set -euo pipefail

install -o postgres -g postgres -m 600 /secrets/db.key /var/lib/postgresql/server.key
install -o postgres -g postgres -m 644 /secrets/db.crt /var/lib/postgresql/server.crt

exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_min_protocol_version=TLSv1.2 \
  -c ssl_cert_file=/var/lib/postgresql/server.crt \
  -c ssl_key_file=/var/lib/postgresql/server.key \
  -c hba_file=/etc/postgresql/pg_hba.conf
