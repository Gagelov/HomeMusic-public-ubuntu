#!/bin/sh
# One socat listener for hm-api.sh (HTTP API on port 8099).
DIR=$(cd "$(dirname "$0")" && pwd)
PID=$DIR/api.pid
LOG=$DIR/api.log

if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    exit 0
fi
[ -x /opt/bin/socat ] || exit 1

( exec /opt/bin/socat TCP-LISTEN:8099,fork,reuseaddr EXEC:"$DIR/hm-api.sh" >>"$LOG" 2>&1 ) &
echo $! > "$PID"
echo "$(date '+%Y-%m-%d %H:%M:%S') api started pid=$!" >> "$LOG"
