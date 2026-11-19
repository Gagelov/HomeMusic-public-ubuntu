#!/bin/sh
# Keep Alice's media daemon single. HomeMusic stops it while streaming; after
# playback the Quasar launcher usually brings one back. A second copy would
# fight over ALSA and mute Alice, so the guard keeps the oldest and, when no
# copy is left at all, starts one for Alice's own voice and player.
DIR=$(cd "$(dirname "$0")" && pwd)
PID=$DIR/mediad-guard.pid

LOCK=$DIR/mediad-guard.lock
if ! mkdir "$LOCK" 2>/dev/null; then
    owner=$(cat "$LOCK/pid" 2>/dev/null)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
        exit 0
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"
trap '[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"; exit 0' 1 2 15

pids() {
    for d in /proc/[0-9]*; do
        p=${d#/proc/}
        [ -r "$d/cmdline" ] || continue
        c=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ')
        case "$c" in
            *"/system/vendor/quasar/maind --mediad"*) echo "$p" ;;
        esac
    done
}

echo $$ > "$PID"
while :; do
    if [ ! -f "$DIR/player.pid" ]; then
        all=$(pids)
        if [ -z "$all" ]; then
            ( cd /data/quasar 2>/dev/null || cd /
              LD_LIBRARY_PATH=:/system/vendor/quasar/libs MALLOC_ARENA_MAX=2 \
                CA_CERTIFICATES=/system/vendor/quasar/ca-certificates.crt \
                setsid /system/vendor/quasar/maind --mediad >> /data/quasar/mediad.log 2>&1 </dev/null & )
        else
            keep=$(printf '%s\n' "$all" | sed '/^$/d' | sort -n | head -1)
            for p in $all; do
                [ "$p" = "$keep" ] && continue
                kill -TERM "$p" 2>/dev/null
            done
        fi
    fi
    sleep 3
done
