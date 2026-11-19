#!/bin/sh
# Tiny station-side HTTP API for the HomeMusic app.
# It runs under socat (one process per request), reads one HTTP request from
# stdin and answers on stdout. Only the LAN and the shared API_TOKEN are trusted.
DIR=$(cd "$(dirname "$0")" && pwd)
LOG=$DIR/api.log
TOKEN=$(sed -n 's/^API_TOKEN=//p' "$DIR/config" 2>/dev/null | head -1)

respond() { # $1 = status, $2 = json
    n=$(printf '%s' "$2" | wc -c)
    printf 'HTTP/1.1 %s\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "$1" "$n" "$2"
}

json() { "$DIR/hm-play.sh" json 2>/dev/null || printf '{"error":"player"}'; }

IFS= read -r request || exit 1
request=$(printf '%s' "$request" | tr -d '\r')
method=$(printf '%s' "$request" | cut -d' ' -f1)
path=$(printf '%s' "$request" | cut -d' ' -f2)
path=${path%%\?*}

ctype=
length=0
got=
while IFS= read -r line; do
    line=$(printf '%s' "$line" | tr -d '\r')
    [ -z "$line" ] && break
    name=$(printf '%s' "$line" | cut -d: -f1 | tr 'A-Z' 'a-z')
    value=$(printf '%s' "$line" | sed 's/^[^:]*:[[:space:]]*//')
    case "$name" in
        x-hm-token) got=$value ;;
        content-length) length=$value ;;
        content-type) ctype=$value ;;
    esac
done

body=
case "$length" in
    ''|*[!0-9]*) length=0 ;;
esac
[ "$length" -gt 0 ] && body=$(dd bs=1 count="$length" 2>/dev/null)

if [ -z "$TOKEN" ]; then
    respond '503 Service Unavailable' '{"error":"API_TOKEN is not set"}'
    exit 0
fi
if [ "$got" != "$TOKEN" ]; then
    respond '401 Unauthorized' '{"error":"bad token"}'
    exit 0
fi

case "$method $path" in
    'GET /health')
        respond '200 OK' '{"ok":true}' ;;
    'GET /status')
        respond '200 OK' "$(json)" ;;
    'POST /command')
        action=$(printf '%s' "$body" | /opt/bin/jq -r '.action // empty' 2>/dev/null || true)
        case "$action" in
            next|prev|pause|resume|stop|like|dislike)
                "$DIR/hm-play.sh" "$action" >/dev/null 2>&1
                respond '200 OK' "$(json)" ;;
            seek)
                pos=$(printf '%s' "$body" | /opt/bin/jq -r '(.position // 0) | floor')
                "$DIR/hm-play.sh" seek-to "$pos" >/dev/null 2>&1
                respond '200 OK' "$(json)" ;;
            volume)
                value=$(printf '%s' "$body" | /opt/bin/jq -r '(.value // 0) | floor')
                "$DIR/hm-play.sh" volume "$value" >/dev/null 2>&1
                respond '200 OK' "$(json)" ;;
            *)
                respond '400 Bad Request' '{"error":"unknown action"}' ;;
        esac ;;
    'POST /play')
        if ! printf '%s' "$body" | /opt/bin/jq -e '.tracks and (.tracks | length > 0)' >/dev/null 2>&1; then
            respond '400 Bad Request' '{"error":"empty tracks"}'
            exit 0
        fi
        idx=$(printf '%s' "$body" | /opt/bin/jq -r '(.index // 0) | floor')
        pos=$(printf '%s' "$body" | /opt/bin/jq -r '(.position // 0) | floor')
        printf '%s' "$body" | /opt/bin/jq -r '.tracks[] | [(.id | tostring), (.artist // ""), (.title // ""), ((.duration // 0) | tonumber | floor)] | @tsv' > "$DIR/queue.tsv"
        if [ -s "$DIR/queue.tsv" ] && "$DIR/hm-play.sh" play-queue "$idx" "$pos" >/dev/null 2>&1; then
            respond '200 OK' "$(json)"
        else
            respond '500 Internal Server Error' '{"error":"cannot start queue"}'
        fi ;;
    *)
        respond '404 Not Found' '{"error":"not found"}' ;;
esac
