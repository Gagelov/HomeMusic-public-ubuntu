import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AlbumOut, TrackOut } from '../api/types';
import { TrackRow, TrackTableHeader } from '../components/catalog';
import { Icon } from '../components/Icon';
import { ListBar } from '../components/ListBar';
import { useSearchField } from '../components/ListSearch';
import { Button, Checkbox, Cover, Empty, ErrorState, Loading, PageHeader, Segmented, cx } from '../components/ui';
import { plural, tracksWord } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { attempt, toast } from '../lib/ui';
import { Link, enc, navigate, useRoute } from '../lib/router';

/** «Дискография» (`/artist/<ref>/discography`): everything an artist released, shown one of two ways. «Релизы» —
 * the releases alone, newest first, by kind; a tap opens the release. «Треки» (`?view=tracks`, what «Все треки» of
 * the artist's page opens) — every song once, as one list: the most listened first, or the newest. The search of the
 * bar looks through both at once — the releases by name, every track — whichever is shown (`?search=1`: the field
 * is open as the page opens). The Hub gives it whole (`/api/catalog/artist/<ref>/discography`): the first opening of
 * a long one takes a few seconds. */

type Kind = 'all' | 'album' | 'single' | 'compile';
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'all', label: 'Всё' },
  { value: 'album', label: 'Альбомы' },
  { value: 'single', label: 'Синглы и EP' },
  { value: 'compile', label: 'Сборники' },
];
const KIND_NAME: Record<string, string> = { album: 'Альбом', single: 'Сингл', ep: 'EP', compile: 'Сборник' };
const STEP = 8; // releases drawn at once; more as the end comes into view

const kindOf = (a: AlbumOut): Kind => (a.record_type === 'ep' ? 'single' : a.record_type === 'single' || a.record_type === 'compile' ? a.record_type : 'album');
const yearOf = (a: AlbumOut) => a.year ?? (a.release_date ? Number(a.release_date.slice(0, 4)) : null);

type View = 'releases' | 'tracks';
type Order = 'popular' | 'new';
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'releases', label: 'Релизы' },
  { value: 'tracks', label: 'Треки' },
];
const ORDERS: Array<{ value: Order; label: string }> = [
  { value: 'popular', label: 'Популярные' },
  { value: 'new', label: 'Новые' },
];
const TRACKS_STEP = 60; // tracks drawn at once; more as the end comes into view
const KIND_RANK: Record<Kind, number> = { all: 0, album: 0, single: 1, compile: 2 };
const dayOf = (a: AlbumOut) => a.release_date ?? (yearOf(a) ? `${yearOf(a)}-01-01` : '');
/** One song under whatever release carries it: its name and who leads it, without the letters' case or the marks. */
const songKey = (t: TrackOut) => `${t.title}|${t.artists?.[0] ?? t.artist}`.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}|]+/gu, '');

interface Row {
  t: TrackOut;
  a: AlbumOut;
}

export function DiscographyPage({ refId }: { refId: string }) {
  const res = useAsync((s) => api.discography(refId, s), [refId], true, `discography:${refId}`);
  const route = useRoute();
  // which of the two the page shows is in its address: «Дискография» opens the releases, «Все треки» the tracks
  const view: View = route.query.get('view') === 'tracks' ? 'tracks' : 'releases';
  const [kind, setKind] = useState<Kind>('all');
  const [order, setOrder] = useState<Order>('popular');
  const [shown, setShown] = useState(STEP);
  const sf = useSearchField('Трек или релиз');
  // «это другой исполнитель»: the releases being picked as a namesake's (null: not picking)
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (ref: string) =>
    setPicked((cur) => {
      const next = new Set(cur ?? []);
      if (!next.delete(ref)) next.add(ref);
      return next;
    });
  const exclude = async () => {
    if (!picked?.size) return;
    setBusy(true);
    const r = await attempt(() => api.namesakesExclude(refId, [...picked]));
    setBusy(false);
    if (!r) return;
    setPicked(null);
    toast(`Убрано у исполнителя: ${r.excluded}`, 'success', { label: 'Скрытое', to: '/hidden' });
    res.reload(true);
  };
  const needle = sf.q.trim().toLocaleLowerCase('ru');
  const d = res.data;
  const at = (v: View) => `/artist/${enc(refId)}/discography${v === 'tracks' ? '?view=tracks' : ''}`;
  // the artist's page has one address, whichever record of the catalog it was opened by
  const own = d?.profiles?.[0];
  useEffect(() => {
    if (own && own !== refId) navigate(`/artist/${enc(own)}/discography${view === 'tracks' ? '?view=tracks' : ''}`, { replace: true });
  }, [own, refId, view]);
  // asked for from the artist's page by its search: the field is open at once
  const asked = route.query.get('search') === '1';
  useEffect(() => {
    if (asked && d) sf.show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, !!d]);
  const back = `/artist/${enc(refId)}`;

  const albums = useMemo(() => (d?.albums ?? []).filter((a) => kind === 'all' || kindOf(a) === kind), [d, kind]);
  // every song of the artist once: a single that went into an album later is the album's track
  const songs = useMemo(() => {
    const first = new Map<string, Row>();
    const byWeight = [...(d?.albums ?? [])].sort((x, y) => KIND_RANK[kindOf(x)] - KIND_RANK[kindOf(y)] || dayOf(x).localeCompare(dayOf(y)));
    for (const a of byWeight) for (const t of a.tracks ?? []) if (!first.has(songKey(t))) first.set(songKey(t), { t, a });
    return [...first.values()];
  }, [d]);
  const ranked = useMemo(() => songs.some((x) => x.t.rank), [songs]); // a catalog that counts no listens has no «Популярные»
  const sort: Order = ranked ? order : 'new';
  const tracks = useMemo(() => {
    const list = [...songs];
    if (sort === 'popular') list.sort((x, y) => (y.t.rank ?? -1) - (x.t.rank ?? -1));
    else list.sort((x, y) => dayOf(y.a).localeCompare(dayOf(x.a)) || (x.a.ref === y.a.ref ? (x.t.track_no ?? 0) - (y.t.track_no ?? 0) : 0));
    return list;
  }, [songs, sort]);
  // the search looks through everything the artist has, whichever of the two is shown: their releases by name, and
  // every track
  const foundReleases = useMemo(() => (needle ? (d?.albums ?? []).filter((a) => a.title.toLocaleLowerCase('ru').includes(needle)) : null), [d, needle]);
  const foundTracks = useMemo(
    () => (needle ? tracks.filter(({ t }) => `${t.title} ${t.artists?.join(' ') ?? t.artist}`.toLocaleLowerCase('ru').includes(needle)) : null),
    [tracks, needle],
  );
  useEffect(() => setShown(STEP), [kind, refId, view, sort]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver((xs) => xs.some((x) => x.isIntersecting) && setShown((n) => n + STEP), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [albums.length, tracks.length, view, !!needle]);

  if (res.loading && !d) return (<><PageHeader title="Дискография" back={back} /><Loading text="Собираю дискографию — у исполнителя с десятками релизов это несколько секунд…" /></>);
  if (!d) return (<><PageHeader title="Дискография" back={back} /><ErrorState text={res.error ?? 'Не удалось получить дискографию'} onRetry={() => res.reload()} /></>);

  const named = (x: Row): TrackOut => ({ ...x.t, album_title: `${x.a.title}${yearOf(x.a) ? ` · ${yearOf(x.a)}` : ''}` });
  const release = (a: AlbumOut) => (
    <li key={a.ref} className={cx('flex items-center gap-3 px-4 py-2 lg:px-6', picked?.has(a.ref) && 'opacity-50')}>
      {picked && <Checkbox checked={picked.has(a.ref)} onChange={() => pick(a.ref)} label={`«${a.title}» — другого исполнителя`} />}
      <Link to={`/album/${enc(a.ref)}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg hover:bg-fg/5">
        <Cover src={a.cover_small_url || a.cover_url} size={56} alt="" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{a.title}</span>
          <span className="block truncate text-[13px] text-muted">
            {[KIND_NAME[a.record_type] ?? 'Релиз', yearOf(a), a.tracks?.length ? tracksWord(a.tracks.length) : a.nb_tracks ? tracksWord(a.nb_tracks) : null].filter(Boolean).join(' · ')}
          </span>
        </span>
        <Icon name="chevron" size={18} className="shrink-0 text-dim" />
      </Link>
    </li>
  );
  const list = (rows: Row[], queue: TrackOut[]) => rows.map((x, i) => <TrackRow key={`${x.a.ref}:${x.t.ref}`} track={named(x)} showAlbum queue={queue} index={i + 1} />);

  return (
    <div>
      <ListBar plain title={d.artist.name} back={back} search={{ found: null, open: sf.open, alone: sf.alone, show: sf.show, close: sf.close, field: sf.field(needle ? (foundReleases?.length ?? 0) + (foundTracks?.length ?? 0) : undefined) }} />
      {picked ? (
        <div className="sticky top-[calc(var(--page-top)+3.5rem)] z-10 flex flex-wrap items-center gap-2 bg-bg/95 px-4 py-2 backdrop-blur lg:px-6">
          <span className="mr-auto text-sm font-semibold">{picked.size ? `Выбрано: ${picked.size}` : 'Отметьте релизы другого исполнителя'}</span>
          <Button small variant="danger" busy={busy} disabled={!picked.size} onClick={() => void exclude()}>
            Это другой {d.artist.name}
          </Button>
          <Button small variant="ghost" onClick={() => setPicked(null)}>
            Отмена
          </Button>
        </div>
      ) : (
        !needle && (
          <div className="space-y-2 px-4 pb-2 lg:px-6">
            <Segmented<View> label="Что показать" value={view} onChange={(v) => navigate(at(v), { replace: true })} options={VIEWS} />
            <div className="flex flex-wrap items-center gap-3">
              {view === 'releases' ? (
                <>
                  <Segmented<Kind> label="Какие релизы" value={kind} onChange={setKind} options={KINDS.filter((k) => k.value === 'all' || (d.albums ?? []).some((a) => kindOf(a) === k.value))} />
                  {refId.startsWith('dz:') && (
                    <button type="button" onClick={() => setPicked(new Set())} title="Каталог держит тёзок под одним исполнителем: отметьте релизы, которые не его" className="text-sm text-muted hover:text-fg hover:underline">
                      Здесь есть чужие?
                    </button>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-dim">
                    {albums.length} {plural(albums.length, ['релиз', 'релиза', 'релизов'])}
                  </span>
                </>
              ) : (
                <>
                  {ranked && <Segmented<Order> label="В каком порядке" value={sort} onChange={setOrder} options={ORDERS} />}
                  <span className="ml-auto text-xs tabular-nums text-dim">{tracksWord(tracks.length)}</span>
                </>
              )}
            </div>
          </div>
        )
      )}

      {needle ? (
        foundReleases?.length || foundTracks?.length ? (
          <div className="pb-4">
            {!!foundReleases?.length && <ul className="pb-2">{foundReleases.slice(0, 50).map(release)}</ul>}
            {list((foundTracks ?? []).slice(0, 300), (foundTracks ?? []).map((x) => x.t))}
          </div>
        ) : (
          <Empty icon="search" title="Ничего не нашлось" text="Ни релиза, ни трека с таким названием у этого исполнителя нет." />
        )
      ) : view === 'tracks' ? (
        !tracks.length ? (
          <Empty icon="note" title="Треков нет" text="Каталог не отдал треки этого исполнителя." />
        ) : (
          <div className="pb-4">
            <TrackTableHeader numbered album />
            {list(tracks.slice(0, (shown / STEP) * TRACKS_STEP), tracks.map((x) => x.t))}
            <div ref={end} className="h-8" />
          </div>
        )
      ) : !albums.length ? (
        <Empty icon="disc" title="Релизов нет" text="Каталог не знает релизов этого исполнителя." />
      ) : (
        <div className="pb-4">
          <ul>{albums.slice(0, shown * 4).map(release)}</ul>
          <div ref={end} className="h-8" />
          {!!d.excluded && shown * 4 >= albums.length && (
            <p className="px-4 pb-2 text-sm text-dim lg:px-6">
              Скрыто как чужие: {d.excluded} ·{' '}
              <Link to="/hidden" className="text-muted hover:text-fg hover:underline">
                показать
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
