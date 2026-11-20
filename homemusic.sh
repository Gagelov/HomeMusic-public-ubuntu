#!/usr/bin/env bash
# Toggle the HomeMusic stack on Ubuntu: starts it when it is off or partly down, stops it when it runs.
# Starts Docker Engine if it is not running. Never stops Docker itself: other containers may use it.
#
# Usage: ./homemusic.sh [start|stop|restart|status|toggle]
#   (no argument = toggle, with a confirmation before stopping)
set -u

cd "$(dirname "$(readlink -f "$0")")" || exit 1

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

# Use sudo only when the current user cannot talk to the Docker socket.
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    systemctl start docker >/dev/null 2>&1 || true
  elif command -v sudo >/dev/null 2>&1; then
    sudo systemctl start docker >/dev/null 2>&1 || true
    if ! docker info >/dev/null 2>&1; then
      DOCKER=(sudo docker)
    fi
  fi
fi
"${DOCKER[@]}" info >/dev/null 2>&1 || die "Docker недоступен.
Установите Docker Engine: sudo ./install-ubuntu.sh
Или разрешите текущему пользователю Docker: sudo usermod -aG docker $USER (затем выйдите и войдите снова)."

compose() { "${DOCKER[@]}" compose "$@"; }

compose config >/dev/null 2>&1 || die "Не удалось прочитать docker-compose.yml и .env в \"$PWD\"."

hub_healthy() {
  "${DOCKER[@]}" exec homemusic_hub python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)" \
    >/dev/null 2>&1
}

get_env() {
  [ -f .env ] || return 0
  awk -v key="$1" 'index($0, key "=") == 1 { v = substr($0, length(key) + 2); sub(/\r$/, "", v); print v; exit }' .env
}

public_url() {
  get_env "$1"
}

show_urls() {
  local hub music
  hub="$(public_url PUBLIC_HUB_URL)"
  music="$(public_url PUBLIC_MUSIC_URL)"
  say "  Хаб:       https://localhost:8080${hub:+  (снаружи: $hub)}"
  say "  Navidrome: https://localhost:4533${music:+  (снаружи: $music)}"
}

wait_hub() {
  local i
  for i in $(seq 1 60); do
    if hub_healthy; then return 0; fi
    sleep 3
  done
  return 1
}

start_stack() {
  local profiles
  profiles="$(get_env COMPOSE_PROFILES)"
  case ",$profiles," in
    *",vps,"*)
      if [ ! -s gateway/tunnel/tunnel_key ] || [ ! -s gateway/tunnel/known_hosts ]; then
        die "Профиль vps включён, но нет gateway/tunnel/tunnel_key или known_hosts.
Создайте их (README, «Запуск с нуля», шаг 4) или уберите vps из COMPOSE_PROFILES в .env."
      fi
      ;;
  esac
  say "Запускаю HomeMusic: Navidrome, Хаб, youtube-pot${profiles:+ (профили: $profiles)}..."
  compose up -d --remove-orphans || die "docker compose up завершился с ошибкой — подробности выше."
  say "Жду, пока Хаб ответит..."
  if ! wait_hub; then
    say "Хаб не ответил за 3 минуты. Последние строки лога:"
    compose logs --tail 50 homemusic_hub || true
    exit 1
  fi
  say ""
  say "HomeMusic включён."
  show_urls
}

stop_stack() {
  local active
  active="$("${DOCKER[@]}" exec homemusic_hub python -c \
    "import sqlite3; c=sqlite3.connect('file:/data/hub.sqlite3?mode=ro', uri=True); print(c.execute('select count(*) from download_items where status in (?,?,?,?,?)', ('queued','searching','downloading','tagging','importing')).fetchone()[0])" \
    2>/dev/null || echo 0)"
  if [ "${active:-0}" != "0" ]; then
    say "Загрузок в очереди: $active. Они продолжатся после включения."
  fi
  compose stop || die "docker compose stop завершился с ошибкой."
  say ""
  say "HomeMusic выключен. Docker Engine продолжает работать."
  say "После перезагрузки сервера HomeMusic останется выключенным, пока его не включить этим скриптом."
}

status_stack() {
  compose ps
  if hub_healthy; then say "Хаб отвечает: https://localhost:8080/healthz"; fi
}

case "${1:-toggle}" in
  start)
    start_stack
    ;;
  stop)
    stop_stack
    ;;
  restart)
    stop_stack
    start_stack
    ;;
  status)
    status_stack
    ;;
  toggle|"")
    created="$(compose ps -aq 2>/dev/null | wc -l | tr -d ' ')"
    running="$(compose ps -q --status running 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$created" -gt 0 ] && [ "$running" -eq "$created" ]; then
      say "HomeMusic работает."
      printf 'Выключить HomeMusic (у пользователей пропадёт музыка)? [y/N] '
      read -r answer || answer=""
      case "$answer" in
        y|Y|yes|YES|да|ДА|Д) stop_stack ;;
        *) say "Отменено." ;;
      esac
    else
      start_stack
    fi
    ;;
  -h|--help|help)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    die "Неизвестная команда: $1 (start|stop|restart|status|toggle)"
    ;;
esac
