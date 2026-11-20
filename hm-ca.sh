#!/bin/sh
# Lets the station trust the local HomeMusic CA for Navidrome over LAN HTTPS.
# Appends the CA once to the certificate bundles used by curl (Entware) and GStreamer (Quasar).
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
CA=$DIR/ca.crt
[ -s "$CA" ] || exit 0
line=$(sed -n '2p' "$CA")
[ -n "$line" ] || exit 0

for f in /system/vendor/quasar/certs/ca-certificates.crt /opt/etc/ssl/certs/ca-certificates.crt; do
    [ -f "$f" ] || continue
    grep -qF "$line" "$f" 2>/dev/null && continue
    cat "$CA" >> "$f" 2>/dev/null || echo "hm-ca: cannot write $f"
done
