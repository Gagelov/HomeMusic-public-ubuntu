import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSession } from '../lib/session';
import { api, libraryCoverUrl } from '../api/client';
import type { FileRowOut, ReleaseType } from '../api/types';
import { TrackRow, TrackTableHeader } from '../components/catalog';
import { Icon, type IconName } from '../components/Icon';
import { ListBar } from '../components/ListBar';
import { useListSearch } from '../components/ListSearch';
import { Button, Cover, Empty, ErrorState, Field, IconButton, Sheet, SkeletonRows, cx } from '../components/ui';
import { useDesktop } from '../lib/desktop';
import { useHubEvent } from '../lib/events';
import { parseTime, toIntOrNull, tracksWord } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { Link, navigate } from '../lib/router';
import { attempt } from '../lib/ui';

type Sort = 'new' | 'old' | 'title' | 'artist' | 'album' | 'quality';
const SORTS: [Sort, string][] = [
  ['new', 'Сначала новые'],
  ['old', 'Сначала старые'],
  ['title', 'По названию'],
  ['artist', 'По исполнителю'],
  ['album', 'По альбому'],
  ['quality', 'По качеству: худшие сверху'],
];
type Only = 'all' | 'mine' | 'loose' | 'noAlbum' | 'low' | 'doubles';

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff', 'ape', 'wv']);
/** How good a file is, as one number to sort by: what it sounds like when that is less than it says; a file without
 * losses over any with them. */
const quality = (t: FileRowOut): number => (LOSSLESS.has((t.file?.codec ?? '').toLowerCase()) ? 10_000 : (t.file?.sounds_like_kbps ?? t.file?.bitrate_kbps ?? 0));
/** A file that is heard to be poor: an MP3 under 192, the newer codecs (Opus, AAC) under 96. One whose bitrate is
 * not known is not called poor. */
const low = (t: FileRowOut): boolean => {
  const q = quality(t);
  return q > 0 && q < ((t.file?.codec ?? '').toLowerCase() === 'mp3' ? 192 : 96);
};
const SORT_KEY = 'hm-files-sort';
const by = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

/** The day a file came, as the list's heading says it. */
function dayOf(iso?: string | null): string {
  if (!iso) return 'Когда — неизвестно';
  const d = parseTime(iso);
  const now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).replace(/\s*г\.$/, '');
}

/** A button of the bar with a menu under it. */
function BarMenu({ icon, label, active, children }: { icon: IconName; label: string; active?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconButton icon={icon} label={label} aria-expanded={open} onClick={() => setOpen((v) => !v)} className={active ? '!text-accent' : undefined} />
      {open && (
        <div role="menu" aria-label={label} className="anim-up absolute right-0 top-full z-30 w-64 rounded-2xl bg-raised p-1.5 text-sm shadow-2xl">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const menuItem = (icon: IconName | null, label: string, run: () => void, on = false) => (
  <button key={label} type="button" role="menuitem" onClick={run} className={cx('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-fg/10', on && 'font-semibold text-accent')}>
    {icon ? <Icon name={icon} size={19} /> : <span className="flex w-[19px] justify-center">{on && <Icon name="check" size={16} />}</span>}
    {label}
  </button>
);

/** «Мои файлы» (from «Меню»; «Все файлы» of an admin): every track one brought — an import, an upload, a download
 * (an admin: everybody's) — as one long list of tracks, the newest first and by the days they came. The magnifier
 * of the bar searches it; it is sorted by the bar's menu and sorted out by the marks under the bar: one's own, the
 * tracks that are in no playlist, without an album, of a poor file, and the ones that are one recording twice (told
 * by the sound). The rows are the rows of any list: they play, are picked together, have the track's menu. */
export function FilesPage() {
  const { me } = useSession();
  const desktop = useDesktop();
  const res = useAsync((s) => api.libFiles(s), [], true, 'files');
  const twice = useAsync((s) => api.fileDoubles(s), []);
  // the banner shows until the first import
  const imports = useAsync((s) => api.imports(s), []);
  const [sort, setSortState] = useState<Sort>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY) as Sort | null;
      return v && SORTS.some(([id]) => id === v) ? v : 'new';
    } catch {
      return 'new';
    }
  });
  const setSort = (v: Sort) => {
    setSortState(v);
    try { localStorage.setItem(SORT_KEY, v); } catch { /* it lasts for this page then */ }
  };
  const [only, setOnly] = useState<Only>('all');
  const [createOpen, setCreateOpen] = useState(false);

  useHubEvent('library', () => {
    res.reload(true);
    twice.reload(true);
  });

  const all = useMemo(() => res.data ?? [], [res.data]);
  // the group of doubles a track is in (its place among the groups)
  const doubleOf = useMemo(() => {
    const m = new Map<number, number>();
    (twice.data ?? []).forEach((g, at) => g.forEach((id) => m.set(id, at)));
    return m;
  }, [twice.data]);
  const isDouble = (t: FileRowOut) => t.library_track_id != null && doubleOf.has(t.library_track_id);
  const counts = useMemo(() => ({
    mine: all.filter((t) => t.mine).length,
    loose: all.filter((t) => !t.kept).length,
    noAlbum: all.filter((t) => t.no_album).length,
    low: all.filter(low).length,
    doubles: all.filter(isDouble).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [all, doubleOf]);

  const listed = useMemo(() => {
    const rows = all.filter((t) => (only === 'mine' ? t.mine : only === 'loose' ? !t.kept : only === 'noAlbum' ? t.no_album : only === 'low' ? low(t) : only === 'doubles' ? isDouble(t) : true));
    const at = (t: FileRowOut) => (t.added_at ? parseTime(t.added_at).getTime() : 0);
    const cmp: Record<Sort, (a: FileRowOut, b: FileRowOut) => number> = {
      new: (a, b) => at(b) - at(a),
      old: (a, b) => at(a) - at(b),
      title: (a, b) => by.compare(a.title, b.title),
      artist: (a, b) => by.compare(a.artist, b.artist) || by.compare(a.album_title ?? '', b.album_title ?? '') || (a.track_no ?? 0) - (b.track_no ?? 0),
      album: (a, b) => by.compare(a.album_title ?? '\uffff', b.album_title ?? '\uffff') || (a.disc_no ?? 0) - (b.disc_no ?? 0) || (a.track_no ?? 0) - (b.track_no ?? 0),
      quality: (a, b) => quality(a) - quality(b),
    };
    // the doubles stand next to each other, whatever the order of the rest
    if (only === 'doubles') return [...rows].sort((a, b) => (doubleOf.get(a.library_track_id ?? -1) ?? 0) - (doubleOf.get(b.library_track_id ?? -1) ?? 0) || quality(b) - quality(a));
    return [...rows].sort(cmp[sort]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, only, sort, doubleOf]);

  const search = useListSearch(listed, 'Название, исполнитель, альбом или строчка');
  const shown = useMemo(() => (search.found ? search.found.map((f) => listed[f.index]) : listed), [search.found, listed]);
  // by the days the files came: only while the list is in that order and whole
  const byDays = (sort === 'new' || sort === 'old') && only !== 'doubles' && !search.found;
  const days = useMemo(() => {
    const m = new Map<string, number>();
    if (byDays) for (const t of shown) m.set(dayOf(t.added_at), (m.get(dayOf(t.added_at)) ?? 0) + 1);
    return m;
  }, [shown, byDays]);

  const chips: [Only, string, number | null][] = [
    ['all', 'Все', null],
    ...(me.is_admin && counts.mine < all.length ? [['mine', 'Добавил я', counts.mine] as [Only, string, number]] : []),
    ['loose', 'Не в плейлистах', counts.loose],
    ['noAlbum', 'Без альбома', counts.noAlbum],
    ['low', 'Низкое качество', counts.low],
    ['doubles', 'Дубли', counts.doubles],
  ];
  const offerImport = imports.data?.length === 0 && only === 'all' && !search.found;
  const title = me.is_admin ? 'Все файлы' : 'Мои файлы';

  return (
    <div>
      <ListBar
        plain
        title={title}
        back="/more"
        search={search}
        extra={
          <>
            <BarMenu icon="sliders" label={`Сортировка: ${SORTS.find(([id]) => id === sort)?.[1] ?? ''}`} active={sort !== 'new'}>
              {(close) => SORTS.map(([id, label]) => menuItem(null, label, () => { setSort(id); close(); }, sort === id))}
            </BarMenu>
            {desktop && <IconButton icon="upload" label="Загрузить файлы" onClick={() => navigate('/upload')} />}
            <BarMenu icon="more" label="Ещё">
              {(close) => (
                <>
                  {!desktop && menuItem('upload', 'Загрузить файлы', () => navigate('/upload'))}
                  {menuItem('plus', 'Создать свой альбом', () => { close(); setCreateOpen(true); })}
                  {menuItem('transfer', 'Перенести из Яндекс Музыки', () => navigate('/import'))}
                  {menuItem('trash', 'Корзина', () => navigate('/trash'))}
                </>
              )}
            </BarMenu>
          </>
        }
      />

      {all.length > 0 && (
        <div className="flex items-center gap-2 pb-2 pl-4 lg:pl-6">
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pr-4" role="group" aria-label="Какие файлы показывать" style={{ scrollbarWidth: 'none' }}>
            {chips.filter(([id, , n]) => id === 'all' || id === only || (n ?? 0) > 0).map(([id, label, n]) => (
              <button key={id} type="button" aria-pressed={only === id} onClick={() => setOnly(only === id ? 'all' : id)} className={cx('shrink-0 rounded-full px-3 py-1.5 text-sm transition', only === id ? 'bg-fg font-semibold text-bg' : 'bg-fg/10 text-muted hover:text-fg')}>
                {label}
                {n !== null && <span className={cx('pl-1.5 tabular-nums', only === id ? 'opacity-70' : 'text-dim')}>{n}</span>}
              </button>
            ))}
          </div>
          <span className="hidden shrink-0 pr-4 text-xs tabular-nums text-dim sm:block lg:pr-6">{shown.length === all.length ? tracksWord(all.length) : `${shown.length} из ${all.length}`}</span>
        </div>
      )}

      {only === 'all' && !search.found && <SplitAlbumsCard onJoined={() => res.reload(true)} />}
      {offerImport && (
        <Link to="/import" className="card mx-4 mb-4 flex items-center gap-3 p-3 hover:bg-hover lg:mx-6">
          <Icon name="transfer" size={22} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Перенести музыку из Яндекс Музыки</span>
            <span className="block text-xs text-muted">♥, плейлисты, любимые альбомы и исполнители</span>
          </span>
          <Icon name="chevron" size={18} className="shrink-0 text-dim" />
        </Link>
      )}
      {only === 'doubles' && shown.length > 0 && (
        <p className="px-4 pb-2 text-xs text-muted lg:px-6">Одна запись в двух файлах — определено по звучанию. Рядом стоят пары, лучший файл выше; лишний удалите через меню трека («Удалить файл»).</p>
      )}

      {res.loading ? (
        <SkeletonRows n={10} />
      ) : res.error && !all.length ? (
        <ErrorState text={res.error} onRetry={() => res.reload()} />
      ) : all.length === 0 ? (
        <Empty icon="library" title="Файлов пока нет" text="Скачайте музыку через поиск или загрузите свои файлы.">
          <div className="mt-2 flex gap-2">
            <Button small variant="primary" icon="search" onClick={() => navigate('/search')}>
              Поиск
            </Button>
            <Button small icon="upload" onClick={() => navigate('/upload')}>
              Загрузить
            </Button>
          </div>
        </Empty>
      ) : shown.length === 0 ? (
        <Empty icon="search" title="Ничего не найдено" text={search.found ? 'Попробуйте другой запрос.' : 'Под эту метку ничего не подходит.'} />
      ) : (
        <ul className="pb-6">
          <li>
            <TrackTableHeader numbered album added sort={sort === 'new' || sort === 'old' ? sort : null} onSort={(next) => setSort(next === 'old' ? 'old' : 'new')} />
          </li>
          {shown.map((t, i) => {
            const day = byDays ? dayOf(t.added_at) : null;
            const head = day !== null && (i === 0 || dayOf(shown[i - 1].added_at) !== day);
            return (
              <li key={`${t.ref}:${t.library_track_id}`}>
                {head && (
                  <h2 className="px-4 pb-1 pt-4 text-xs font-semibold text-muted lg:px-6">
                    {day} <span className="font-normal text-dim">· {tracksWord(days.get(day as string) ?? 0)}</span>
                  </h2>
                )}
                <TrackRow track={t} queue={shown} link={false} showAlbum showAdded index={i + 1} />
              </li>
            );
          })}
        </ul>
      )}

      <CreateAlbumSheet open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateAlbumSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [year, setYear] = useState('');
  const [genre, setGenre] = useState('');
  const [type, setType] = useState<ReleaseType>('compilation');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const a = await attempt(
      () => api.createAlbum({ title: title.trim(), album_artist: artist.trim() || 'Various Artists', year: toIntOrNull(year), genre: genre.trim() || null, release_type: type }),
      'Альбом создан',
    );
    setBusy(false);
    if (a) {
      onClose();
      navigate(`/library/album/${a.id}`);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Создать свой альбом"
      footer={
        <Button variant="primary" block busy={busy} disabled={!title.trim()} onClick={create}>
          Создать
        </Button>
      }
    >
      <p className="mb-4 text-sm text-muted">Пустой альбом или подборка: потом перенесите в него треки из других альбомов.</p>
      <div className="space-y-4">
        <Field label="Название">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Исполнитель альбома">
          <input className="input" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Various Artists" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Год">
            <input className="input" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          </Field>
          <Field label="Жанр">
            <input className="input" value={genre} onChange={(e) => setGenre(e.target.value)} />
          </Field>
        </div>
        <Field label="Тип">
          <ReleaseTypeSelect value={type} onChange={setType} />
        </Field>
      </div>
    </Sheet>
  );
}

export function ReleaseTypeSelect({ value, onChange }: { value: ReleaseType; onChange: (v: ReleaseType) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value as ReleaseType)}>
      <option value="album">Альбом</option>
      <option value="single">Сингл</option>
      <option value="ep">EP</option>
      <option value="compilation">Сборник</option>
    </select>
  );
}

/** Albums that are one album in pieces: the same name, artists that differ only by a guest («Три дня дождя» and
 * «Три дня дождя, Роки») — files that name no artist of their album were filed by their own. Each group is joined
 * by a tap, into the one with the most tracks; not by itself: two releases of one name do happen. */
function SplitAlbumsCard({ onJoined }: { onJoined: () => void }) {
  const res = useAsync((s) => api.splitAlbums(s), []);
  const [busy, setBusy] = useState<number | null>(null);
  const groups = res.data ?? [];
  if (!groups.length) return null;
  const join = async (g: (typeof groups)[number]) => {
    setBusy(g.target_id);
    const ok = await attempt(() => api.mergeAlbums({ target_id: g.target_id, source_ids: g.albums.filter((a) => a.id !== g.target_id).map((a) => a.id) }), `«${g.title}» — один альбом`);
    setBusy(null);
    if (!ok) return;
    res.reload(true);
    onJoined();
  };
  return (
    <section aria-label="Расколотые альбомы" className="card mx-4 mb-4 p-3">
      <h2 className="text-sm font-semibold">Один альбом в нескольких частях · {groups.length}</h2>
      <p className="pb-2 pt-0.5 text-xs text-muted">Название одно, а исполнители отличаются только гостями. Объедините, если это один релиз.</p>
      <ul className="space-y-2">
        {groups.map((g) => (
          <li key={g.target_id} className="flex items-center gap-3">
            <Cover src={g.albums.find((a) => a.has_cover) ? libraryCoverUrl((g.albums.find((a) => a.has_cover) as { id: number }).id, 96) : null} size={40} icon="disc" alt="" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{g.title}</span>
              <span className="block truncate text-xs text-muted">{g.albums.map((a) => `${a.album_artist} (${a.track_count})`).join(' + ')}</span>
            </span>
            <Button small busy={busy === g.target_id} onClick={() => void join(g)}>
              Объединить
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
