#!/usr/bin/env bash
# HomeMusic installer for Ubuntu 24.04.
#
# Creates the music tree, .env and config.yaml, optionally installs Docker Engine, builds the images and starts
# the stack. Safe to re-run: existing secrets and settings in .env are kept.
#
# Usage:
#   sudo ./install-ubuntu.sh [options]
#
# Options:
#   --music-root PATH       music folder (default: /srv/music, or MUSIC_ROOT from an existing .env)
#   --with-embedder         enable the audio-vector service (COMPOSE_PROFILES=embedder)
#   --with-gpu              use the NVIDIA GPU for the embedder (nvidia-container-toolkit must be configured)
#   --with-vps              enable the reverse SSH tunnel and generate its key
#   --admin-password PASS   Navidrome admin password (default: keep the existing one or generate a random one)
#   --no-docker             do not install Docker Engine (it must already be installed)
#   --no-start              prepare files only; do not build or start the stack
#   -h, --help              show this help
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

MUSIC_ROOT=""
WITH_EMBEDDER=0
WITH_VPS=0
WITH_GPU=0
INSTALL_DOCKER=1
START=1
ADMIN_PASSWORD=""
GENERATED_ADMIN_PASSWORD=0

say() { printf '%s\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --music-root) MUSIC_ROOT="${2:-}"; shift 2 ;;
    --music-root=*) MUSIC_ROOT="${1#*=}"; shift ;;
    --with-embedder) WITH_EMBEDDER=1; shift ;;
    --with-gpu) WITH_GPU=1; WITH_EMBEDDER=1; shift ;;
    --with-vps) WITH_VPS=1; shift ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --admin-password=*) ADMIN_PASSWORD="${1#*=}"; shift ;;
    --no-docker) INSTALL_DOCKER=0; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный параметр: $1 (см. --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo: sudo ./install-ubuntu.sh"

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  say "Внимание: скрипт рассчитан на Ubuntu 24.04 (обнаружено: ${PRETTY_NAME:-неизвестно}). Продолжаю."
fi

get_env() {
  [ -f .env ] || return 0
  awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' .env
}

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

add_profile() {
  case ",${PROFILES}," in
    *",$1,"*) ;;
    *) PROFILES="${PROFILES:+$PROFILES,}$1" ;;
  esac
}

install_docker() {
  say "Устанавливаю Docker Engine..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  if curl -fsSL --retry 3 --connect-timeout 15 https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.asc; then
    install -d -m 0755 /etc/apt/keyrings
    install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc
    rm -f /tmp/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    if apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
      systemctl enable --now docker
      return
    fi
    say "Официальный репозиторий Docker не сработал — ставлю docker.io из Ubuntu."
    rm -f /etc/apt/sources.list.d/docker.list
  else
    say "download.docker.com недоступен — ставлю docker.io из Ubuntu."
  fi
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2
  systemctl enable --now docker
}

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  if [ "$INSTALL_DOCKER" = 1 ]; then
    install_docker
  else
    die "Docker Engine с плагином compose не установлен (--no-docker)."
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die "Docker не отвечает. Проверьте: systemctl status docker"

# --- .env -----------------------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  # a checkout on Windows may bring CRLF: Compose and the shell want plain LF
  sed -i 's/\r$//' .env
  chmod 600 .env
  say "Создан .env из .env.example."
fi

if [ -z "$MUSIC_ROOT" ]; then
  MUSIC_ROOT="$(get_env MUSIC_ROOT)"
fi
MUSIC_ROOT="${MUSIC_ROOT:-/srv/music}"
case "$MUSIC_ROOT" in
  /*) ;;
  *) die "MUSIC_ROOT должен быть абсолютным путём: $MUSIC_ROOT" ;;
esac
case "$MUSIC_ROOT" in
  *[[:space:]]*) die "MUSIC_ROOT не должен содержать пробелы (подстановка в docker-compose.yml): $MUSIC_ROOT" ;;
esac
set_env MUSIC_ROOT "$MUSIC_ROOT"

if [ -z "$(get_env ND_PASSWORDENCRYPTIONKEY)" ]; then
  set_env ND_PASSWORDENCRYPTIONKEY "$(openssl rand -hex 32)"
  say "Сгенерирован ND_PASSWORDENCRYPTIONKEY (не меняйте его после первого запуска)."
fi
if [ -z "$(get_env HUB_SECRET_KEY)" ]; then
  set_env HUB_SECRET_KEY "$(python3 -c 'import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"
  say "Сгенерирован HUB_SECRET_KEY."
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(get_env NAVIDROME_ADMIN_PASSWORD)"
fi
if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
  set_env NAVIDROME_ADMIN_PASSWORD "$ADMIN_PASSWORD"
  GENERATED_ADMIN_PASSWORD=1
fi
[ -n "$(get_env NAVIDROME_ADMIN_USER)" ] || set_env NAVIDROME_ADMIN_USER admin

HOST_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
if [ -n "$HOST_TZ" ] && [ "$(get_env TIMEZONE)" = "Europe/Moscow" ]; then
  set_env TIMEZONE "$HOST_TZ"
  say "TIMEZONE выставлен по серверу: $HOST_TZ"
fi

# --- profiles and GPU -------------------------------------------------------------------------
PROFILES="$(get_env COMPOSE_PROFILES)"
[ "$WITH_EMBEDDER" = 1 ] && add_profile embedder
[ "$WITH_VPS" = 1 ] && add_profile vps
set_env COMPOSE_PROFILES "$PROFILES"

GPU_READY=0
if [ "$WITH_GPU" = 1 ]; then
  if command -v nvidia-smi >/dev/null 2>&1 && docker info 2>/dev/null | grep -qi nvidia; then
    GPU_READY=1
  else
    say "Внимание: NVIDIA GPU или nvidia-container-toolkit не видны Docker."
    say "          Оставляю embedder на CPU; см. README, раздел «Видеокарта»."
  fi
fi
if [ "$GPU_READY" = 1 ]; then
  set_env COMPOSE_FILE "docker-compose.yml:docker-compose.gpu.yml"
  set_env EMBEDDER_DEVICE cuda
  set_env EMBEDDER_MEM_LIMIT 4g
  say "Embedder будет работать на GPU (COMPOSE_FILE добавлен в .env)."
else
  set_env EMBEDDER_DEVICE cpu
  if [ "$WITH_EMBEDDER" = 1 ]; then
    set_env EMBEDDER_MEM_LIMIT 8g
  fi
fi

# --- files and music tree ----------------------------------------------------------------------
if [ ! -f config.yaml ]; then
  cp config.example.yaml config.yaml
  say "Создан config.yaml из config.example.yaml."
fi

install -d -m 0755 "$MUSIC_ROOT" "$MUSIC_ROOT/library" "$MUSIC_ROOT/staging" \
  "$MUSIC_ROOT/.trash" "$MUSIC_ROOT/.backups" "$MUSIC_ROOT/.backups/hub" "$MUSIC_ROOT/.backups/navidrome"
# Navidrome runs as uid 1000 and writes its own backups
chown 1000:1000 "$MUSIC_ROOT/.backups/navidrome" 2>/dev/null || true
chmod 0755 "$MUSIC_ROOT/.backups/navidrome"
say "Папка музыки: $MUSIC_ROOT"

if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  usermod -aG docker "$SUDO_USER" 2>/dev/null || true
  say "Пользователь $SUDO_USER добавлен в группу docker (нужен повторный вход в систему)."
fi

# --- VPS tunnel --------------------------------------------------------------------------------
if [ "$WITH_VPS" = 1 ]; then
  VPS_HOST="$(get_env VPS_HOST)"
  if [ -z "$VPS_HOST" ] || [ "$VPS_HOST" = "203.0.113.10" ]; then
    read -r -p "IP или домен VPS: " VPS_HOST
    [ -n "$VPS_HOST" ] || die "VPS_HOST не задан."
    set_env VPS_HOST "$VPS_HOST"
  fi
  command -v ssh-keygen >/dev/null 2>&1 || apt-get install -y -qq openssh-client
  if [ ! -f gateway/tunnel/tunnel_key ]; then
    ssh-keygen -t ed25519 -N "" -C homemusic-tunnel -f gateway/tunnel/tunnel_key
  fi
  chmod 600 gateway/tunnel/tunnel_key
  if [ ! -s gateway/tunnel/known_hosts ]; then
    ssh-keyscan -T 10 -t ed25519 "$VPS_HOST" > gateway/tunnel/known_hosts 2>/dev/null || true
  fi
  if [ "$(get_env PUBLIC_HUB_URL)" = "https://203.0.113.10:8445" ] || [ -z "$(get_env PUBLIC_HUB_URL)" ]; then
    set_env PUBLIC_MUSIC_URL "https://${VPS_HOST}:8444"
    set_env PUBLIC_HUB_URL "https://${VPS_HOST}:8445"
  fi
  say ""
  say "Туннель включён. Публичный ключ (добавьте его на VPS через gateway/vps/setup-vps.sh):"
  cat gateway/tunnel/tunnel_key.pub
  say ""
  if [ ! -s gateway/tunnel/known_hosts ]; then
    say "Внимание: known_hosts пуст. Выполните: ssh-keyscan -t ed25519 $VPS_HOST > gateway/tunnel/known_hosts"
  fi
fi

# --- start -------------------------------------------------------------------------------------
if [ "$START" = 1 ]; then
  say ""
  say "Собираю образы и запускаю HomeMusic (первая сборка занимает несколько минут)..."
  docker compose up -d --build
  say "Жду, пока Хаб ответит..."
  HUB_OK=0
  for _ in $(seq 1 80); do
    if docker exec homemusic_hub python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)" \
      >/dev/null 2>&1; then
      HUB_OK=1
      break
    fi
    sleep 3
  done
  if [ "$HUB_OK" != 1 ]; then
    say "Хаб не ответил за 4 минуты. Последние строки лога:"
    docker compose logs --tail 60 homemusic_hub || true
    exit 1
  fi

  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  say ""
  say "HomeMusic запущен."
  say "  Хаб:       http://${IP:-localhost}:8080"
  say "  Navidrome: http://${IP:-localhost}:4533"
  if [ "$GENERATED_ADMIN_PASSWORD" = 1 ]; then
    say ""
    say "Логин Navidrome: admin"
    say "Пароль:          $ADMIN_PASSWORD  (сохранён в .env: NAVIDROME_ADMIN_PASSWORD)"
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    say ""
    say "UFW активен. Откройте порты: ufw allow 8080/tcp && ufw allow 4533/tcp"
  fi
  say ""
  say "Управление: ./homemusic.sh [start|stop|restart|status]"
else
  say ""
  say "Файлы подготовлены. Запуск: docker compose up -d --build"
  if [ "$GENERATED_ADMIN_PASSWORD" = 1 ]; then
    say "Пароль Navidrome (admin): $ADMIN_PASSWORD  (в .env)"
  fi
fi
