# HTTPS для домашнего Hub

Схема: Caddy принимает HTTPS на **тех же портах** и проксирует Hub.

| Откуда | Адрес | Сертификат |
|---|---|---|
| Публично и из LAN | `https://glvservice.asuscomm.com:8445` | Let's Encrypt (с роутера) |
| LAN по IP | `https://192.168.50.107:8080` | локальный CA |
| LAN по имени | `https://music.example.local:8080` | локальный CA |

Порты 8080 и 8445 сохранены — изменился только протокол. Порты 80 и 443 не используются. Hub больше не публикует свой 8080 наружу: на нём теперь Caddy.

Публичный адрес работает без установки сертификатов. Локальный CA нужен только для входа по IP/имени, когда публичный адрес недоступен.

## Запуск

```sh
cd /opt/homemusic
./gateway/local/make-cert.sh          # локальный CA для LAN-адресов
./gateway/local/use-le.sh cert.pem key.pem   # Let's Encrypt для публичного имени
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --no-build --no-deps hub caddy-https
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

Для публичного адреса `https://glvservice.asuscomm.com:8445` этого не нужно: там настоящий Let's Encrypt.

## Обслуживание

- `ca.key`, `homemusic.key` и `le.key` лежат в `gateway/local/certs/` и в git не попадают.
- Локальный сертификат выписан на 397 дней. Продление: удалить `homemusic.crt`/`homemusic.key` и снова запустить `make-cert.sh` — CA останется тем же.
- Let's Encrypt-сертификат роутер обновляет сам. Когда он обновится, положите новые `cert.pem` и `key.pem` и выполните `./gateway/local/use-le.sh cert.pem key.pem` (Caddy перезапустится сам).
- Не удаляйте `ca.key` и `le.key`.
- Проверка: `curl -k https://127.0.0.1:8080/healthz` → `200`; `curl https://glvservice.asuscomm.com:8445/healthz` → `200` без `-k`.
