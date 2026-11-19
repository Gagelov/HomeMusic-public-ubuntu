#!/bin/sh
# Temporarily stop the station from using Yandex Music while HomeMusic plays.
# Alice's cloud otherwise reacts to "next"/"continue" with its own music stream
# and tries to match the unknown session in the phone app.
#
# The station resolves through the stock unbound (127.0.0.1:53).  An NXDOMAIN
# local-zone catches the whole music domain, including rotating
# ext-strm-*.strm.yandex.net hosts, while Alice's uniproxy and the rest of
# yandex.net stay reachable.
DIR=$(cd "$(dirname "$0")" && pwd)
CONF=/etc/unbound/unbound.conf
BACKUP=$DIR/unbound.conf.homemusic
MARK='# homemusic-block'
LOG=$DIR/music-block.log

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

hup_unbound() {
    for d in /proc/[0-9]*; do
        [ "$(readlink "$d/exe" 2>/dev/null)" = "/usr/sbin/unbound" ] || continue
        kill -HUP "${d#/proc/}" 2>/dev/null
        return 0
    done
}

reload_unbound() {
    # A HUP re-reads the zones without dropping DNS/Alice for a second, which
    # matters because platformd reconnects its websocket on resolver hiccups.
    hup_unbound
}

blocked() { grep -q "$MARK" "$CONF" 2>/dev/null; }

on() {
    blocked && return 0
    [ -f "$CONF" ] || return 1
    [ -f "$BACKUP" ] || cp "$CONF" "$BACKUP" || return 1
    cat > "$DIR/unbound.homemusic.new" <<'EOF'
	# homemusic-block
	local-zone: "music.yandex.net." always_nxdomain
	local-zone: "music.yandex.ru." always_nxdomain
	local-zone: "music.yandex.com." always_nxdomain
	local-zone: "strm.yandex.net." always_nxdomain
EOF
    awk -v ins="$DIR/unbound.homemusic.new" '
        !done && /^forward-zone:/ { while ((getline line < ins) > 0) print line; done=1 }
        { print }
    ' "$BACKUP" > "$DIR/unbound.conf.new" || return 1
    mount -o remount,rw / 2>/dev/null
    cp "$DIR/unbound.conf.new" "$CONF" || { mount -o remount,ro / 2>/dev/null; return 1; }
    sync
    mount -o remount,ro / 2>/dev/null
    rm -f "$DIR/unbound.conf.new" "$DIR/unbound.homemusic.new"
    if ! /usr/sbin/unbound-checkconf "$CONF" >/dev/null 2>&1; then
        log "unbound config check failed, restoring"
        off
        return 1
    fi
    reload_unbound
    log "yandex music domains blocked"
}

off() {
    [ -f "$BACKUP" ] || return 0
    mount -o remount,rw / 2>/dev/null
    cp "$BACKUP" "$CONF" || { mount -o remount,ro / 2>/dev/null; return 1; }
    sync
    mount -o remount,ro / 2>/dev/null
    rm -f "$BACKUP"
    reload_unbound
    log "yandex music domains restored"
}

case "${1:-status}" in
    on) on ;;
    off) off ;;
    status) blocked && echo blocked || echo free ;;
    *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
