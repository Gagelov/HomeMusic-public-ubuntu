#!/bin/sh
# HomeMusic for Yandex Station Lite: stream only, no music cache.
# Commands: play liked|random|search <q>|playlist <q>|album <q>
#           next prev pause resume stop seek <±s> volume <N|+N|-N> like dislike shuffle duck on|off
export PATH=/opt/bin:/opt/sbin:/usr/bin:/bin:/usr/sbin:/sbin
DIR=$(cd "$(dirname "$0")" && pwd)
[ -f "$DIR/config" ] && . "$DIR/config"
SERVER=${SERVER:-http://192.168.50.107:4533}
USER=${USER:-admin}
PASSWORD=${PASSWORD:-}
LIMIT=${LIMIT:-100}
BASE="$SERVER/rest"
Q="u=$USER&p=$PASSWORD&v=1.16.1&c=homemusic-station&f=json"
LIST=$DIR/queue.tsv
IDX=$DIR/index
POS0=$DIR/pos
T0=$DIR/started
SEEK=$DIR/seek
PAUSED=$DIR/paused
PID=$DIR/player.pid
GUARD=$DIR/guard.pid
LEVEL=$DIR/level
DUCK=$DIR/duck
MEDIAD=/system/vendor/quasar/maind
APLAY=/usr/bin/aplay
FFMPEG=/opt/bin/ffmpeg
CURL=/opt/bin/curl
JQ=/opt/bin/jq
LOG=$DIR/player.log

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
master() { amixer sget Master 2>/dev/null | grep -o '\[[0-9]*%\]' | head -n 1 | tr -d '[]%'; }
pids_matching() {
    for d in /proc/[0-9]*; do
        p=${d#/proc/}
        [ "$p" = "$$" ] && continue
        [ -r "$d/cmdline" ] || continue
        c=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ')
        case "$c" in *"$1"*) echo "$p" ;; esac
    done
}
mediad_pids() { pids_matching "$MEDIAD --mediad"; }
running() { [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; }
position() { [ -f "$T0" ] || { echo 0; return; }; echo $(( $(cat "$POS0" 2>/dev/null || echo 0) + $(date +%s) - $(cat "$T0") )); }

curl_json() { "$CURL" -sS --max-time 25 "$1"; }
rows() { "$JQ" -r '.[]? | [(.id // ""), (.artist // ""), (.title // "")] | @tsv' 2>/dev/null; }

list_liked() {
    curl_json "$BASE/getStarred2?$Q" |
        "$JQ" -r '.["subsonic-response"].starred2.song[]? | [(.id // ""), (.artist // ""), (.title // "")] | @tsv'
}
list_random() {
    curl_json "$BASE/getRandomSongs?$Q&size=$LIMIT" |
        "$JQ" -r '.["subsonic-response"].randomSongs.song[]? | [(.id // ""), (.artist // ""), (.title // "")] | @tsv'
}
list_search() {
    q=$("$JQ" -rn --arg q "$1" '$q|@uri')
    curl_json "$BASE/search3?$Q&query=$q&songCount=50&artistCount=0&albumCount=0" |
        "$JQ" -r '.["subsonic-response"].searchResult3.song[]? | [(.id // ""), (.artist // ""), (.title // "")] | @tsv'
}
list_playlist() {
    name=$("$JQ" -rn --arg q "$1" '$q|ascii_downcase')
    pid=$(curl_json "$BASE/getPlaylists?$Q" |
        "$JQ" -r --arg q "$name" '.["subsonic-response"].playlists.playlist[]? | select((.name // "" | ascii_downcase) == $q) | .id' | head -1)
    [ -n "$pid" ] || return 1
    curl_json "$BASE/getPlaylist?$Q&id=$pid" |
        "$JQ" -r '.["subsonic-response"].playlist.entry[]? | [(.id // ""), (.artist // ""), (.title // "")] | @tsv'
}

stream_url() {
    id=$1
    echo "$BASE/stream?$Q&id=$id&format=mp3&maxBitRate=192"
}

stop_mediad() {
    p=$(mediad_pids)
    [ -n "$p" ] || return 0
    kill -TERM $p 2>/dev/null
    i=0
    while [ -n "$(mediad_pids)" ] && [ "$i" -lt 10 ]; do sleep 0.5; i=$((i + 1)); done
    for p in $(mediad_pids); do kill -9 "$p" 2>/dev/null; done
}
reset_dmix() {
    ipcs -m 2>/dev/null | awk '$1 == "0x00000400" || $1 == "0x00000401" { if ($6 > 0) busy = 1 } END { exit busy }' || return 1
    ipcrm -M 0x400 2>/dev/null; ipcrm -M 0x401 2>/dev/null; ipcrm -S 0x400 2>/dev/null
}

# Alice's mediad is restored by mediad-guard.sh: it watches player.pid and
# starts one daemon when playback has ended. hm-play never spawns a second one.

guard_mediad() {
    last=$(master)
    while [ -f "$PID" ]; do
        stop_mediad
        cur=$(master)
        [ "$cur" != "$last" ] && [ ! -f "$DUCK" ] && echo "$cur" > "$LEVEL"
        want=$(cat "$LEVEL" 2>/dev/null || echo 50)
        [ -f "$DUCK" ] && want=$((want / 3))
        [ "$cur" = "$want" ] || amixer -q set Master "$want%" 2>/dev/null
        last=$want
        sleep 0.5
    done
}

play_track() {
    id=$1; pos=${2:-0}
    [ -n "$id" ] || return 1
    mkdir -p "$DIR"
    echo "$pos" > "$POS0"
    date +%s > "$T0"
    url=$(stream_url "$id")
    log "stream $id from ${pos}s"
    # Stream straight into the speaker. No file is written.
    if [ "$pos" -gt 0 ]; then
        "$FFMPEG" -nostdin -hide_banner -loglevel error -ss "$pos" -i "$url" \
            -f s16le -ac 2 -ar 48000 - </dev/null 2>>"$DIR/ffmpeg.log" |
            "$APLAY" -q -D default -f S16_LE -c 2 -r 48000
    else
        "$FFMPEG" -nostdin -hide_banner -loglevel error -i "$url" \
            -f s16le -ac 2 -ar 48000 - </dev/null 2>>"$DIR/ffmpeg.log" |
            "$APLAY" -q -D default -f S16_LE -c 2 -r 48000
    fi
}

player_loop() {
    while :; do
        idx=$(cat "$IDX" 2>/dev/null || echo 0)
        [ "$idx" -lt 0 ] && idx=0 && echo 0 > "$IDX"
        line=$(sed -n "$((idx + 1))p" "$LIST")
        id=$(printf '%s' "$line" | cut -f1)
        [ -n "$id" ] || break
        pos=0
        [ -f "$SEEK" ] && { pos=$(cat "$SEEK"); rm -f "$SEEK"; }
        play_track "$id" "$pos"
        [ -f "$SEEK" ] && continue
        [ -f "$DIR/jump" ] && { rm -f "$DIR/jump"; continue; }
        echo $((idx + 1)) > "$IDX"
    done
    rm -f "$PID"
    [ -n "$LEVEL" ] && [ -s "$LEVEL" ] && amixer -q set Master "$(cat "$LEVEL")%" 2>/dev/null
    rm -f "$GUARD" "$DUCK"
}

start_player() {
    keep_seek=${1:-0}
    [ -s "$LIST" ] || return 1
    rm -f "$PAUSED" "$DUCK" "$DIR/jump"
    [ "$keep_seek" = "1" ] || rm -f "$SEEK"
    # Never raise the user's volume: at night it may be 5% or even 0.
    # Only a failed/empty mixer read falls back to a safe level.
    l=$(master); [ -n "$l" ] || l=30; echo "$l" > "$LEVEL"
    stop_mediad
    reset_dmix
    ( player_loop ) </dev/null >/dev/null 2>&1 &
    echo $! > "$PID"
    guard_mediad </dev/null >/dev/null 2>&1 &
    echo $! > "$GUARD"
    log "player started, queue $(wc -l < "$LIST")"
}

halt_player() {
    if [ -f "$PID" ]; then
        kill "$(cat "$PID")" 2>/dev/null
        rm -f "$PID" "$GUARD" "$DUCK"
        [ -s "$LEVEL" ] && amixer -q set Master "$(cat "$LEVEL")%" 2>/dev/null
        killall -q ffmpeg 2>/dev/null
        killall -q aplay 2>/dev/null
        sleep 1
    fi
}

seek_seconds() {
    n=$(printf '%s' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) *минут.*/\1/p')
    [ -n "$n" ] && { echo $((n * 60)); return; }
    n=$(printf '%s' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) *сек.*/\1/p')
    [ -n "$n" ] && { echo "$n"; return; }
    echo 10
}

like() {
    idx=$(cat "$IDX" 2>/dev/null || echo 0)
    id=$(sed -n "$((idx + 1))p" "$LIST" | cut -f1)
    [ -n "$id" ] || return 1
    "$CURL" -sS --max-time 10 "$BASE/star?$Q&id=$id" >/dev/null 2>&1
    log "like $id"
    # A short local confirmation; Alice is free to speak it.
    [ -x /opt/bin/socat ] && printf '%s' "$id" >/dev/null
}
dislike() {
    idx=$(cat "$IDX" 2>/dev/null || echo 0)
    id=$(sed -n "$((idx + 1))p" "$LIST" | cut -f1)
    [ -n "$id" ] || return 1
    "$CURL" -sS --max-time 10 "$BASE/unstar?$Q&id=$id" >/dev/null 2>&1
    log "dislike $id"
}
shuffle() {
    running || return 1
    awk 'BEGIN{srand()} {print rand() "\t" $0}' "$LIST" | sort -n | cut -f2- > "$LIST.new"
    mv "$LIST.new" "$LIST"
    echo -1 > "$IDX"; touch "$DIR/jump"; killall -q ffmpeg 2>/dev/null
}

case "$1" in
    play)
        shift; kind=$1; [ $# -gt 0 ] && shift
        halt_player; rm -f "$PAUSED" "$SEEK"
        case "$kind" in
            liked) list_liked > "$LIST" ;;
            search) list_search "$*" > "$LIST" ;;
            playlist) list_playlist "$*" > "$LIST" ;;
            *) list_random > "$LIST" ;;
        esac
        [ -s "$LIST" ] || list_random > "$LIST"
        [ -s "$LIST" ] || { log "empty queue for $kind $*"; exit 1; }
        echo 0 > "$IDX"
        start_player
        ;;
    next)
        running || exit 1
        idx=$(cat "$IDX" 2>/dev/null || echo 0)
        echo $((idx + 1)) > "$IDX"; touch "$DIR/jump"; killall -q ffmpeg 2>/dev/null
        [ -s "$LEVEL" ] && amixer -q set Master "$(cat "$LEVEL")%" 2>/dev/null ;;
    prev)
        running || exit 1
        idx=$(cat "$IDX" 2>/dev/null || echo 0)
        if [ "$(position)" -gt 5 ]; then echo 0 > "$SEEK"; else echo $((idx - 1)) > "$IDX"; fi
        touch "$DIR/jump"; killall -q ffmpeg 2>/dev/null
        [ -s "$LEVEL" ] && amixer -q set Master "$(cat "$LEVEL")%" 2>/dev/null ;;
    pause)
        running || exit 1
        pos=$(position); halt_player; echo "$pos" > "$SEEK"; date +%s > "$PAUSED" ;;
    resume)
        running && exit 0
        [ -f "$PAUSED" ] && [ -s "$LIST" ] || exit 1
        start_player 1 ;;
    stop)
        halt_player; rm -f "$PAUSED" "$SEEK" "$IDX" ;;
    seek)
        running || exit 1
        if [ "$2" = "0" ]; then to=0; else to=$(( $(position) + ${2:-10} )); [ "$to" -lt 0 ] && to=0; fi
        echo "$to" > "$SEEK"; killall -q ffmpeg 2>/dev/null ;;
    seek-phrase)
        running || exit 1
        s=$(seek_seconds "$*"); case "$*" in *назад*|*"назад "*) s=-$s ;; esac
        to=$(( $(position) + s )); [ "$to" -lt 0 ] && to=0
        echo "$to" > "$SEEK"; killall -q ffmpeg 2>/dev/null ;;
    volume)
        l=$(cat "$LEVEL" 2>/dev/null || master)
        case "$2" in +*) l=$((l + ${2#+})) ;; -*) l=$((l - ${2#-})) ;; *) l=$2 ;; esac
        [ "$l" -gt 100 ] && l=100; [ "$l" -lt 0 ] && l=0
        echo "$l" > "$LEVEL"; running || amixer -q set Master "$l%" 2>/dev/null ;;
    like) like ;;
    dislike) dislike ;;
    shuffle) shuffle ;;
    duck)
        case "$2" in on) touch "$DUCK" ;; off) rm -f "$DUCK" ;; esac ;;
    status)
        printf 'playing=%s index=%s position=%s master=%s\n' "$(running && echo yes || echo no)" "$(cat "$IDX" 2>/dev/null || echo 0)" "$(position)" "$(master)" ;;
    *)
        echo "usage: $0 play liked|random|search <q>|playlist <q>|album <q> | next | prev | pause | resume | stop | seek <±s> | volume <N|+N|-N> | like | dislike | shuffle"
        exit 2 ;;
esac
