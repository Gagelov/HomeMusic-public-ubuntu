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
NATIVE=$DIR/hm-native.sh
suppress() { "$NATIVE" cancel >>"$LOG" 2>&1; "$NATIVE" mute >>"$LOG" 2>&1; }
suppress_clear() { suppress; "$NATIVE" clear >>"$LOG" 2>&1; }
act() { suppress; "$PLAY" "$@" >>"$LOG" 2>&1; }
schedule_reassert() {
    seq=$(cat "$DIR/cmdseq" 2>/dev/null || echo 0)
    seq=$((seq + 1)); echo "$seq" > "$DIR/cmdseq"
    (
        sleep 2
        [ "$(cat "$DIR/cmdseq" 2>/dev/null)" = "$seq" ] || exit 0
        "$PLAY" reassert >>"$LOG" 2>&1
    ) &
}
act_reassert() { act "$@"; schedule_reassert; }

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

# BusyBox tr/y is byte-wise and mangles Cyrillic, so lower the letters one by
# one with sed.  The ASR capitalizes the first word ("Стоп", "Продолжи"), and
# the command patterns are lowercase.
lower() {
    printf '%s' "$1" | sed \
        -e 's/А/а/g' -e 's/Б/б/g' -e 's/В/в/g' -e 's/Г/г/g' -e 's/Д/д/g' \
        -e 's/Е/е/g' -e 's/Ё/ё/g' -e 's/Ж/ж/g' -e 's/З/з/g' -e 's/И/и/g' \
        -e 's/Й/й/g' -e 's/К/к/g' -e 's/Л/л/g' -e 's/М/м/g' -e 's/Н/н/g' \
        -e 's/О/о/g' -e 's/П/п/g' -e 's/Р/р/g' -e 's/С/с/g' -e 's/Т/т/g' \
        -e 's/У/у/g' -e 's/Ф/ф/g' -e 's/Х/х/g' -e 's/Ц/ц/g' -e 's/Ч/ч/g' \
        -e 's/Ш/ш/g' -e 's/Щ/щ/g' -e 's/Ъ/ъ/g' -e 's/Ы/ы/g' -e 's/Ь/ь/g' \
        -e 's/Э/э/g' -e 's/Ю/ю/g' -e 's/Я/я/g'
}

handle() {
    t=$(lower "$1")
    case "$t" in
        *через*сервер*|*с*сервер*|*из*сервер*|*homemusic*|*home?music*|"*home music*"|*хоммьюзик*|"*хом мьюзик*")
            # Alice also hears the phrase; stop her "track not found" reply
            # before we spend a second fetching the queue from Navidrome.
            "$DIR/hm-native.sh" cancel >>"$LOG" 2>&1
            "$DIR/hm-native.sh" mute >>"$LOG" 2>&1
            "$DIR/hm-native.sh" clear >>"$LOG" 2>&1
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
                note "resume ($1)"; act_reassert resume; return
            fi ;;
    esac

    active || return
    # "What is playing" is answered locally: the cloud does not know the
    # Navidrome track and otherwise starts audio recognition (Shazam-style).
    case "$t" in
        *"что сейчас"*|*"что играет"*|*"что за песн"*|*"какая песн"*|*"это за песн"*|*"что за трек"*)
            suppress_clear
            now=$("$PLAY" now 2>/dev/null)
            if [ -n "$now" ]; then
                note "now playing ($1): $now"
                "$NATIVE" say "Сейчас играет $now" >>"$LOG" 2>&1
            fi
            return ;;
    esac
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
        *перемот*|*отмотай*|*промотай*|*назад*на*|*вперёд*на*)
            note "seek ($1)"; act_reassert seek-phrase "$1" ;;
        *не*нрав*|*дизлайк*|*дислайк*)
            note "dislike ($1)"; act dislike ;;
        *лайк*|*нрав*)
            note "like ($1)"; act like ;;
        *следующ*|*дальше*|*переключ*)
            note "next ($1)"; act_reassert next ;;
        *предыдущ*|*верни*|*назад*)
            note "prev ($1)"; act_reassert prev ;;
        *пауза*)
            note "pause ($1)"; act_reassert pause ;;
        *стоп*|*останов*|*выключ*|*хватит*)
            note "stop ($1)"; act stop ;;
        *продолж*|*играй*дальше*|*включи*обратно*)
            note "resume ($1)"; act_reassert resume ;;
        *перемешай*|*вперемешку*|*случайн*)
            note "shuffle ($1)"; act_reassert shuffle ;;
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
