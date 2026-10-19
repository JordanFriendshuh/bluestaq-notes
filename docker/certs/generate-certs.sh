#!/usr/bin/env bash
# Creates a local CA plus server certificates for Postgres and the API, once.
set -euo pipefail
cd /certs

if [[ -f ca.crt && -f db.crt && -f api.crt ]]; then
  echo "certificates already exist"
  exit 0
fi

openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout ca.key -out ca.crt -days 825 -subj "/CN=Team Notes Local CA"

issue() {
  local name=$1 san=$2
  openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$name.key" -out "$name.csr" -subj "/CN=$name"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "$name.crt" -days 825 -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth' "$san")
  rm "$name.csr"
}

issue db "DNS:db,DNS:localhost,IP:127.0.0.1"
issue api "DNS:api,DNS:localhost,IP:127.0.0.1"

chmod 644 ./*.crt
chmod 600 ca.key db.key api.key
# The API container runs as the node user (uid 1000) and must read its own key.
chown 1000:1000 api.key
echo "certificates created in ./certs"
