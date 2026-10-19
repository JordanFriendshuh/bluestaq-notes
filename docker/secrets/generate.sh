#!/usr/bin/env bash
# Creates the local stack's secrets once: a CA, server certificates for Postgres and the API, and a JWT signing key.
set -euo pipefail
cd /secrets

issue() {
  local name=$1 san=$2
  openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$name.key" -out "$name.csr" -subj "/CN=$name"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$name.crt" -days 825 -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth' "$san")
  rm "$name.csr"
}

if [[ ! -f ca.crt || ! -f db.crt || ! -f api.crt ]]; then
  openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout ca.key -out ca.crt -days 825 -subj "/CN=Team Notes Local CA"
  issue db "DNS:db,DNS:localhost,IP:127.0.0.1"
  issue api "DNS:api,DNS:localhost,IP:127.0.0.1"
  echo "certificates created"
fi

if [[ ! -f jwt.secret ]]; then
  openssl rand -hex 32 > jwt.secret
  echo "JWT signing key created"
fi

chmod 644 ./*.crt
chmod 600 ./*.key jwt.secret
# The API container runs as the node user (uid 1000) and must read its own key and the JWT secret.
chown 1000:1000 api.key jwt.secret
