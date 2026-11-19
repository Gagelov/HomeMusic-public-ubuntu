import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { StationStatus } from '../api/types';
import { Button, Field, Notice, PageHeader } from '../components/ui';
import { saveStationConfig, startStationWatch, stationConfig, stationHeaders } from '../lib/station';
import { toast } from '../lib/ui';

/** «Яндекс Станция» in the menu: the address of the station API and its token. */
export function StationPage() {
  const initial = stationConfig();
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState(initial.token);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<StationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    saveStationConfig(url, token);
    startStationWatch();
    toast('Настройки станции сохранены', 'success');
  };

  const test = async () => {
    saveStationConfig(url, token);
    startStationWatch();
    setBusy(true);
    setError(null);
    setTested(null);
    try {
      setTested(await api.stationStatus(stationHeaders()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl pb-8">
      <PageHeader title="Яндекс Станция" back="/more" />
      <div className="space-y-4 px-4">
        <div className="flex items-center gap-3 rounded-2xl bg-surface p-4">
          <span aria-hidden="true" className="station-icon h-12 w-12 shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="font-semibold">Звук на колонке</div>
            <div className="text-sm text-muted">
              Токен даёт приложению право включать очередь и переключать треки на Станции.
            </div>
          </div>
        </div>

        <Field label="Адрес API станции">
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://192.168.50.181:8099"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Токен">
          <input
            className="input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button block variant="primary" icon="check" onClick={save}>
            Сохранить
          </Button>
          <Button block icon="refresh" busy={busy} onClick={() => void test()}>
            Проверить связь
          </Button>
        </div>

        {tested && (
          <Notice kind="info">
            Станция отвечает: {tested.playing ? `играет «${tested.title}» — ${tested.artist}` : tested.paused ? 'пауза' : 'сейчас молчит'}.
          </Notice>
        )}
        {error && <Notice kind="error">{error}</Notice>}

        <p className="px-1 text-xs leading-5 text-dim">
          Токен лежит на станции в <code>/data/opt/homemusic/config</code>, строка <code>API_TOKEN</code>.
          Адрес по умолчанию — <code>http://192.168.50.181:8099</code>; его можно изменить, если у колонки
          другой IP. Токен хранится только в этом браузере и уходит на Хаб по HTTPS.
        </p>
      </div>
    </div>
  );
}
