# HTTPS для домашнего Hub и Navidrome

Схема: Caddy принимает HTTPS на **тех же портах** и проксирует Hub и Navidrome.

| Откуда | Адрес | Куда | Сертификат |
|---|---|---|---|
| Публично и из LAN | `https://glvservice.asuscomm.com:8445` | Hub | Let's Encrypt (с роутера) |
| Публично и из LAN | `https://glvservice.asuscomm.com:8444` | Navidrome | Let's Encrypt (с роутера) |
| LAN по IP | `https://192.168.50.107:8080` | Hub | локальный CA |
| LAN по IP | `https://192.168.50.107:4533` | Navidrome | локальный CA |
| LAN по имени | `https://music.example.local:8080` | Hub | локальный CA |
| LAN по имени | `https://music.example.local:4533` | Navidrome | локальный CA |

Порты сохранены: Hub — 8080 (снаружи 8445), Navidrome — 4533 (снаружи 8444). Порты 80 и 443 не используются. Hub и Navidrome больше не публикуют свои порты на host: на них теперь Caddy.

Публичные адреса работают без установки сертификатов. Локальный CA нужен только для входа по IP/имени.

## Запуск

```sh
cd /opt/homemusic
./gateway/local/make-cert.sh          # локальный CA для LAN-адресов
./gateway/local/use-le.sh cert.pem key.pem   # Let's Encrypt для публичных имён
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --no-build --no-deps hub navidrome caddy-https
```

Чтобы обычные `docker compose` / `homemusic.sh` тоже поднимали HTTPS, в `.env`:

```
COMPOSE_FILE=docker-compose.yml:apparmor-test.yml:docker-compose.https.yml
```

`apparmor-test.yml` нужен только на этом хосте (снимает AppArmor с новых контейнеров); на другом хосте его можно убрать.

Caddyfile читает `HTTPS_HUB_IP`, `HTTPS_HUB_NAME`, `HTTPS_PUBLIC_HOST` (значения по умолчанию — в `docker-compose.https.yml`).

## Доверие локальному CA (только для LAN-адресов)

Скачайте CA по HTTPS с доверенного публичного адреса:

```
https://glvservice.asuscomm.com:8445/ca.crt
```

- **Windows:** двойной щелчок → «Установить сертификат» → Current User → «Доверенные корневые центры сертификации».
- **Android:** Настройки → Безопасность → Шифрование и учётные данные → Установить сертификат → Сертификат CA. Chrome доверяет пользовательским CA.
- **macOS:** Keychain Access → System → импорт → «Всегда доверять».
- **iOS:** открыть `.crt` → Настройки → Профиль → Установить; затем «О профиле» → Доверие сертификатам → включить полное доверие.

Для публичных адресов этого не нужно: там настоящий Let's Encrypt.

## Обслуживание

- `ca.key`, `homemusic.key` и `le.key` лежат в `gateway/local/certs/` и в git не попадают.
- Локальный сертификат выписан на 397 дней. Продление: удалить `homemusic.crt`/`homemusic.key` и снова запустить `make-cert.sh` — CA останется тем же.
- Let's Encrypt-сертификат роутер обновляет сам. Когда он обновится, положите новые `cert.pem` и `key.pem` и выполните `./gateway/local/use-le.sh cert.pem key.pem` (Caddy перезапустится сам).
- Не удаляйте `ca.key` и `le.key`.
- Проверка: `curl -k https://127.0.0.1:8080/healthz` → `200`; `curl https://glvservice.asuscomm.com:8445/healthz` → `200` без `-k`; `curl https://glvservice.asuscomm.com:8444/ping` → `200` без `-k`.
