#!/bin/sh
# The short commands with no "Алиса" (next, like, louder...) are recognised by
# maind's local command spotter and written to its log. While HomeMusic plays,
# send them to the same bridge that handles the cloud ASR text.
DIR=$(cd "$(dirname "$0")" && pwd)
PID=$DIR/command-watch.pid
LOG=/data/quasar/daemons_logs/maind.log
FIFO=$DIR/command-watch.fifo

LOCK=$DIR/command-watch.lock
if ! mkdir "$LOCK" 2>/dev/null; then
    owner=$(cat "$LOCK/pid" 2>/dev/null)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
        exit 0
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"

TAILPID=
cleanup() {
    [ -n "$TAILPID" ] && kill "$TAILPID" 2>/dev/null
    rm -f "$FIFO"
    [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
    exit 0
}
trap cleanup 1 2 15

echo $$ > "$PID"
while :; do
    [ -f "$LOG" ] || { sleep 2; continue; }
    rm -f "$FIFO"
    mkfifo "$FIFO" 2>/dev/null || { sleep 2; continue; }
    # tail writes into a fifo, the main shell reads it: no pipeline subshell is
    # left behind when the watcher is stopped.
    tail -n 0 -f "$LOG" > "$FIFO" 2>/dev/null &
    TAILPID=$!
    while IFS= read -r line; do
        case "$line" in
            *"Command phrase spotted:"*)
                cmd=${line##*Command phrase spotted:}
                cmd=${cmd#*^ }
                cmd=$(printf '%s' "$cmd" | sed -E 's/[[:space:]]+$//')
                [ -n "$cmd" ] && "$DIR/voice-bridge.sh" --test "$cmd"
                ;;
        esac
    done < "$FIFO"
    kill "$TAILPID" 2>/dev/null
    TAILPID=
    rm -f "$FIFO"
    sleep 1
done
