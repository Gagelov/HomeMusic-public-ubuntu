# HTTPS для домашнего Hub

Схема: Caddy принимает HTTPS на **тех же портах** и проксирует Hub.

| Откуда | Адрес |
|---|---|
| LAN | `https://192.168.50.107:8080` или `https://music.example.local:8080` |
| Публично | `https://glvservice.asuscomm.com:8445` |
| Дополнительно (LAN) | `https://192.168.50.107` (443) |

Порты 8080 и 8445 сохранены — изменился только протокол. Hub больше не публикует свой 8080 наружу: на нём теперь Caddy.

## Запуск

```sh
cd /opt/homemusic
./gateway/local/make-cert.sh          # один раз: локальный CA + сертификат
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --no-build --no-deps hub caddy-https
```

Чтобы обычные `docker compose` / `homemusic.sh` тоже поднимали HTTPS, в `.env`:

```
COMPOSE_FILE=docker-compose.yml:apparmor-test.yml:docker-compose.https.yml
```

`apparmor-test.yml` нужен только на этом хосте (снимает AppArmor с новых контейнеров); на другом хосте его можно убрать.

Caddyfile читает `HTTPS_HUB_IP`, `HTTPS_HUB_NAME`, `HTTPS_PUBLIC_HOST` (значения по умолчанию — в `docker-compose.https.yml`).

## Доверие сертификату

Скачайте CA по **http** (только этот файл отдаётся по HTTP):

```
http://192.168.50.107/ca.crt
```

- **Windows:** двойной щелчок → «Установить сертификат» → Current User → «Доверенные корневые центры сертификации».
- **Android:** Настройки → Безопасность → Шифрование и учётные данные → Установить сертификат → Сертификат CA. Chrome доверяет пользовательским CA.
- **macOS:** Keychain Access → System → импорт → «Всегда доверять».
- **iOS:** открыть `.crt` → Настройки → Профиль → Установить; затем «О профиле» → Доверие сертификатам → включить полное доверие.

После этого PWA открывается без предупреждений, работает service worker и выбор аудиовыхода (`setSinkId` / `navigator.mediaDevices`).

## Обслуживание

- `ca.key` и `homemusic.key` лежат в `gateway/local/certs/` и в git не попадают.
- Сертификат выписан на 397 дней. Продление: удалить `homemusic.crt`/`homemusic.key` и снова запустить `make-cert.sh` — CA останется тем же, устройства переустанавливать не нужно. После этого перезапустить Caddy: `docker restart homemusic_caddy`.
- Не удаляйте `ca.key`: иначе всем устройствам придётся заново доверять новому CA.
- Проверка: `curl -k https://127.0.0.1:8080/healthz` → `200`.
