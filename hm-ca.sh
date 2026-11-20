#!/bin/sh
# Lets the station trust the local HomeMusic CA for Navidrome over LAN HTTPS.
# Appends the CA once to the certificate bundles used by curl (Entware) and GStreamer (Quasar).
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
CA=$DIR/ca.crt
MARK=$DIR/ca.changed
[ -s "$CA" ] || exit 0
line=$(sed -n '2p' "$CA")
[ -n "$line" ] || exit 0

changed=0
for f in /system/vendor/quasar/certs/ca-certificates.crt /opt/etc/ssl/certs/ca-certificates.crt; do
    [ -f "$f" ] || continue
    grep -qF "$line" "$f" 2>/dev/null && continue
    if cat "$CA" >> "$f" 2>/dev/null; then
        changed=1
    else
        echo "hm-ca: cannot write $f"
    fi
done
[ "$changed" = 1 ] && : > "$MARK"
exit 0
