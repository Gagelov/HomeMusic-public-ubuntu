import { useState } from 'react';
import type { ArtistMapOut, CatalogArtist } from '../api/types';
import { useSession } from '../lib/session';
import { Icon } from './Icon';
import { Cover, ErrorState, Spinner, cx } from './ui';

/** Artists two ways: «Список» — rows of those the catalog holds to be alike; «Карта» — an artist in the middle and
 * those Last.fm holds to be near around them, the nearer the closer. The map is Last.fm's word, so a server without
 * a Last.fm key has no map at all — and no switch: only the list. The choice is remembered on this device, one for
 * every place the two are offered (the picker «Кого вы слушаете?», «Похожие» of an artist's page). */
export type ArtistsView = 'list' | 'map';

const KEY = 'hm-artists-view';

function remembered(): ArtistsView {
  try {
    return localStorage.getItem(KEY) === 'map' ? 'map' : 'list';
  } catch {
    return 'list';
  }
}

/** The view to show, the way to change it, and whether there is a choice. `first`: the view to open with this once
 * (a link that leads straight to the map), whatever is remembered. */
export function useArtistsView(first?: ArtistsView | null): [ArtistsView, (v: ArtistsView) => void, boolean] {
  const can = !!useSession().me.artist_map;
  const [view, setView] = useState<ArtistsView>(() => first ?? remembered());
  const set = (v: ArtistsView) => {
    setView(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* not remembered, then */
    }
  };
  return [can ? view : 'list', set, can];
}

/** «Список | Карта»: two words in one pill. */
export function ArtistsViewSwitch({ view, onChange }: { view: ArtistsView; onChange: (v: ArtistsView) => void }) {
  const one = (v: ArtistsView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => onChange(v)}
      className={cx('inline-flex h-8 items-center rounded-full px-3.5 text-[13px] transition', view === v ? 'bg-fg font-semibold text-bg' : 'text-muted hover:text-fg')}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Как показывать исполнителей" className="inline-flex shrink-0 rounded-full bg-raised p-0.5">
      {one('list', 'Список')}
      {one('map', 'Карта')}
    </div>
  );
}

const GOLDEN = 137.508; // degrees between neighbours: nobody stands behind anybody

/** The map: the artist in the middle, the others around — the nearest ones next to the middle and bigger, each
 * with how near they are in percent (the share of common listeners, as Last.fm counts it). A press on one of those
 * around is `onArtist`; on the one in the middle, `onCenter` (nothing, without it). `marked`: those shown as picked. */
export function ArtistMap({
  data,
  loading,
  error,
  onRetry,
  onArtist,
  onCenter,
  marked,
}: {
  data?: ArtistMapOut | null;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onArtist: (a: CatalogArtist) => void;
  onCenter?: (a: CatalogArtist) => void;
  marked?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}) {
  if (error) return <ErrorState text={error} onRetry={onRetry} />;
  if (!data)
    return (
      <div className="flex aspect-square max-h-[60vh] w-full items-center justify-center">
        <Spinner size={28} />
      </div>
    );
  const n = data.around.length;
  const best = Math.max(...data.around.map((x) => x.match), 0.01);
  const on = (ref: string) => !!marked?.has(ref);
  const node = (a: CatalogArtist, size: number, x: number, y: number, press: (() => void) | undefined, caption: string | null, key: string) => (
    <button
      key={key}
      type="button"
      onClick={press}
      disabled={!press}
      aria-pressed={marked ? on(a.ref) : undefined}
      aria-label={caption ? `${a.name}, близость ${caption}` : a.name}
      title={a.name}
      className="absolute flex w-[4.75rem] -translate-x-1/2 flex-col items-center text-center transition-transform enabled:hover:z-10 enabled:hover:scale-105 enabled:active:scale-95"
      style={{ left: `${x}%`, top: `${y}%`, marginTop: -size / 2 }}
    >
      <span className="relative">
        <Cover src={a.picture_small_url || a.picture_url} size={size} round icon="user" alt="" className={cx('shadow-lg transition', on(a.ref) && 'ring-[3px] ring-accent')} />
        {on(a.ref) && (
          <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-on-accent ring-2 ring-bg">
            <Icon name="check" size={12} stroke={3} />
          </span>
        )}
      </span>
      <span className={cx('mt-1 w-full truncate text-xs leading-tight', on(a.ref) ? 'font-semibold text-accent' : caption ? 'text-fg' : 'font-semibold text-fg')}>{a.name}</span>
      {caption && <span className="text-[11px] leading-tight text-dim">{caption}</span>}
    </button>
  );
  return (
    <div className={cx('transition-opacity', loading && 'opacity-50')}>
      <div className="relative mx-auto aspect-square w-full max-w-[34rem]">
        {/* how far is how near: rings to read the distance by */}
        {[52, 78].map((d) => (
          <span key={d} aria-hidden="true" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-fg/[0.07]" style={{ width: `${d}%`, height: `${d}%` }} />
        ))}
        {data.around.map((x, i) => {
          // nearest first: each next one a little farther out and a golden angle round
          const r = 26 + (n > 1 ? (i / (n - 1)) * 17 : 0);
          const at = ((-90 + i * GOLDEN) * Math.PI) / 180;
          const size = Math.round(40 + 24 * (x.match / best));
          return node(x.artist, size, 50 + r * Math.cos(at), 47 + r * Math.sin(at), () => onArtist(x.artist), `${Math.max(1, Math.round(x.match * 100))}%`, x.artist.ref);
        })}
        {node(data.center, 84, 50, 47, onCenter ? () => onCenter(data.center) : undefined, null, `center:${data.center.ref}`)}
      </div>
      {n === 0 ? (
        <p className="px-4 pb-2 text-center text-sm text-muted">Last.fm никого не знает рядом с {data.center.name} — попробуйте другого исполнителя</p>
      ) : (
        <p className="px-4 pb-2 text-center text-xs text-dim">Чем ближе к середине, тем больше общих слушателей — по данным Last.fm</p>
      )}
    </div>
  );
}
