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
 * One line says it all together — the followers in the catalog, the listeners on Last.fm (how many releases there
 * are is said by «Дискография», where they are). An artist
 * may be known in several places — a catalog keeps more than one record of some, Last.fm knows them by the name —
 * so before the line stand those places' small round pictures. A tap on them (or on the line) lays them out: each
 * round picture grows into a plate of its own — the service, the name the artist has there, its own numbers — and
 * a tap on a plate opens the artist's page there. Laid out, the plates say everything the line did, so the line is
 * not shown: after the plates stands the button that folds them back. Whether they are laid out is kept on the
 * device, for every artist's page. */
export function ArtistSources({ sources }: { sources: ArtistSourceOut[] }) {
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
    followers ? `${num(followers)} ${plural(followers, ['поклонник', 'поклонника', 'поклонников'])} в Deezer` : null,
    listeners ? `${num(listeners)} ${plural(listeners, ['слушатель', 'слушателя', 'слушателей'])} в Last.fm` : null,
  ].filter(Boolean).join(' · ');
  if (!sources.length) return line ? <div>{line}</div> : null;

  const move = 'transition-all duration-300 ease-out';
  return (
    // folded, it is one line whatever the width: the round pictures, then the words — cut short where they do not fit
    <div className={cx('flex min-w-0 items-center gap-x-2', open && 'flex-wrap')}>
      {/* the places: round pictures, one over the edge of another — or, laid out, a plate each */}
      <div className={cx('flex items-center [text-shadow:none]', open ? 'w-full flex-wrap pb-1' : 'shrink-0 cursor-pointer pl-1.5')} onClick={open ? undefined : toggle}>
        {sources.map((s, i) => {
          const facts = [
            s.followers ? `${num(s.followers)} ${plural(s.followers, ['поклонник', 'поклонника', 'поклонников'])}` : null,
            s.listeners ? `${num(s.listeners)} ${plural(s.listeners, ['слушатель', 'слушателя', 'слушателей'])}` : null,
            s.releases ? `${num(s.releases)} ${plural(s.releases, ['релиз', 'релиза', 'релизов'])}` : null,
          ].filter(Boolean).join(' · ');
          const body = (
            <>
              <span className="relative shrink-0">
                <span className={cx('flex items-center justify-center overflow-hidden rounded-full bg-fg/15', move, open ? 'h-9 w-9' : 'h-5 w-5 ring-2 ring-bg')}>
                  {s.picture_url ? <img src={imageUrl(s.picture_url) as string} alt="" loading="lazy" className="h-full w-full object-cover" /> : hasBrand(s.service) ? <BrandIcon service={s.service} size={open ? 16 : 11} /> : <Icon name="user" size={12} />}
                </span>
                {s.picture_url && hasBrand(s.service) && (
                  <span className={cx('absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-surface ring-1 ring-line', move, open ? 'scale-100 opacity-100' : 'scale-0 opacity-0')}>
                    <BrandIcon service={s.service} size={11} />
                  </span>
                )}
              </span>
              <span className={cx('min-w-0 overflow-hidden whitespace-nowrap', move, open ? 'max-w-[22rem] opacity-100' : 'max-w-0 opacity-0')}>
                <span className="block truncate text-[13px] leading-tight text-fg">{s.name}</span>
                <span className="block truncate text-[11px] leading-tight text-muted">{[NAMES[s.service] ?? s.service, facts].filter(Boolean).join(' · ')}</span>
              </span>
            </>
          );
          // laid out, a place is its picture and its words — nothing under them: the head stays light
          const box = cx('flex min-w-0 max-w-full items-center', move, open ? 'mb-1 mr-5 gap-2.5 py-1 [text-shadow:0_1px_8px_rgb(0_0_0/0.6)] hover:opacity-80' : '-ml-1.5 gap-0');
          const key = `${s.service}:${s.ref ?? i}`;
          return s.url ? (
            // folded, a tap lays the places out; laid out, it opens the artist's page there
            <a key={key} href={s.url} target="_blank" rel="noopener noreferrer" tabIndex={open ? 0 : -1} title={open ? `Открыть в ${NAMES[s.service] ?? 'каталоге'}` : undefined} onClick={(e) => !open && e.preventDefault()} className={box}>
              {body}
            </a>
          ) : (
            <span key={key} className={box}>
              {body}
            </span>
          );
        })}
        {/* laid out, the plates say it all: the line is not repeated — only the way to fold them back */}
        {open && (
          <button type="button" onClick={toggle} aria-expanded aria-label="Свернуть" title="Свернуть" className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg/70 transition hover:text-fg">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      {!open && (
        <button type="button" onClick={toggle} aria-expanded={false} title={line} className="min-w-0 flex-1 truncate text-left">
          {line}
        </button>
      )}
    </div>
  );
}

/** The same places as buttons of the page's row (a computer, where the row has the room): after the artist's other
 * projects and a thin line — each a round picture with the service's mark, the name the artist has there, and how
 * many follow or listen. A tap opens the artist's page there. The line under the picture is not shown then. */
export function ArtistSourceButtons({ sources }: { sources: ArtistSourceOut[] }) {
  if (!sources.length) return null;
  return (
    <>
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-fg/25" />
      {sources.map((s, i) => {
        const n = s.followers ?? s.listeners;
        const what = s.followers ? plural(s.followers, ['поклонник', 'поклонника', 'поклонников']) : s.listeners ? plural(s.listeners, ['слушатель', 'слушателя', 'слушателей']) : '';
        const body = (
          <>
            <span className="relative shrink-0">
              <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-fg/15">
                {s.picture_url ? <img src={imageUrl(s.picture_url) as string} alt="" loading="lazy" className="h-full w-full object-cover" /> : hasBrand(s.service) ? <BrandIcon service={s.service} size={15} /> : <Icon name="user" size={13} />}
              </span>
              {s.picture_url && hasBrand(s.service) && (
                <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-surface ring-1 ring-line">
                  <BrandIcon service={s.service} size={10} />
                </span>
              )}
            </span>
            <span className="truncate">{s.name}</span>
            {n ? <span className="shrink-0 tabular-nums text-dim">{num(n)}</span> : null}
          </>
        );
        const box = 'flex h-9 min-w-0 items-center gap-2 rounded-full border border-fg/40 pl-1 pr-4 text-sm text-fg';
        const title = `${NAMES[s.service] ?? 'Каталог'}: ${s.name}${n ? ` · ${num(n)} ${what}` : ''}`;
        return s.url ? (
          <a key={`${s.service}:${s.ref ?? i}`} href={s.url} target="_blank" rel="noopener noreferrer" title={title} className={cx(box, 'transition hover:border-fg active:scale-95')}>
            {body}
          </a>
        ) : (
          <span key={`${s.service}:${s.ref ?? i}`} title={title} className={box}>
            {body}
          </span>
        );
      })}
    </>
  );
}

