import { useState } from 'react';
import type { ArtistSourceOut } from '../api/types';
import { plural } from '../lib/format';
import { imageUrl } from '../lib/img';
import { BrandIcon, hasBrand } from './BrandIcon';
import { Icon } from './Icon';
import { cx } from './ui';

const OPEN_KEY = 'hm-artist-sources-open';
const num = (n: number) => n.toLocaleString('ru-RU');
const NAMES: Record<string, string> = { deezer: 'Deezer', lastfm: 'Last.fm', catalog: 'каталог' };

/** Under an artist's name: what is known of them, and where from.
 *
 * One line says it all together — the releases, the followers in the catalog, the listeners on Last.fm. An artist
 * may be known in several places — a catalog keeps more than one record of some, Last.fm knows them by the name —
 * so before the line stand those places' small pictures, and a tap lays them out: each with its service, the name
 * the artist has there, and its own numbers; a tap on one opens the artist's page there. Whether they are laid out
 * is kept on the device, for every artist's page. */
export function ArtistSources({ sources, releases }: { sources: ArtistSourceOut[]; /** the releases of the page, each once */ releases: number }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen((was) => {
      try {
        localStorage.setItem(OPEN_KEY, was ? '0' : '1');
      } catch {
        /* the choice just is not kept */
      }
      return !was;
    });
  };
  const followers = sources.reduce((n, s) => n + (s.followers ?? 0), 0);
  const listeners = sources.reduce((n, s) => n + (s.listeners ?? 0), 0);
  const line = [
    releases ? `${num(releases)} ${plural(releases, ['релиз', 'релиза', 'релизов'])}` : null,
    followers ? `${num(followers)} ${plural(followers, ['поклонник', 'поклонника', 'поклонников'])} в Deezer` : null,
    listeners ? `${num(listeners)} ${plural(listeners, ['слушатель', 'слушателя', 'слушателей'])} в Last.fm` : null,
  ].filter(Boolean).join(' · ');
  if (!sources.length) return line ? <div>{line}</div> : null;

  const picture = (s: ArtistSourceOut, size: string) => (
    <span className={cx('flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-fg/15', size)}>
      {s.picture_url ? <img src={imageUrl(s.picture_url) as string} alt="" loading="lazy" className="h-full w-full object-cover" /> : hasBrand(s.service) ? <BrandIcon service={s.service} size={14} /> : <Icon name="user" size={13} />}
    </span>
  );
  return (
    <div>
      <button type="button" onClick={toggle} aria-expanded={open} title={open ? 'Свернуть' : 'Где известен исполнитель'} className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-left">
        <span className="flex shrink-0 pl-1.5">
          {sources.map((s, i) => (
            <span key={`${s.service}:${s.ref ?? i}`} className="-ml-1.5 rounded-full ring-2 ring-bg">
              {picture(s, 'h-5 w-5')}
            </span>
          ))}
        </span>
        <span>{line}</span>
        {sources.length > 1 && (
          <span className="flex items-center gap-0.5 opacity-80">
            {sources.length} {plural(sources.length, ['профиль', 'профиля', 'профилей'])}
            <Icon name="chevron" size={12} className={open ? '-rotate-90' : 'rotate-90'} />
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-wrap gap-2 pt-2.5 [text-shadow:none]">
          {sources.map((s, i) => {
            const facts = [
              s.followers ? `${num(s.followers)} ${plural(s.followers, ['поклонник', 'поклонника', 'поклонников'])}` : null,
              s.listeners ? `${num(s.listeners)} ${plural(s.listeners, ['слушатель', 'слушателя', 'слушателей'])}` : null,
              s.releases ? `${num(s.releases)} ${plural(s.releases, ['релиз', 'релиза', 'релизов'])}` : null,
            ].filter(Boolean).join(' · ');
            const body = (
              <>
                <span className="relative shrink-0">
                  {picture(s, 'h-9 w-9')}
                  {s.picture_url && hasBrand(s.service) && (
                    <span className="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-surface ring-1 ring-line">
                      <BrandIcon service={s.service} size={11} />
                    </span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] leading-tight text-fg">{s.name}</span>
                  <span className="block truncate text-[11px] leading-tight text-muted">{[NAMES[s.service] ?? s.service, facts].filter(Boolean).join(' · ')}</span>
                </span>
              </>
            );
            const box = 'flex min-w-0 max-w-full items-center gap-2.5 rounded-xl border border-fg/25 bg-bg/60 py-1.5 pl-1.5 pr-3';
            return s.url ? (
              <a key={`${s.service}:${s.ref ?? i}`} href={s.url} target="_blank" rel="noopener noreferrer" title={`Открыть в ${NAMES[s.service] ?? 'каталоге'}`} className={cx(box, 'transition hover:border-fg')}>
                {body}
              </a>
            ) : (
              <span key={`${s.service}:${s.ref ?? i}`} className={box}>
                {body}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
