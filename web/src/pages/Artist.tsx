import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { AlbumOut, ArtistPageOut, TrackOut } from '../api/types';
import { ReleaseCard, TrackRow } from '../components/catalog';
import { Icon, type IconName } from '../components/Icon';
import { ListBar } from '../components/ListBar';
import { ArtistLooksWindow } from '../components/ArtistLooks';
import { ArtistSourceButtons, ArtistSources } from '../components/ArtistSources';
import { ArtistProjects, ArtistWindow, artistHint, useArtistCard } from '../components/ArtistNames';
import { Button, ErrorState, HeroSkeleton, PageHeader, Sheet, Spinner, cx } from '../components/ui';
import { startDownload } from '../lib/actions';
import { useDesktop } from '../lib/desktop';
import { setDisliked, useDisliked } from '../lib/dislikes';
import { plural, tracksWord } from '../lib/format';
import { useAsync, useRememberScrollX } from '../lib/hooks';
import { imageUrl } from '../lib/img';
import { Link, enc, navigate } from '../lib/router';
import { copyText } from '../lib/share';
import { toggleLike, useLiked } from '../lib/stars';
import { confirmDialog, toast } from '../lib/ui';
import { canWave, startWave } from '../lib/wave';
import { PlayPair } from './MediaLibrary';

/** An artist's page (`/artist/<ref>`; a library artist the catalog knows opens it too): a list's head — the photo,
 * the name, ▶ and the shuffle of the popular tracks — then a row of buttons: «Подписаться», «Вам нравится» (the
 * user's liked tracks the artist is on, when there are any) and ⋯ (the wave by the artist, downloading everything,
 * sharing, «Не включать»). Under them the ten popular tracks (two columns of five in a wide window), then
 * «Дискография»: the releases in a row that scrolls sideways, newest first, by kind, and the way to all of them
 * with their tracks (the heading, `pages/Discography.tsx`).
 *
 * Where the artist has a wide picture (the Hub finds one and keeps it: `catalog/banners.py`) it is the head of the
 * page, the name over it; where there is none — the round photo beside the name, as a list's head.
 *
 * An artist the user does not listen to (`lib/dislikes.ts`) has a grey page that says so and offers to bring them
 * back: nothing of theirs plays by itself, a track tapped still does. */

const POPULAR = 10;
const IN_ROW = 20; // releases in the row of the page; the rest are on «Дискография»

type Kind = 'all' | 'album' | 'single';
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'album', label: 'Альбомы' },
  { value: 'single', label: 'Синглы и EP' },
];
const kindOf = (a: AlbumOut): Kind => (a.record_type === 'single' || a.record_type === 'ep' ? 'single' : 'album');

/** The user's liked tracks this artist is on (credited anywhere, not only first). */
function useLikedBy(name: string | undefined, ref: string | undefined): number {
  const liked = useAsync((s) => api.ndLiked(s), [], true, 'liked');
  return useMemo(() => {
    if (!name) return 0;
    const want = name.trim().toLocaleLowerCase('ru');
    return (liked.data?.songs ?? []).filter((t) => (!!ref && (t.artist_ref === ref || !!t.artist_refs?.includes(ref))) || (t.artists?.length ? t.artists : [t.artist]).some((a) => a.trim().toLocaleLowerCase('ru') === want)).length;
  }, [liked.data, name, ref]);
}

/** An artist known by the name alone (`/artist-named/<name>`, from a player): the catalog's artist of that name
 * takes the place of this page; when it has none, the search for the name does. */
export function ArtistNamedPage({ name }: { name: string }) {
  const res = useAsync((s) => api.artistNamed(name, s), [name]);
  useEffect(() => {
    if (res.data) navigate(res.data.ref ? `/artist/${enc(res.data.ref)}` : `/search?q=${enc(name)}`, { replace: true });
  }, [res.data, name]);
  if (res.error) return (<><PageHeader hero title={name} back="/search" /><ErrorState text={res.error} onRetry={() => res.reload()} /></>);
  return (<><PageHeader hero title={name} back="/search" /><HeroSkeleton round buttons rows={10} /></>);
}

export function ArtistPage({ refId }: { refId: string }) {
  const res = useAsync((s) => api.artist(refId, s), [refId], true, `artist:${refId}`);
  const [menu, setMenu] = useState(false);
  const desktop = useDesktop();
  const [naming, setNaming] = useState<'names' | 'projects' | 'looks' | null>(null); // a window of the artist's ⋯
  const [busy, setBusy] = useState<string | null>(null);
  const d: ArtistPageOut | undefined = res.data;
  const artist = d?.artist;
  const target = { targetType: 'artist' as const, ref: refId, data: { name: artist?.name ?? '' } };
  const followed = useLiked(target);
  // «Подписаться» just pressed: the button says so ('said'), then folds away ('folding'), then is gone
  const [leaving, setLeaving] = useState<'said' | 'folding' | null>(null);
  useEffect(() => {
    if (!leaving) return;
    // (the artist is not followed after all — it did not work, or was taken back at once: the button stays)
    const t = window.setTimeout(() => setLeaving(leaving === 'said' && followed ? 'folding' : null), leaving === 'said' ? 1100 : 350);
    return () => window.clearTimeout(t);
  }, [leaving, followed]);
  const hidden = useDisliked({ artist_ref: refId });
  const likedBy = useLikedBy(artist?.name, refId);

  // a catalog may keep several records of one artist: their page has one address, that of the first of them
  const own = d?.profiles?.[0];
  useEffect(() => {
    if (own && own !== refId) navigate(`/artist/${enc(own)}`, { replace: true });
  }, [own, refId]);
  // the artist as the Hub knows them: the name everyone sees may be another spelling than the catalog's
  const names = useArtistCard(d?.artist?.name, refId);
  if (res.loading && !d) return (<><PageHeader hero title="Исполнитель" back="/search" /><HeroSkeleton round buttons rows={10} /></>);
  if (!d || !artist) return (<><PageHeader hero title="Исполнитель" back="/search" /><ErrorState text={res.error ?? 'Исполнитель не найден'} onRetry={() => res.reload()} /></>);

  const releases = [...d.albums, ...d.singles, ...d.compilations].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
  const top = d.top_tracks.slice(0, POPULAR);
  // how many of them, at the end, are Last.fm's
  const lfm = Math.max(0, Math.min(d.top_from_lastfm ?? 0, top.length - (d.top_tracks.length - (d.top_from_lastfm ?? 0))));

  /** «Подписаться»: the button says «Вы подписаны» for a moment, then folds away — it is pressed once, and from
   * then on a mark by the name says it; a word at the foot of the window takes a slip of the finger back. */
  const follow = async () => {
    setBusy('follow');
    try {
      await toggleLike(target);
    } finally {
      setBusy(null);
    }
    setLeaving('said');
    toast(`Вы подписаны: ${shownName}. Новые релизы появятся в «Релизах»`, 'success', { label: 'Отменить', run: () => void toggleLike(target) });
  };
  const unfollow = async () => {
    setMenu(false);
    await toggleLike(target);
    toast(`Вы отписались: ${shownName}`, 'info', { label: 'Вернуть', run: () => void toggleLike(target) });
  };
  const downloadAll = async () => {
    setMenu(false);
    const missing = (xs: AlbumOut[]) => xs.filter((a) => a.owned_status !== 'full');
    const base = [...missing(d.albums), ...missing(d.singles)];
    const tracks = base.reduce((n, a) => n + Math.max(0, (a.nb_tracks ?? 0) - (a.owned_count ?? 0)), 0);
    const comp = missing(d.compilations).length;
    if (!base.length && !comp) {
      toast('Все альбомы и синглы этого исполнителя уже в библиотеке', 'info');
      return;
    }
    const body = `Будет скачано релизов: ${base.length} (альбомы, синглы и EP)` + (tracks ? `, примерно ${tracksWord(tracks)}` : '') + '.\nУже скачанные треки пропускаются.' + (comp ? `\nСборники (${comp}) не включаются.` : '');
    if (!(await confirmDialog({ title: `Скачать всю дискографию ${artist.name}?`, body, okLabel: 'Скачать' }))) return;
    await startDownload({ artist_ref: artist.ref, record_types: ['album', 'single', 'ep'] });
    res.reload(true);
  };
  const share = async () => {
    setMenu(false);
    const url = `${window.location.origin}/#/artist/${enc(artist.ref)}`;
    toast((await copyText(url)) ? 'Ссылка на исполнителя скопирована' : url, 'success');
  };
  const hide = async () => {
    setMenu(false);
    if (hidden) return void setDisliked({ artist_ref: refId, artist: artist.name }, false);
    if (!(await confirmDialog({ title: `Не включать ${artist.name}?`, body: 'Треки этого исполнителя, и те, где он участвует, не будут попадать в волну, миксы и открытия, а в плейлистах будут пропускаться. Нажатый вручную трек сыграет. Вернуть можно здесь же или в «Меню → Скрытое».', okLabel: 'Не включать', danger: true }))) return;
    await setDisliked({ artist_ref: refId, artist: artist.name }, true);
  };
  const item = (icon: IconName, label: ReactNode, run: () => void, danger = false) => (
    <button type="button" onClick={run} className={cx('flex min-h-12 w-full items-center gap-4 rounded-lg px-3 text-left text-[15px] hover:bg-fg/5', danger && 'text-danger')}>
      <Icon name={icon} size={21} className={danger ? undefined : 'text-muted'} />
      {label}
    </button>
  );

  const shownName = names.card?.name ?? artist.name;
  const photo = imageUrl(artist.picture_url);
  const facts = <ArtistSources sources={d.sources ?? []} releases={releases.length} />;

  return (
    <div className={hidden ? 'grayscale' : undefined}>
      {/* the picture over the page: before everything, so it stays at the top of the window while the page goes over
          it. The wide one where the artist has it; else their own photo, out of focus — the round photo stands on it */}
      {(d.banner_url || photo) && <BannerPicture src={(d.banner_url ?? photo) as string} blurred={!d.banner_url} />}
      <ListBar title={shownName} back="/search" tracks={hidden ? undefined : top} context="artist" />
      <Banner name={shownName} followed={followed} photo={d.banner_url ? undefined : (photo ?? null)} tracks={hidden ? undefined : top} />

      {/* what goes up over the picture has the page's own colour under it */}
      <div className="relative z-[1] bg-bg">
      {/* what is known of the artist, and where from: on a phone one line under the picture; on a computer the
          places are buttons of the row below, which has the room */}
      {desktop ? <div className="h-3" /> : <div className="px-4 pb-3 pt-1 text-sm text-muted">{facts}</div>}
      {hidden ? (
        <div className="mx-4 mb-3 rounded-2xl bg-danger/15 px-4 py-3 text-sm text-fg lg:mx-6">
          <p>Вы не слушаете этого исполнителя. Его треков нет в волне, миксах и открытиях, а в плейлистах они пропускаются.</p>
          <Button small className="mt-3" onClick={() => void setDisliked({ artist_ref: refId, artist: artist.name }, false)}>
            Вернуть
          </Button>
        </div>
      ) : (
        <div className="flex items-center px-4 pb-3 lg:px-6">
          {/* the buttons go sideways where they do not fit; the ⋯ stays at the right edge, whatever the width */}
          <div className="no-scrollbar -my-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 pr-5 [mask-image:linear-gradient(to_right,#000_calc(100%-1.25rem),transparent)] [&>*]:shrink-0">
          {/* pressed once: an artist followed has no such button — the mark by the name says it, the ⋯ takes it back */}
          {(!followed || leaving) && (
            <button
              type="button"
              onClick={() => void follow()}
              disabled={busy === 'follow' || followed}
              title="Подписаться: новые релизы появятся в «Релизах»"
              className={cx(
                'flex h-9 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border text-sm font-semibold transition-all duration-300 ease-out active:scale-95',
                followed ? 'border-accent text-accent' : 'border-fg/40 text-fg hover:border-fg',
                leaving === 'folding' ? '-mr-2 max-w-0 border-transparent px-0 opacity-0' : 'max-w-56 px-4',
              )}
            >
              {busy === 'follow' ? <Spinner size={14} /> : followed && <Icon name="check" size={15} stroke={3} />}
              {followed ? 'Вы подписаны' : 'Подписаться'}
            </button>
          )}
          {likedBy > 0 && (
            <Link
              to={`/liked?artist=${enc(artist.name)}&ref=${enc(artist.ref)}`}
              title={`Вам нравится: ${tracksWord(likedBy)} этого исполнителя в «Любимом»`}
              className="flex h-9 items-center gap-1.5 rounded-full border border-fg/40 px-4 text-sm font-semibold text-fg transition hover:border-fg active:scale-95"
            >
              <Icon name="heart" size={15} filled className="text-accent" />
              <span className="hidden lg:inline">Вам нравится ·</span>
              {tracksWord(likedBy)}
            </Link>
          )}
          {/* the other projects of who it is: each leads to its own page */}
          <ArtistProjects card={names.card} />
          {desktop && <ArtistSourceButtons sources={d.sources ?? []} />}
          </div>
          <button type="button" onClick={() => setMenu(true)} aria-label="Ещё" title="Ещё" className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:text-fg">
            <Icon name="more" size={24} />
            {/* somebody looks like the same artist under another spelling: «Имя и написания» says who */}
            {artistHint(names.card) && <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-info" />}
          </button>
        </div>
      )}

      {top.length > 0 && (
        <section aria-label="Популярное">
          <h2 className="flex items-baseline gap-2 px-4 pb-1 pt-3 text-lg font-bold lg:px-6">
            Популярное
            {/* whose listens put them there: the catalog's own, and Last.fm's where the catalog's list is short */}
            <span className="text-xs font-normal text-dim">{lfm >= top.length ? 'по Last.fm' : lfm > 0 ? `по Deezer, с ${top.length - lfm + 1}-го — по Last.fm` : 'по Deezer'}</span>
          </h2>
          {/* a wide window: two columns, 1–5 and 6–10 — only where a row keeps room for its name, and only when
              there are tracks for two */}
          <div className={top.length > 5 ? 'min-[1700px]:grid min-[1700px]:grid-flow-col min-[1700px]:grid-cols-2 min-[1700px]:gap-x-4' : undefined} style={{ gridTemplateRows: `repeat(${Math.ceil(top.length / 2)}, auto)` }}>
            {top.map((t, i) => (
              <TrackRow key={t.ref} track={t} number={i + 1} queue={top} />
            ))}
          </div>
        </section>
      )}

      {releases.length > 0 && <Discography artistRef={artist.ref} releases={releases} />}

      </div>

      <Sheet open={menu} onClose={() => setMenu(false)} title={artist.name}>
        <div className="-mx-1">
          {canWave() && item('wave', 'Волна по исполнителю', () => {
            setMenu(false);
            void startWave({ artist_ref: artist.ref }, 'artist_page');
          })}
          {item('download', 'Скачать всё', () => void downloadAll())}
          {followed && item('x', 'Отписаться', () => void unfollow())}
          {names.card && item('edit', <span className="flex items-center gap-2">Имя и написания{artistHint(names.card) && <><span aria-hidden="true" className="h-2 w-2 rounded-full bg-info" /><span className="text-[13px] text-info">есть похожий исполнитель</span></>}</span>, () => {
            setMenu(false);
            setNaming('names');
          })}
          {names.card && item('user', 'Другие проекты…', () => {
            setMenu(false);
            setNaming('projects');
          })}
          {names.card && item('image', 'Фото и обложка', () => {
            setMenu(false);
            setNaming('looks');
          })}
          {item('link', 'Скопировать ссылку', () => void share())}
          {item('ban', 'Не включать этого исполнителя', () => void hide(), true)}
        </div>
      </Sheet>
      <ArtistWindow which={naming === 'looks' ? null : naming} card={names.card} onChange={names.set} onClose={() => setNaming(null)} />
      {naming === 'looks' && names.card && <ArtistLooksWindow artistId={names.card.id} onChanged={() => res.reload()} onClose={() => setNaming(null)} />}
    </div>
  );
}

const BANNER_H = 'h-[clamp(15rem,34vw,26rem)]';

/** The artist's wide picture, standing still: a place of no height that sticks to the top of the window, with the
 * picture hanging from it. Nothing moves it — the page's own content, which has the page's colour under it, goes up
 * over it (moved after every scroll instead, it lagged a frame behind and sprang). As the page covers it a shade of
 * the page's colour comes over it too; that is set a frame at a time on the element, and a shade a frame late is
 * not seen. */
function BannerPicture({ src, blurred }: { src: string; /** not a wide picture but the artist's photo: shown out of focus, as a ground */ blurred?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const h = el.offsetHeight || 1;
      el.style.setProperty('--shade', String(Math.min(1, Math.max(0, window.scrollY) / (h * 0.7))));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div aria-hidden="true" className="pointer-events-none sticky top-(--page-top) z-0 h-0">
      <div ref={box} className={cx('absolute inset-x-0 top-0 overflow-hidden', BANNER_H)}>
        <img src={src} alt="" className={cx('h-full w-full object-cover', blurred ? 'scale-150 blur-3xl brightness-[0.55] saturate-150' : 'object-[center_25%]')} />
        <div style={{ opacity: 'var(--shade, 0)' }} className="absolute inset-0 bg-bg" />
      </div>
    </div>
  );
}

/** The head of the page over that picture: as tall as it, reaching up under the bar with «back»; the name in large
 * over its darkened foot, ▶ and the shuffle beside the name — on a phone and on a computer alike, and on the side
 * they keep in the bar once the page is scrolled. Over a wide picture the round photo is not shown — it is the same
 * person twice; where there is none (`photo` given: the address, or null for no photo at all) the round photo
 * stands on the ground made of it: in the middle on a phone, before the name on a computer. */
function Banner({ name, followed, photo, tracks }: { name: string; /** the listener follows the artist: a mark by the name */ followed?: boolean; photo?: string | null; tracks?: readonly TrackOut[] }) {
  const round = 'absolute left-1/2 top-[calc(3.75rem+env(safe-area-inset-top))] h-28 w-28 shrink-0 -translate-x-1/2 rounded-full shadow-xl lg:static lg:h-44 lg:w-44 lg:translate-x-0';
  return (
    <div className={cx('relative isolate z-[1] -mt-[calc(3.5rem+env(safe-area-inset-top))] flex items-end', BANNER_H)}>
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-bg via-bg/45 to-black/15" />
      <div className="flex w-full items-end gap-3 px-4 pb-4 lg:gap-6 lg:px-6 lg:pb-5">
        {photo !== undefined &&
          (photo ? (
            <img src={photo} alt="" className={cx(round, 'object-cover')} />
          ) : (
            <span className={cx(round, 'flex items-center justify-center bg-fg/10 text-muted')}>
              <Icon name="user" size={40} />
            </span>
          ))}
        <div className="min-w-0 flex-1">
          <div className="hidden text-sm text-fg/80 lg:block">Исполнитель</div>
          <h2 data-list-title className="line-clamp-2 break-words text-4xl font-black leading-[1.05] tracking-tight [text-shadow:0_2px_16px_rgb(0_0_0/0.55)] lg:text-7xl">
            {name}
            {followed && (
              <span title="Вы подписаны: новые релизы появятся в «Релизах»" aria-label="Вы подписаны" className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent align-middle text-black [text-shadow:none] lg:ml-3 lg:h-7 lg:w-7">
                <Icon name="check" size={13} stroke={3.5} />
              </span>
            )}
          </h2>
        </div>
        {!!tracks?.length && <PlayPair tracks={tracks} context="artist" />}
      </div>
    </div>
  );
}

/** «Дискография»: the releases in a row that scrolls sideways, newest first, by kind; the heading opens the page
 * of all of them with their tracks. */
function Discography({ artistRef, releases }: { artistRef: string; releases: AlbumOut[] }) {
  const [kind, setKind] = useState<Kind>('all');
  const row = useRememberScrollX(`artist:${artistRef}:${kind}`);
  const kinds = KINDS.filter((k) => k.value === 'all' || releases.some((a) => kindOf(a) === k.value));
  const shown = releases.filter((a) => kind === 'all' || kindOf(a) === kind);
  const to = `/artist/${enc(artistRef)}/discography`;
  return (
    <section aria-label="Дискография" className="pb-4">
      <h2 className="px-4 pb-2 pt-5 text-lg font-bold lg:px-6">
        {/* the heading itself leads to all the releases with their tracks */}
        <Link to={to} className="hover:underline">
          Дискография
        </Link>
        {/* how many there are in all — every release of every record a catalog keeps of the artist, each once */}
        <span className="ml-2 text-xs font-normal text-dim">{releases.length} {plural(releases.length, ['релиз', 'релиза', 'релизов'])}</span>
      </h2>
      {kinds.length > 2 && (
        <div className="flex gap-2 px-4 pb-3 lg:px-6">
          {kinds.map((k) => (
            <button key={k.value} type="button" aria-pressed={kind === k.value} onClick={() => setKind(k.value)} className={cx('h-8 rounded-full px-3.5 text-sm transition', kind === k.value ? 'bg-fg font-semibold text-bg' : 'bg-fg/10 text-fg hover:bg-fg/15')}>
              {k.label}
            </button>
          ))}
        </div>
      )}
      <div ref={row} className="no-scrollbar flex gap-4 overflow-x-auto px-4 pb-1 lg:px-6">
        {shown.slice(0, IN_ROW).map((a) => (
          <div key={a.ref} className="w-36 shrink-0 lg:w-44">
            <ReleaseCard album={a} />
          </div>
        ))}
        {shown.length > IN_ROW && (
          <Link to={to} className="flex aspect-square w-36 shrink-0 flex-col items-center justify-center gap-2 rounded-md bg-fg/5 text-sm font-semibold text-muted hover:bg-fg/10 hover:text-fg lg:w-44">
            <Icon name="chevron" size={22} />
            Ещё {shown.length - IN_ROW}
          </Link>
        )}
      </div>
    </section>
  );
}
