#!/bin/sh
# Voice bridge for HomeMusic: Alice's local ASR text -> hm-play.sh.
# Only phrases with "через сервер"/"с сервера" start HomeMusic; while HomeMusic
# is playing, the usual music commands are sent to it. Everything else is left
# to Alice and Yandex Music.
export PATH=/opt/bin:/opt/sbin:/usr/bin:/bin:/usr/sbin:/sbin
DIR=$(cd "$(dirname "$0")" && pwd)
PLAY=$DIR/hm-play.sh
LOG=$DIR/voice.log
PID=$DIR/bridge.pid

note() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
active() { [ -f "$DIR/paused" ] || { [ -f "$DIR/native.pid" ] && kill -0 "$(cat "$DIR/native.pid")" 2>/dev/null; }; }
playing() { [ ! -f "$DIR/paused" ] && active; }

query_after() {
    # $1 = full phrase, $2 = regexp-ish word to remove before the query
    printf '%s' "$1" | sed -E \
        -e 's/^ *(алиса[, ]*)?//' \
        -e 's/(включи|поставь|играй|запусти|найди) *//' \
        -e 's/(через|с|из|на) *(наш|нашего|домашний|домашнего)? *сервер[а-я]*//' \
        -e 's/(через|с|из) *home ?music//' \
        -e 's/(пожалуйста|пожалуйсто)//' \
        -e 's/^ *//; s/ *$//'
}

handle() {
    t=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
    case "$t" in
        *через*сервер*|*с*сервер*|*из*сервер*|*homemusic*|*home?music*|"*home music*"|*хоммьюзик*|"*хом мьюзик*")
            # Alice also hears the phrase; stop her "track not found" reply
            # before we spend a second fetching the queue from Navidrome.
            "$DIR/hm-native.sh" cancel >>"$LOG" 2>&1
            "$DIR/hm-native.sh" mute >>"$LOG" 2>&1
            q=$(query_after "$t")
            case "$t" in
                *любим*|*избранн*|*сердеч*)
                    note "play liked ($1)"; "$PLAY" play liked >>"$LOG" 2>&1 ;;
                *плейлист*)
                    q=$(printf '%s' "$q" | sed -E 's/.*плейлист[а-я]* *//; s/^ *//')
                    note "play playlist $q ($1)"; "$PLAY" play playlist "$q" >>"$LOG" 2>&1 ;;
                *исполнител*)
                    q=$(printf '%s' "$q" | sed -E 's/.*исполнител[а-я]* *//; s/^ *//')
                    note "play artist $q ($1)"; "$PLAY" play search "$q" >>"$LOG" 2>&1 ;;
                *музык*|*что-нибудь*|"*что нибудь*")
                    note "play random ($1)"; "$PLAY" play random >>"$LOG" 2>&1 ;;
                *)
                    if [ -n "$q" ]; then
                        note "play search $q ($1)"; "$PLAY" play search "$q" >>"$LOG" 2>&1
                    else
                        note "play random (empty)"; "$PLAY" play random >>"$LOG" 2>&1
                    fi ;;
            esac
            return ;;
    esac

    # Resume must work while HomeMusic is paused: the player is stopped at that
    # moment, so the playing-only block below would swallow the command.
    case "$t" in
        *продолж*|*"играй дальше"*|*"включи обратно"*)
            if [ -f "$DIR/paused" ]; then
                note "resume ($1)"; "$PLAY" resume >>"$LOG" 2>&1; return
            fi ;;
    esac

    active || return
    # A normal Yandex Music request is not ours: stop the stream and let Alice
    # handle it. Transport/feedback commands are still ours.
    case "$t" in
        *включи*|*поставь*|*играй*|*найди*)
            case "$t" in
                *следующ*|*предыдущ*|*пауза*|*продолж*|*стоп*|*останов*|*выключ*|*громче*|*тише*|*лайк*|*нрав*|*перемот*|*перемешай*|*вперемешку*|*обратно*) ;;
                *) note "release to Yandex ($1)"; "$PLAY" stop >>"$LOG" 2>&1; return ;;
            esac ;;
    esac
    case "$t" in
        *перемот*|*секунд*|*минут*|*назад*на*|*вперёд*на*)
            note "seek ($1)"; "$PLAY" seek-phrase "$1" >>"$LOG" 2>&1 ;;
        *не*нрав*|*дизлайк*|*дислайк*)
            note "dislike ($1)"; "$PLAY" dislike >>"$LOG" 2>&1 ;;
        *лайк*|*нрав*)
            note "like ($1)"; "$PLAY" like >>"$LOG" 2>&1 ;;
        *следующ*|*дальше*|*переключ*)
            note "next ($1)"; "$PLAY" next >>"$LOG" 2>&1 ;;
        *предыдущ*|*верни*|*назад*)
            note "prev ($1)"; "$PLAY" prev >>"$LOG" 2>&1 ;;
        *пауза*)
            note "pause ($1)"; "$PLAY" pause >>"$LOG" 2>&1 ;;
        *стоп*|*останов*|*выключ*|*хватит*)
            note "stop ($1)"; "$PLAY" stop >>"$LOG" 2>&1 ;;
        *продолж*|*играй*дальше*|*включи*обратно*)
            note "resume ($1)"; "$PLAY" resume >>"$LOG" 2>&1 ;;
        *перемешай*|*вперемешку*|*случайн*)
            note "shuffle ($1)"; "$PLAY" shuffle >>"$LOG" 2>&1 ;;
    esac
}

if [ "$1" = "--test" ]; then
    shift
    handle "$*"
    exit 0
fi

# One bridge per station. A pid file is not enough: repeated starts overwrite it
# and leave old bridges alive, each spawning its own alice-text/socat pair.
LOCK=$DIR/voice-bridge.lock
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

echo $$ > "$PID"
note "bridge started"
"$DIR/alice-text.sh" | while IFS= read -r line; do
    case "$line" in
        "@state "*) continue ;;
    esac
    handle "$(printf '%b' "$line")"
done
rm -f "$PID"
rm -rf "$LOCK"
