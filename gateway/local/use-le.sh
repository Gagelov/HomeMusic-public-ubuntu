#!/bin/sh
# Installs a new Let's Encrypt certificate for the public name and reloads Caddy.
# Usage: ./use-le.sh cert.pem key.pem
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/certs
CERT=${1:?pass cert.pem (full chain)}
KEY=${2:?pass key.pem}
[ -s "$CERT" ] && [ -s "$KEY" ] || { echo "empty certificate or key" >&2; exit 1; }
mkdir -p "$DIR"
cp -f "$CERT" "$DIR/le.crt"
cp -f "$KEY" "$DIR/le.key"
chmod 644 "$DIR/le.crt"
chmod 600 "$DIR/le.key"
docker restart homemusic_caddy >/dev/null
echo "installed $DIR/le.crt and le.key; Caddy restarted"
