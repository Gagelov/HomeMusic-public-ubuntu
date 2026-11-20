#!/bin/sh
# Makes the local CA and the Hub's certificate once. The CA is what every device installs:
#   http://<this host>/ca.crt
# The certificate covers the LAN IP, the LAN name and the router's public name.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/certs
HUB_IP=${HTTPS_HUB_IP:-192.168.50.107}
HUB_NAME=${HTTPS_HUB_NAME:-music.example.local}
PUBLIC_HOST=${HTTPS_PUBLIC_HOST:-glvservice.asuscomm.com}
DAYS=${HTTPS_CERT_DAYS:-397}

if [ -s "$DIR/homemusic.crt" ] && [ -s "$DIR/homemusic.key" ] && [ -s "$DIR/ca.crt" ]; then
    echo "certificates already exist in $DIR"
    exit 0
fi

mkdir -p "$DIR"
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$DIR/ca.key" -out "$DIR/ca.crt" \
    -subj "/CN=HomeMusic Local CA" >/dev/null 2>&1

cat > "$DIR/leaf.ext" <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$HUB_NAME, DNS:$PUBLIC_HOST, IP:$HUB_IP
EOF

openssl req -newkey rsa:2048 -nodes \
    -keyout "$DIR/homemusic.key" -out "$DIR/homemusic.csr" \
    -subj "/CN=HomeMusic" >/dev/null 2>&1
openssl x509 -req -in "$DIR/homemusic.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
    -CAcreateserial -out "$DIR/homemusic.crt" -days "$DAYS" -extfile "$DIR/leaf.ext" >/dev/null 2>&1

rm -f "$DIR/homemusic.csr" "$DIR/ca.srl" "$DIR/leaf.ext"
chmod 644 "$DIR/ca.crt" "$DIR/homemusic.crt"
chmod 600 "$DIR/homemusic.key" "$DIR/ca.key"
echo "made $DIR/ca.crt, homemusic.crt, homemusic.key for $HUB_IP, $HUB_NAME, $PUBLIC_HOST"
