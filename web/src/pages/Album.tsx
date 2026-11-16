import { useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { TrackOut } from '../api/types';
import { TrackRow, TrackTableHeader } from '../components/catalog';
import { Icon, type IconName } from '../components/Icon';
import { ListBar } from '../components/ListBar';
import { BrandIcon } from '../components/BrandIcon';
import { ErrorState, ExplicitBadge, HeroSkeleton, IconButton, OwnedBadge, PageHeader, Sheet } from '../components/ui';
import { startDownload } from '../lib/actions';
import { useHubEvent } from '../lib/events';
import { fmtLength, recordTypeLabel, tracksWord, yearOf } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { canPlay, canPlayAll, playList } from '../lib/player';
import { Link, enc } from '../lib/router';
import { copyText } from '../lib/share';
import { attempt, confirmDialog, toast } from '../lib/ui';
import { Hero } from './MediaLibrary';

/** A release of the catalog (`/album/<ref>`), in the shape of every list: the head — the cover, the kind of release
 * over its name, the artist, the year, the tracks and their length, ▶ and the shuffle — then a row of buttons
 * (at the top of the page: ⋯ — the link, the release in its catalog, the artist — and «Скачать
 * альбом»), the tracks by their numbers and,
 * under them, the day it came out. */

export function AlbumPage({ refId }: { refId: string }) {
  const [menu, setMenu] = useState(false);
  const [rev, setRev] = useState(0);
  const res = useAsync((s) => api.album(refId, s, rev > 0), [refId, rev], true, `album:${refId}`);
  const [dlBusy, setDlBusy] = useState(false);

  const reloadTimer = useRef<number | undefined>(undefined);

  // New imports may complete tracks of this album: refetch (debounced, bypassing the cache).
  useHubEvent('library', (e) => {
    if (e.kind !== 'imported') return;
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => setRev((r) => r + 1), 1500);
  });

  const tracks = useMemo(() => res.data?.tracks ?? [], [res.data]);
  const discs = useMemo(() => {
    const m = new Map<number, TrackOut[]>();
    for (const t of tracks) {
      const d = t.disc_no ?? 1;
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(t);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [tracks]);

  if (res.loading && !res.data)
    return (
      <>
        <PageHeader hero title="Альбом" back="/search" />
        <HeroSkeleton buttons />
      </>
    );
  if (res.error || !res.data)
    return (
      <>
        <PageHeader hero title="Альбом" back="/search" />
        <ErrorState text={res.error ?? 'Альбом не найден'} onRetry={() => res.reload()} />
      </>
    );

  const album = res.data;
  const year = yearOf(album);
  const total = tracks.reduce((s, t) => s + (t.duration_s ?? 0), 0);
  const missing = tracks.filter((t) => !t.owned);
  const owned = tracks.filter((t) => t.owned);
  // Older apps: owned tracks Navidrome has scanned play in the app's player, in album order.
  const playable = canPlay() && !canPlayAll() ? owned.filter((t) => t.nd_song_id) : [];
  const play = (from?: TrackOut) => playList(playable, (t) => t.nd_song_id, from);
  const markDownloading = (refs: Set<string>) =>
    res.setData((prev) => (prev ? { ...prev, tracks: (prev.tracks ?? []).map((t) => (refs.has(t.ref) ? { ...t, downloading: true } : t)) } : prev));

  const downloadAlbum = async () => {
    setDlBusy(true);
    const r = await startDownload({ album_ref: album.ref });
    setDlBusy(false);
    if (r) markDownloading(new Set(missing.map((t) => t.ref)));
  };

  /** The album into the chosen playlists: the tracks the library has at once, the rest as they are downloaded. */

  const share = async () => {
    setMenu(false);
    const url = `${window.location.origin}/#/album/${enc(album.ref)}`;
    toast((await copyText(url)) ? 'Ссылка на релиз скопирована' : url, 'success');
  };
  /** The catalog keeps namesakes under one artist: this release is not of the one whose page led here. */
  const namesake = async () => {
    setMenu(false);
    const artistRef = album.artist_ref;
    if (!artistRef) return;
    const ok = await confirmDialog({
      title: `Это другой ${album.artist}?`,
      body: `Каталог держит тёзок под одним исполнителем. «${album.title}» пропадёт со страницы этого исполнителя, из его дискографии и из «Релизов» — у всех на этом сервере. Сами треки останутся доступны. Вернуть можно в «Меню → Скрытое».`,
      okLabel: 'Убрать у исполнителя',
      danger: true,
    });
    if (!ok) return;
    if (await attempt(() => api.namesakesExclude(artistRef, [album.ref]))) toast('Релиз убран у исполнителя', 'success', { label: 'Скрытое', to: '/hidden' });
  };
  const deezer = album.source === 'dz' ? `https://www.deezer.com/album/${album.id}` : album.source === 'ym' ? `https://music.yandex.ru/album/${album.id}` : null;
  const item = (icon: IconName, label: string, run: () => void) => (
    <button type="button" onClick={run} className="flex min-h-12 w-full items-center gap-4 rounded-lg px-3 text-left text-[15px] hover:bg-fg/5">
      <Icon name={icon} size={21} className="text-muted" />
      {label}
    </button>
  );
  const allHere = tracks.length > 0 && missing.length === 0;
  const facts = [year, tracks.length ? tracksWord(tracks.length) : null, total ? fmtLength(total) : null].filter(Boolean);

  return (
    <div>
      <ListBar
        title={album.title}
        back="/search"
        tracks={tracks}
        context="album"
        // what is done with the release as a whole stands at the top, as on a playlist's page
        extra={
          <>
            <IconButton icon="more" label="Ещё" onClick={() => setMenu(true)} />
            <IconButton
              icon={allHere ? 'check' : 'download'}
              label={allHere ? 'Всё скачано' : owned.length ? `Скачать недостающие ${missing.length} из ${tracks.length}` : 'Скачать альбом'}
              busy={dlBusy}
              disabled={allHere || !tracks.length}
              onClick={() => void downloadAlbum()}
              className={allHere ? '!text-accent' : undefined}
            />
          </>
        }
      />
      <Hero
        kicker={recordTypeLabel(album.record_type) || 'Релиз'}
        cover={album.cover_url}
        title={album.title}
        sub={
          <span className="flex flex-wrap items-center gap-x-1.5">
            {album.explicit && <ExplicitBadge />}
            {/* everyone the release is credited to, each with their page */}
            {(album.artists?.length ? album.artists.map((name, i) => ({ name, ref: album.artist_refs?.[i] ?? null })) : [{ name: album.artist, ref: album.artist_ref ?? null }]).map((a, i) => (
              <span key={`${a.name}:${i}`} className="font-semibold text-fg">
                {i > 0 && <span className="pr-1.5 font-normal text-muted">,</span>}
                {a.ref ? (
                  <Link to={`/artist/${enc(a.ref)}`} className="hover:underline">
                    {a.name}
                  </Link>
                ) : (
                  a.name
                )}
              </span>
            ))}
            {facts.length > 0 && <span>· {facts.join(' · ')}</span>}
          </span>
        }
        tracks={tracks}
        context="album"
      />

      {!allHere && owned.length > 0 && (
        <div className="px-4 pb-3 lg:px-6">
          <OwnedBadge status={album.owned_status} count={album.owned_count} total={tracks.length || album.nb_tracks} />
        </div>
      )}

      <section aria-label="Треки" className="pt-2">
        {tracks.length > 0 && <TrackTableHeader numbered />}
        {discs.map(([disc, list]) => (
          <div key={disc}>
            {discs.length > 1 && <div className="px-4 pb-1 pt-3 text-sm font-semibold text-muted">Диск {disc}</div>}
            {list.map((t, i) => (
              <TrackRow key={t.ref} track={t} number={t.track_no ?? i + 1} link={false} onPlay={() => play(t)} queue={tracks} />
            ))}
          </div>
        ))}
        {!tracks.length && <p className="px-4 py-6 text-center text-muted">Треклист недоступен</p>}
      </section>

      {album.release_date && <p className="px-4 pb-4 pt-4 text-xs text-dim lg:px-6">{new Date(album.release_date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</p>}

      <Sheet open={menu} onClose={() => setMenu(false)} title={album.title}>
        <div className="-mx-1">
          {item('link', 'Скопировать ссылку', () => void share())}
          {deezer && (
            <a href={deezer} target="_blank" rel="noopener noreferrer" onClick={() => setMenu(false)} className="flex min-h-12 w-full items-center gap-4 rounded-lg px-3 text-[15px] hover:bg-fg/5">
              <BrandIcon service={album.source === 'ym' ? 'yandex' : 'deezer'} size={21} />
              {album.source === 'ym' ? 'Открыть в Яндекс Музыке' : 'Открыть в Deezer'}
            </a>
          )}
          {album.artist_ref && (
            <Link to={`/artist/${enc(album.artist_ref)}`} onClick={() => setMenu(false)} className="flex min-h-12 w-full items-center gap-4 rounded-lg px-3 text-[15px] hover:bg-fg/5">
              <Icon name="user" size={21} className="text-muted" />
              Перейти к исполнителю
            </Link>
          )}
          {album.artist_ref?.startsWith('dz:') && (
            <button type="button" onClick={() => void namesake()} className="flex min-h-12 w-full items-center gap-4 rounded-lg px-3 text-left text-[15px] text-danger hover:bg-fg/5">
              <Icon name="ban" size={21} />
              Это другой {album.artist}
            </button>
          )}
        </div>
      </Sheet>

    </div>
  );
}
