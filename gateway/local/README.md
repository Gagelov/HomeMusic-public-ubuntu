# HTTPS для домашнего Hub и Navidrome

Схема: Caddy принимает HTTPS на **тех же портах** и проксирует Hub и Navidrome.

| Откуда | Адрес | Куда | Сертификат |
|---|---|---|---|
| LAN по IP | `https://192.168.50.107:8080` | Hub | локальный CA |
| LAN по IP | `https://192.168.50.107:4533` | Navidrome | локальный CA |
| LAN по имени | `https://music.example.local:8080` | Hub | локальный CA |
| LAN по имени | `https://music.example.local:4533` | Navidrome | локальный CA |

Порты сохранены: Hub — 8080, Navidrome — 4533. Порты 80 и 443 не используются. Hub и Navidrome больше не публикуют свои порты на host: на них теперь Caddy.

Для входа по IP/имени нужен локальный CA HomeMusic.

## Запуск

```sh
cd /opt/homemusic
./gateway/local/make-cert.sh          # локальный CA для LAN-адресов
./gateway/local/use-le.sh cert.pem key.pem   # внешний сертификат, если он нужен
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --no-build --no-deps hub navidrome caddy-https
```

Чтобы обычные `docker compose` / `homemusic.sh` тоже поднимали HTTPS, в `.env`:

```
COMPOSE_FILE=docker-compose.yml:apparmor-test.yml:docker-compose.https.yml
```

`apparmor-test.yml` нужен только на этом хосте (снимает AppArmor с новых контейнеров); на другом хосте его можно убрать.

Caddyfile читает `HTTPS_HUB_IP`, `HTTPS_HUB_NAME`, `HTTPS_PUBLIC_HOST` (значения по умолчанию — в `docker-compose.https.yml`).

## Доверие локальному CA

Скачайте CA по HTTPS:

```
https://192.168.50.107:8080/ca.crt
```

При первом открытии браузер предупредит: CA ещё не установлен. После установки предупреждение исчезнет.

- **Windows:** двойной щелчок → «Установить сертификат» → Current User → «Доверенные корневые центры сертификации».
- **Android:** Настройки → Безопасность → Шифрование и учётные данные → Установить сертификат → Сертификат CA. Chrome доверяет пользовательским CA.
- **macOS:** Keychain Access → System → импорт → «Всегда доверять».
- **iOS:** открыть `.crt` → Настройки → Профиль → Установить; затем «О профиле» → Доверие сертификатам → включить полное доверие.

## Обслуживание

- `ca.key`, `homemusic.key` и `le.key` лежат в `gateway/local/certs/` и в git не попадают.
- Локальный сертификат выписан на 397 дней. Продление: удалить `homemusic.crt`/`homemusic.key` и снова запустить `make-cert.sh` — CA останется тем же.
- Внешний сертификат (если используется) обновляется отдельно: положите новые `cert.pem` и `key.pem` и выполните `./gateway/local/use-le.sh cert.pem key.pem` (Caddy перезапустится сам).
- Не удаляйте `ca.key` и `le.key`.
- Проверка: `curl -k https://192.168.50.107:8080/healthz` → `200`; `curl -k https://192.168.50.107:4533/ping` → `200`.
