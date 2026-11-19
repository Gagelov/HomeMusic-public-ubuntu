import { navigate } from '../lib/router';
import { selectSource, stationConfigured, useStation } from '../lib/station';
import { toast } from '../lib/ui';
import { cx } from './ui';

/** The radio in the player bar: one tap sends the sound to the Station, another brings it back here. */
export function StationSource() {
  const source = useStation((s) => s.source);
  const busy = useStation((s) => s.busy);
  const station = source === 'station';

  const click = () => {
    if (!stationConfigured()) {
      toast('Укажите токен станции в меню «Яндекс Станция»', 'info');
      navigate('/station');
      return;
    }
    void selectSource(station ? 'device' : 'station');
  };

  return (
    <button
      type="button"
      onClick={click}
      disabled={busy}
      aria-pressed={station}
      className={cx(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40',
        station ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-fg/5 hover:text-fg',
      )}
      title={station ? 'Играет на Станции — переключить на это устройство' : 'Играть на Яндекс Станции'}
      aria-label={station ? 'Переключить звук на это устройство' : 'Играть на Яндекс Станции'}
    >
      <img src="/icons/station-source.png" alt="" className="h-[18px] w-[18px] object-contain invert" />
    </button>
  );
}
