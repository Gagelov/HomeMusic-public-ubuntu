#!/bin/sh
# Keep Alice's media daemon single and alive.
#
# Native HomeMusic playback lives inside "maind --mediad": the station's own
# GStreamer player pulls the Navidrome stream. The guard therefore never stops
# mediad during playback; it only removes duplicates (two daemons fight over
# ALSA and mute Alice) and starts one if the launcher has not.
DIR=$(cd "$(dirname "$0")" && pwd)
PID=$DIR/mediad-guard.pid
LOG=$DIR/mediad-guard.log

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    exit 0
fi

echo $$ > "$PID"
trap '[ "$(cat "$PID" 2>/dev/null)" = "$$" ] && rm -rf "$PID"; exit 0' 1 2 15

pids() {
    for d in /proc/[0-9]*; do
        p=${d#/proc/}
        [ -r "$d/cmdline" ] || continue
        c=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ')
        case "$c" in *"/system/vendor/quasar/maind --mediad"*) echo "$p" ;; esac
    done
}

launcher_pid() {
    for d in /proc/[0-9]*; do
        [ -r "$d/cmdline" ] || continue
        c=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ')
        case "$c" in *"quasar_launcher"*) echo "${d#/proc/}"; return ;; esac
    done
}

start_mediad() {
    ( cd /data/quasar 2>/dev/null || cd /
      LD_LIBRARY_PATH=:/system/vendor/quasar/libs MALLOC_ARENA_MAX=2 \
        CA_CERTIFICATES=/system/vendor/quasar/ca-certificates.crt \
        setsid /system/vendor/quasar/maind --mediad >> /data/quasar/mediad.log 2>&1 </dev/null & )
}

while :; do
    all=$(pids)
    if [ -z "$all" ]; then
        start_mediad
    else
        lp=$(launcher_pid)
        keep=
        for p in $all; do
            ppid=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
            if [ -n "$lp" ] && [ "$ppid" = "$lp" ]; then keep=$p; break; fi
        done
        [ -n "$keep" ] || keep=$(printf '%s\n' "$all" | sed '/^$/d' | sort -n | head -1)
        for p in $all; do
            [ "$p" = "$keep" ] && continue
            kill -TERM "$p" 2>/dev/null
        done
    fi
    sleep 3
done
