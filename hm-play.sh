#!/bin/sh
# HomeMusic for Yandex Station Lite, native mode.
#
# Tracks are not downloaded: the station's own GStreamer player receives an
# audio_play directive and pulls the Navidrome stream itself. The station sees a
# normal music session, so its volume keys and player state keep working.
# hm-play.sh only keeps the queue and sends the next native directive.
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
PAUSED=$DIR/paused
PID=$DIR/native.pid
LOG=$DIR/player.log
CURL=/opt/bin/curl
JQ=/opt/bin/jq
NATIVE=$DIR/hm-native.sh

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
master() { amixer sget Master 2>/dev/null | grep -o '\[[0-9]*%\]' | head -n 1 | tr -d '[]%'; }
running() { [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null && [ ! -f "$PAUSED" ]; }
alive() { [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; }
active() { [ -f "$PAUSED" ] || alive; }
last_stream() { tail -n 400 /data/quasar/daemons_logs/maind.log 2>/dev/null | sed -n 's/.*AUDIO_PLAY streamId=\([^,]*\).*/\1/p' | tail -1; }
position() {
    [ -f "$PAUSED" ] && { cat "$PAUSED"; return; }
    [ -f "$T0" ] || { echo 0; return; }
    echo $(( $(cat "$POS0" 2>/dev/null || echo 0) + $(date +%s) - $(cat "$T0") ))
}
row() { sed -n "$(( $(cat "$IDX" 2>/dev/null || echo 0) + 1 ))p" "$LIST"; }
field() { row | cut -f"$1"; }
duration() { d=$(field 4); [ -n "$d" ] || d=0; echo "$d"; }

curl_json() { "$CURL" -sS --max-time 25 "$1"; }
rows() { "$JQ" -r '.[]? | [(.id // ""), (.artist // ""), (.title // ""), (.duration // 0)] | @tsv' 2>/dev/null; }

list_liked() {
    curl_json "$BASE/getStarred2?$Q" |
        "$JQ" -r '.["subsonic-response"].starred2.song[]? | [(.id // ""), (.artist // ""), (.title // ""), (.duration // 0)] | @tsv'
}
list_random() {
    curl_json "$BASE/getRandomSongs?$Q&size=$LIMIT" |
        "$JQ" -r '.["subsonic-response"].randomSongs.song[]? | [(.id // ""), (.artist // ""), (.title // ""), (.duration // 0)] | @tsv'
}
list_search() {
    q=$("$JQ" -rn --arg q "$1" '$q|@uri')
    curl_json "$BASE/search3?$Q&query=$q&songCount=50&artistCount=0&albumCount=0" |
        "$JQ" -r '.["subsonic-response"].searchResult3.song[]? | [(.id // ""), (.artist // ""), (.title // ""), (.duration // 0)] | @tsv'
}
list_playlist() {
    name=$("$JQ" -rn --arg q "$1" '$q|ascii_downcase')
    pid=$(curl_json "$BASE/getPlaylists?$Q" |
        "$JQ" -r --arg q "$name" '.["subsonic-response"].playlists.playlist[]? | select((.name // "" | ascii_downcase) == $q) | .id' | head -1)
    [ -n "$pid" ] || return 1
    curl_json "$BASE/getPlaylist?$Q&id=$pid" |
        "$JQ" -r '.["subsonic-response"].playlist.entry[]? | [(.id // ""), (.artist // ""), (.title // ""), (.duration // 0)] | @tsv'
}
stream_url() {
    echo "$BASE/stream?$Q&id=$1&format=mp3&maxBitRate=192"
}

ensure_mediad() {
    for d in /proc/[0-9]*; do
        [ -r "$d/cmdline" ] || continue
        c=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ')
        case "$c" in *"/system/vendor/quasar/maind --mediad"*) return 0 ;; esac
    done
    [ -x "$DIR/mediad-guard.sh" ] && ( cd "$DIR" && setsid "$DIR/mediad-guard.sh" >>"$DIR/mediad-guard.log" 2>&1 </dev/null & )
}

play_track() { # id, offset seconds
    id=$1; pos=${2:-0}
    [ -n "$id" ] || return 1
    title=$(sed -n "$(( $(cat "$IDX" 2>/dev/null || echo 0) + 1 ))p" "$LIST" | cut -f3)
    artist=$(sed -n "$(( $(cat "$IDX" 2>/dev/null || echo 0) + 1 ))p" "$LIST" | cut -f2)
    [ -n "$title" ] || title="HomeMusic"
    rm -f "$PAUSED"
    echo "$pos" > "$POS0"
    date +%s > "$T0"
    ensure_mediad
    "$NATIVE" play "$(stream_url "$id")" "$id" "$title" "$artist" "$pos"
    log "native play $id from ${pos}s: $artist - $title"
}

start_watch() {
    [ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null
    ( watch_loop ) </dev/null >/dev/null 2>&1 &
    echo $! > "$PID"
}

watch_loop() {
    # start_watch writes native.pid right after forking; do not exit before it.
    sleep 1
    while [ -f "$PID" ]; do
        if [ -f "$PAUSED" ]; then sleep 1; continue; fi
        d=$(duration)
        p=$(position)
        if [ "$d" -gt 0 ] && [ "$p" -ge $((d - 2)) ]; then
            idx=$(cat "$IDX" 2>/dev/null || echo 0)
            idx=$((idx + 1))
            echo "$idx" > "$IDX"
            line=$(sed -n "$((idx + 1))p" "$LIST")
            id=$(printf '%s' "$line" | cut -f1)
            if [ -z "$id" ]; then
                log "queue finished"
                "$NATIVE" stop
                rm -f "$PID" "$PAUSED"
                [ -x "$DIR/music-block.sh" ] && "$DIR/music-block.sh" off >>"$LOG" 2>&1
                break
            fi
            play_track "$id" 0
            continue
        fi
        sleep 2
    done
}

start_player() {
    [ -s "$LIST" ] || return 1
    [ -x "$DIR/music-block.sh" ] && "$DIR/music-block.sh" on >>"$LOG" 2>&1
    rm -f "$PAUSED"
    idx=$(cat "$IDX" 2>/dev/null || echo 0)
    id=$(sed -n "$((idx + 1))p" "$LIST" | cut -f1)
    [ -n "$id" ] || return 1
    start_watch
    play_track "$id" 0
    log "native player started, queue $(wc -l < "$LIST")"
}

halt_player() {
    "$NATIVE" stop
    [ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null
    rm -f "$PID" "$PAUSED" "$POS0" "$T0"
    [ -x "$DIR/music-block.sh" ] && "$DIR/music-block.sh" off >>"$LOG" 2>&1
}

like() {
    id=$(field 1); [ -n "$id" ] || return 1
    "$CURL" -sS --max-time 10 "$BASE/star?$Q&id=$id" >/dev/null 2>&1
    log "like $id"
}
dislike() {
    id=$(field 1); [ -n "$id" ] || return 1
    "$CURL" -sS --max-time 10 "$BASE/unstar?$Q&id=$id" >/dev/null 2>&1
    log "dislike $id"
}
shuffle() {
    [ -s "$LIST" ] || return 1
    awk 'BEGIN{srand()} {print rand() "\t" $0}' "$LIST" | sort -n | cut -f2- > "$LIST.new"
    mv "$LIST.new" "$LIST"
    [ "$(running && echo yes)" = yes ] && { echo 0 > "$IDX"; play_track "$(field 1)" 0; }
}

seek_seconds() {
    n=$(printf '%s' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) *минут.*/\1/p')
    [ -n "$n" ] && { echo $((n * 60)); return; }
    n=$(printf '%s' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) *сек.*/\1/p')
    [ -n "$n" ] && { echo "$n"; return; }
    echo 10
}

case "$1" in
    play)
        shift; kind=$1; [ $# -gt 0 ] && shift
        halt_player
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
        (alive || [ -f "$PAUSED" ]) || exit 1
        idx=$(cat "$IDX" 2>/dev/null || echo 0)
        echo $((idx + 1)) > "$IDX"
        id=$(field 1)
        if [ -z "$id" ]; then echo "$idx" > "$IDX"; exit 0; fi
        rm -f "$PAUSED"
        play_track "$id" 0
        alive || start_watch
        ;;
    prev)
        (alive || [ -f "$PAUSED" ]) || exit 1
        idx=$(cat "$IDX" 2>/dev/null || echo 0)
        if [ "$(position)" -gt 5 ]; then
            id=$(field 1); rm -f "$PAUSED"; play_track "$id" 0
        else
            idx=$((idx - 1)); [ "$idx" -lt 0 ] && idx=0
            echo "$idx" > "$IDX"; rm -f "$PAUSED"; play_track "$(field 1)" 0
        fi
        alive || start_watch
        ;;
    pause)
        (alive || [ -f "$PAUSED" ]) || exit 1
        [ -f "$PAUSED" ] && exit 0
        pos=$(position)
        "$NATIVE" pause
        echo "$pos" > "$PAUSED"
        log "paused at ${pos}s"
        ;;
    resume)
        [ -f "$PAUSED" ] || exit 0
        pos=$(cat "$PAUSED")
        rm -f "$PAUSED"
        play_track "$(field 1)" "$pos"
        alive || start_watch
        ;;
    stop)
        halt_player
        rm -f "$IDX"
        ;;
    seek)
        (alive || [ -f "$PAUSED" ]) || exit 1
        if [ "$2" = "0" ]; then to=0; else to=$(( $(position) + ${2:-10} )); [ "$to" -lt 0 ] && to=0; fi
        if [ -f "$PAUSED" ]; then echo "$to" > "$PAUSED"; else rm -f "$PAUSED"; play_track "$(field 1)" "$to"; fi
        ;;
    seek-phrase)
        (alive || [ -f "$PAUSED" ]) || exit 1
        s=$(seek_seconds "$*"); case "$*" in *назад*|*"назад "*) s=-$s ;; esac
        to=$(( $(position) + s )); [ "$to" -lt 0 ] && to=0
        if [ -f "$PAUSED" ]; then echo "$to" > "$PAUSED"; else rm -f "$PAUSED"; play_track "$(field 1)" "$to"; fi
        ;;
    volume)
        l=$(cat "$DIR/level" 2>/dev/null || master)
        case "$2" in +*) l=$((l + ${2#+})) ;; -*) l=$((l - ${2#-})) ;; *) l=$2 ;; esac
        [ "$l" -gt 100 ] && l=100; [ "$l" -lt 0 ] && l=0
        echo "$l" > "$DIR/level"; amixer -q set Master "$l%" 2>/dev/null ;;
    like) like ;;
    dislike) dislike ;;
    shuffle) shuffle ;;
    duck) : ;;
    now)
        active || exit 0
        a=$(field 2); t=$(field 3)
        if [ -n "$a" ]; then printf '%s — %s\n' "$a" "$t"; else printf '%s\n' "$t"; fi
        ;;
    reassert)
        active || exit 0
        if [ -f "$PAUSED" ]; then
            "$NATIVE" pause
        else
            id=$(field 1)
            # The cloud sometimes sends its own next/continue after ours. Only
            # replace the session if our stream is no longer the active one.
            [ "$(last_stream)" = "$id" ] && exit 0
            play_track "$id" "$(position)"
        fi
        ;;
    status)
        t=$(active && field 3)
        printf 'playing=%s index=%s position=%s master=%s title=%s\n' \
            "$(running && echo yes || echo no)" \
            "$(cat "$IDX" 2>/dev/null || echo 0)" \
            "$(position)" \
            "$(master)" \
            "$t"
        ;;
    *)
        echo "usage: $0 play liked|random|search <q>|playlist <q> | next | prev | pause | resume | stop | seek <±s> | like | dislike | shuffle" >&2
        exit 2 ;;
esac
