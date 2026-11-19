#!/bin/sh
# Native playback for HomeMusic on Yandex Station Lite.
#
# The station's own IPC bus (127.0.0.1:9875) accepts quasar.proto.Directive
# frames (type 253 = 211) and routes them through the real directive sequencer.
# An audio_play directive therefore starts the factory GStreamer player: the
# station reports a normal music session and keeps its own volume/player state.
# No ALSA takeover, no ffmpeg/aplay, no cached files.
#
# The same bus also exposes AliceCapability methods (type 253 = 210), which we
# use to cancel Alice's spoken reply before our track starts.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
SOCAT=${SOCAT:-/opt/bin/socat}
SOCK=${SOCK:-127.0.0.1:9875}
TMP=${TMPDIR:-/tmp}/hm-native.$$
mkdir -p "$TMP" || exit 1
trap 'rm -rf "$TMP"; exit 1' 1 2 15

OUT=
put_varint() { # $1 = unsigned number
    v=$1
    while [ "$v" -ge 128 ]; do
        printf "\\$(printf '%03o' $(( (v & 127) | 128 )))" >> "$OUT"
        v=$((v >> 7))
    done
    printf "\\$(printf '%03o' "$v")" >> "$OUT"
}

put_bytes() { # $1 = field, $2 = text
    n=$(printf '%s' "$2" | wc -c)
    put_varint $(( ($1 << 3) | 2 ))
    put_varint "$n"
    printf '%s' "$2" >> "$OUT"
}

put_file() { # $1 = field, $2 = file
    n=$(wc -c < "$2")
    put_varint $(( ($1 << 3) | 2 ))
    put_varint "$n"
    cat "$2" >> "$OUT"
}

put_uint() { # $1 = field, $2 = value
    put_varint $(( $1 << 3 ))
    put_varint "$2"
}

json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '
}

write_frame() { # $1 = message type, $2 = payload file, $3 = output file
    OUT=$TMP/env.bin
    : > "$OUT"
    put_file 252 "$2"
    put_uint 253 "$1"
    n=$(wc -c < "$OUT")
    {
        printf "\\$(printf '%03o' $(( n & 255 )))"
        printf "\\$(printf '%03o' $(( (n >> 8) & 255 )))"
        printf "\\$(printf '%03o' $(( (n >> 16) & 255 )))"
        printf "\\$(printf '%03o' $(( (n >> 24) & 255 )))"
        cat "$OUT"
    } > "$3"
}

send_frame() { # $1 = message type, $2 = payload file
    write_frame "$1" "$2" "$TMP/send.bin"
    "$SOCAT" -T 2 - "TCP:$SOCK" < "$TMP/send.bin" >/dev/null 2>&1
}

# Legacy directive name + JSON payload (the cloud's client_action format).
directive() { # $1 = name, $2 = json
    OUT=$TMP/dir.bin
    : > "$OUT"
    put_bytes 1 "$1"
    put_bytes 6 "$2"
    send_frame 211 "$TMP/dir.bin"
}

# AliceCapability request: cancel the dialog / stop the reply.
alice_method() { # $1 = method number
    OUT=$TMP/req.bin
    : > "$OUT"
    put_uint 1 "$1"
    OUT=$TMP/remote.bin
    : > "$OUT"
    put_bytes 7 "AliceCapability"
    put_file 8 "$TMP/req.bin"
    send_frame 210 "$TMP/remote.bin"
}

# PlaybackControlCapability method: 0 play, 1 pause, 6 next, 7 prev.
playback_control() { # $1 = method number
    OUT=$TMP/pc.bin
    : > "$OUT"
    put_uint 1 "$1"
    OUT=$TMP/remote.bin
    : > "$OUT"
    put_bytes 7 "PlaybackControlCapability"
    put_file 13 "$TMP/pc.bin"
    send_frame 210 "$TMP/remote.bin"
}

play_directive() { # url stream-id title subtitle offset-seconds
    url=$1; sid=$2; title=$(json_escape "$3"); sub=$(json_escape "$4"); pos=$5
    esc_url=$(json_escape "$url")
    json='{"stream":{"id":"'"$sid"'","url":"'"$esc_url"'","format":"MP3","offset_ms":'"$((pos * 1000))"'},"metadata":{"title":"'"$title"'","subtitle":"'"$sub"'"},"background_mode":"Ducking","screen_type":"Default","provider_name":"HomeMusic","set_pause":false,"scenario_meta":{"url":"'"$esc_url"'","title":"'"$title"'","qid":"homemusic","provider_name":"HomeMusic"}}'
    directive audio_play "$json"
}

alice_vocalize() { # text
    OUT=$TMP/voc.bin
    : > "$OUT"
    put_bytes 1 "$1"
    put_uint 2 1
    OUT=$TMP/req.bin
    : > "$OUT"
    put_uint 1 18
    put_uint 3 1
    put_file 13 "$TMP/voc.bin"
    OUT=$TMP/remote.bin
    : > "$OUT"
    put_bytes 7 "AliceCapability"
    put_file 8 "$TMP/req.bin"
    OUT=$TMP/sub.req
    : > "$OUT"
    put_bytes 1 "AliceCapability"
    OUT=$TMP/sub.remote
    : > "$OUT"
    put_bytes 7 "AliceCapability"
    put_file 20 "$TMP/sub.req"
    write_frame 210 "$TMP/sub.remote" "$TMP/f1.bin"
    write_frame 210 "$TMP/remote.bin" "$TMP/f2.bin"
    cat "$TMP/f1.bin" "$TMP/f2.bin" > "$TMP/send.bin"
    "$SOCAT" -T 3 - "TCP:$SOCK" < "$TMP/send.bin" >/dev/null 2>&1
}

case "${1:-}" in
    play)   play_directive "${2:?url}" "${3:?id}" "${4:-}" "${5:-}" "${6:-0}" ;;
    say)    alice_vocalize "${2:?text}" ;;
    pause)  playback_control 1 ;;
    resume) playback_control 0 ;;
    next)   playback_control 6 ;;
    prev)   playback_control 7 ;;
    stop)   directive player_continue '{}' ;;
    cancel) alice_method 1 ;;
    mute)   alice_method 14 ;;
    clear)  alice_method 6 ;;
    pc)     playback_control "${2:?method}" ;;
    *)
        echo "usage: $0 play <url> <id> [title] [subtitle] [offset_sec] | say <text> | pause | resume | next | prev | stop | cancel | mute | clear | pc <method>" >&2
        exit 2 ;;
esac
rm -rf "$TMP"
