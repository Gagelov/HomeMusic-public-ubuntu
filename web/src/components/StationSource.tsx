import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { cx } from './ui';
import { selectSource, startStationPolling, stationNext, stationPrev, stationToggle, useStation } from '../lib/station';

/** The radio icon in the player: choose whether the sound comes from this device or the Station. */
export function StationSource({ compact = false }: { compact?: boolean }) {
  const source = useStation((s) => s.source);
  const status = useStation((s) => s.status);
  const busy = useStation((s) => s.busy);
  const error = useStation((s) => s.error);
  const [open, setOpen] = useState(false);
  const station = source === 'station';

  useEffect(() => {
    if (source === 'station') startStationPolling();
  }, [source]);

  const pick = (next: 'device' | 'station') => {
    setOpen(false);
    void selectSource(next);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'inline-flex h-9 items-center gap-1.5 rounded-full px-2 text-xs transition',
          station ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg',
        )}
        title="Источник звука: это устройство или Станция"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <img src="/icons/station-source.png" alt="" className="h-4 w-4 object-contain" />
        {!compact && <span className="hidden sm:inline">{station ? 'Станция' : 'Устройство'}</span>}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-fg/10 bg-raised p-2 shadow-2xl" role="menu">
          <div className="px-2 pb-1 pt-1 text-[11px] uppercase tracking-wide text-dim">Звук идёт</div>
          <button
            type="button"
            onClick={() => pick('device')}
            className={cx('flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-fg/5', !station && 'text-accent')}
            role="menuitemradio"
            aria-checked={!station}
          >
            <span>Это устройство</span>
            {!station && <span aria-hidden="true">●</span>}
          </button>
          <button
            type="button"
            onClick={() => pick('station')}
            className={cx('flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-fg/5', station && 'text-accent')}
            role="menuitemradio"
            aria-checked={station}
          >
            <span className="flex items-center gap-2">
              <img src="/icons/station-source.png" alt="" className="h-4 w-4 object-contain" />
              Станция
            </span>
            {station && <span aria-hidden="true">●</span>}
          </button>

          {busy && <div className="px-2 py-1 text-xs text-muted">Переключаю…</div>}
          {error && <div className="px-2 py-1 text-xs text-warn">{error}</div>}

          {station && (
            <div className="mt-2 border-t border-fg/10 pt-2">
              <div className="truncate px-2 text-sm font-medium">{status?.title || 'Станция молчит'}</div>
              <div className="truncate px-2 text-xs text-muted">{status?.artist || ''}</div>
              <div className="mt-1 flex items-center justify-center gap-1">
                <button type="button" onClick={() => void stationPrev()} disabled={busy || !status}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:text-fg disabled:opacity-40" aria-label="Предыдущий трек">
                  <Icon name="prev" size={20} />
                </button>
                <button type="button" onClick={() => void stationToggle()} disabled={busy || !status}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-fg text-bg disabled:opacity-40" aria-label={status?.paused ? 'Продолжить' : 'Пауза'}>
                  <Icon name={status?.paused ? 'play' : 'pause'} size={20} stroke={2.4} />
                </button>
                <button type="button" onClick={() => void stationNext()} disabled={busy || !status}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:text-fg disabled:opacity-40" aria-label="Следующий трек">
                  <Icon name="next" size={20} />
                </button>
              </div>
              {status && (
                <div className="px-2 text-center text-[11px] text-dim">
                  {status.playing ? 'играет' : status.paused ? 'пауза' : 'остановлено'} · {status.index + 1}/{status.queue}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
