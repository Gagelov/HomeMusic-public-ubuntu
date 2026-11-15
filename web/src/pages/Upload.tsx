import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, uploadCoverUrl } from '../api/client';
import type { CoverInfo, TrackOut, UploadAlbumIn, UploadOut, UploadTrackIn } from '../api/types';
import { Icon } from '../components/Icon';
import { PlaylistsPick } from '../components/PlaylistsButton';
import { Button, Checkbox, Cover, Empty, ErrorState, Field, IconButton, Loading, PageHeader, ProgressBar, Sheet, Spinner, cx } from '../components/ui';
import { useDesktop } from '../lib/desktop';
import { fmtDuration, fmtSize, plural, toIntOrNull, tracksWord } from '../lib/format';
import { useAsync, useDebounced } from '../lib/hooks';
import { imageUrl } from '../lib/img';
import { listen, useListen, type ListenTrack } from '../lib/listen';
import { navigate } from '../lib/router';
import { openTagsPick, useTags } from '../lib/tags';
import { attempt, confirmDialog, toast } from '../lib/ui';

/** «Загрузить файлы», the first of two steps: what the files are. Files — or a folder, with what is inside its
 * folders — are dropped anywhere on the page or picked; the Hub reads each and looks for the song it is in the
 * catalog (`library/recognize.py`).
 *
 * The page is lists of an album each. What belongs to an album is said once, in its head: its name, its artist and
 * its year are chosen among what the files and the catalog say (or written), and its cover among every picture
 * found — the catalog's and the ones inside the files, each with its size in pixels, its kind and its weight. Under
 * the head its files stand as the tracks of a playlist: the number, the cover that plays the file in the app's own
 * player, the name with everyone credited, the length — and what the catalog changes in the track, in a few words.
 * The singles follow, each with its own picture to choose. A row opens to be put right by hand.
 *
 * A file the catalog only has something *like* is not asked about: it goes in under its own names, and the second
 * step — «Качество звука» (`pages/Quality.tsx`) — settles by the sound whether the record is its own. Nothing here
 * is about how good the files sound either: that is the second step too. */

export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav';
const MAX_SIZE = 500 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i;
const CHUNK = 20; // files brought in by one request: the page says how far it has got

export const isAudioFile = (f: File) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);

// Files handed over by the Share page (Android "Share" → HomeMusic); consumed on mount.
let handoff: File[] = [];
export function queueFilesForUpload(files: File[]) {
  handoff = files;
}

interface Transfer {
  key: string;
  file: File;
  progress: number;
  error?: string;
}

interface RowState {
  include: boolean;
  /** the library has this recording (`UploadOut.twin`) and this file takes the place of its file — else, included,
   * it is added as a track of its own */
  replace: boolean;
  /** filed as the song of the catalog it was told to be; else under the names below */
  catalog: boolean;
  /** a single's picture: the catalog's or the file's (an album's is chosen in its head) */
  cover: 'catalog' | 'file';
  title: string;
  artist: string;
  album: string;
  year: string;
}

/** What was chosen in an album's head (nothing said: the page's own pick — `Group.title` and the rest). */
interface AlbumChoice {
  title?: string;
  artist?: string;
  year?: string;
  cover?: string; // a `Picture.key`
}

/** A picture an album may take: the catalog's of an upload's record, or the one inside an uploaded file. */
interface Picture {
  key: string;
  url: string;
  from: 'catalog' | 'file';
  upload: number;
  /** in how many of the album's files it is */
  count: number;
  info?: CoverInfo | null;
}

/** The files of one album, with everything the album may be called. */
interface Group {
  key: string;
  files: UploadOut[];
  /** an upload whose catalog record stands on this release (none: the catalog does not know the album) */
  release: UploadOut | null;
  titles: string[];
  artists: string[];
  years: string[];
  pictures: Picture[];
  /** the page's pick, where the listener said nothing */
  title: string;
  artist: string;
  year: string;
  cover: string | null;
}

type Only = 'all' | 'fill' | 'doubt' | 'changes' | 'none' | 'twin';

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const low = (s?: string | null) => (s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
const same = (a?: string | null, b?: string | null) => low(a) === low(b);
/** The values of a list, each once, the most frequent first. */
function byCount(list: (string | null | undefined)[]): string[] {
  const n = new Map<string, number>();
  for (const v of list) if (v && v.trim()) n.set(v.trim(), (n.get(v.trim()) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

function rowFromUpload(u: UploadOut): RowState {
  const found = u.match?.state === 'found';
  return {
    // a recording the library has is left out — unless this file is the better one: then it takes the old one's
    // place. One that only sounds like a track of the library (another version of the song) is a track of its own
    include: !u.twin || u.twin.better || !u.twin.sure,
    replace: !!u.twin?.better,
    catalog: found,
    cover: found && u.match?.cover_url ? 'catalog' : 'file',
    title: u.title,
    artist: u.artist,
    album: u.single ? '' : str(u.tags.album),
    year: str(u.tags.year).slice(0, 4),
  };
}

const fileWords = (codec?: string | null, kbps?: number | null) => [codec ? codec.toUpperCase() : null, kbps ? String(kbps) : null].filter(Boolean).join(' ');
/** The record's release as the file is filed by it: no album for a single. */
const catAlbum = (u: UploadOut): string | null => (u.match?.record_type === 'single' || !u.match?.album ? null : u.match.album);
const usesCatalog = (u: UploadOut, r: RowState) => r.catalog && !!u.match?.ref;
const valid = (u: UploadOut, r: RowState) => usesCatalog(u, r) || (!!r.title.trim() && !!r.artist.trim());
/** A record only like the file, not taken by hand: the second step settles it by the sound. */
const unsure = (u: UploadOut, r: RowState) => u.match?.state === 'doubt' && !usesCatalog(u, r);

/** What the catalog's record changes in the track itself — its name, who is credited, its place in the album — in
 * a few words each. A name in another case («утром» for «Утром») is no change: the file's spelling is kept. */
function changesOf(u: UploadOut, inAlbum: boolean): string[] {
  const m = u.match;
  if (!m?.ref) return [];
  const out: string[] = [];
  if (!same(u.title, m.title)) out.push(`название → ${m.title}`);
  const mine = u.artists ?? [];
  const theirs = m.artists?.length ? m.artists : [m.artist ?? ''];
  if (mine.map(low).join('|') !== theirs.map(low).join('|')) out.push(same(mine.join(', '), theirs.join(', ')) || (mine.length === theirs.length && mine.every((a, i) => same(a, theirs[i]))) ? 'исполнители по отдельности' : `исполнители → ${theirs.join(' · ')}`);
  else if (theirs.length > 1 && !(Array.isArray(u.tags.artists) && (u.tags.artists as unknown[]).length > 1)) out.push('исполнители по отдельности');
  if (inAlbum && m.track_no && String(m.track_no) !== str(u.tags.track_no)) out.push(`+ № ${m.track_no}`);
  return out;
}

/** Under a file the library has already: which track it is, how it was told (by the sound of the two files, or by
 * their names and length) and what the library's file is — and what to do with this one: leave it out, put it in
 * the place of the library's file (offered first when this one is better), or add it as a track of its own. */
function TwinNote({ u, r, onChange }: { u: UploadOut; r: RowState; onChange: (patch: Partial<RowState>) => void }) {
  const twin = u.twin;
  if (!twin) return null;
  const mode = !r.include ? 'skip' : r.replace ? 'replace' : 'add';
  const chip = (id: typeof mode, label: string, title: string, patch: Partial<RowState>) => (
    <button type="button" title={title} aria-pressed={mode === id} onClick={() => onChange(patch)} className={cx('rounded-full px-2 py-0.5 text-[11px] transition', mode === id ? 'bg-info/20 font-semibold text-info' : 'bg-fg/5 text-muted hover:text-fg')}>
      {label}
    </button>
  );
  const theirs = fileWords(twin.codec, twin.bitrate_kbps);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-info">
      <span className="min-w-0 truncate" title={!twin.sure ? 'Звучит похоже, но не одинаково: так бывает у версии на другом языке или кавера на ту же музыку' : twin.by === 'sound' ? 'Та же запись — определено по звучанию файлов' : 'То же название, исполнитель и длительность'}>
        {twin.sure ? 'Уже есть' : 'Похоже на'}: «{twin.title}»{theirs ? ` · ${theirs}` : ''} · {twin.by === 'sound' ? 'по звуку' : 'по названию'}
        {twin.better ? ' · этот файл лучше' : ''}
        {!twin.sure ? ' · возможно, другая версия' : ''}
      </span>
      {chip('skip', 'не загружать', 'В библиотеке останется тот файл, что есть', { include: false })}
      {chip('replace', 'заменить', 'Этот файл станет файлом того же трека: плейлисты, лайки и текст останутся при нём', { include: true, replace: true })}
      {chip('add', 'добавить вторым', 'Появится отдельный трек — например, это другая версия записи', { include: true, replace: false })}
    </div>
  );
}

/** The files of a drop: plain files and, through the entries API, everything inside dropped folders. */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void, err: () => void) => void; createReader?: () => { readEntries: (ok: (e: Entry[]) => void, err: () => void) => void } };
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i.kind === 'file' ? ((i as unknown as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null) : null))
    .filter((e): e is Entry => !!e);
  if (!entries.some((e) => e.isDirectory)) return Array.from(dt.files ?? []);
  const out: File[] = [];
  const walk = async (e: Entry): Promise<void> => {
    if (e.isFile && e.file) {
      const f = await new Promise<File | null>((res) => e.file!(res, () => res(null)));
      if (f) out.push(f);
    } else if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** What the catalog's picture of a record is — fetched by the Hub to be measured, a few at a time, once each. */
const measured = new Map<number, Promise<CoverInfo | null>>();
let measuring: Promise<unknown> = Promise.resolve();
function useCatalogCover(upload: number | null): CoverInfo | null {
  const [info, setInfo] = useState<CoverInfo | null>(null);
  useEffect(() => {
    if (upload === null) return;
    let alive = true;
    let p = measured.get(upload);
    if (!p) {
      p = (measuring = measuring.then(() => api.uploadCatalogCover(upload).catch(() => null))) as Promise<CoverInfo | null>;
      measured.set(upload, p);
    }
    void p.then((v) => alive && setInfo(v));
    return () => {
      alive = false;
    };
  }, [upload]);
  return info;
}

const pictureWords = (i?: CoverInfo | null): [string, string] => [i?.w && i?.h ? `${i.w}×${i.h}` : '…', [i?.format === 'JPEG' ? 'JPEG' : i?.format, i?.size ? fmtSize(i.size) : null].filter(Boolean).join(' · ')];

export function UploadPage() {
  const desktop = useDesktop();
  const pendingRes = useAsync((s) => api.uploads('uploaded', s), []);
  const [uploads, setUploads] = useState<UploadOut[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [chosen, setChosen] = useState<Record<string, AlbumChoice>>({}); // by an album's key
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [only, setOnly] = useState<Only>('all');
  const [open, setOpen] = useState<number | null>(null); // the row that is being put right
  const [finding, setFinding] = useState<UploadOut | null>(null); // the file a record is being picked for
  const [playlists, setPlaylists] = useState<{ id: string; name: string }[]>([]);
  const [like, setLike] = useState(false);
  // What is uploaded is kept together in a playlist of the day («Загружено 14 ноября»), so that tracks nobody put
  // anywhere can still be found as one list. Turned off, it stays off on this device.
  const [keep, setKeep] = useState(() => { try { return localStorage.getItem(KEEP_OFF) !== '1'; } catch { return true; } });
  const keepName = useMemo(() => `Загружено ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '')}`, []);
  const turnKeep = (on: boolean) => {
    setKeep(on);
    try { if (on) localStorage.removeItem(KEEP_OFF); else localStorage.setItem(KEEP_OFF, '1'); } catch { /* the choice lasts for this page then */ }
  };
  const [tagIds, setTagIds] = useState<number[]>([]); // the imported tracks get these tags of one's own
  const [plPicker, setPlPicker] = useState(false);
  const [moving, setMoving] = useState<{ done: number; of: number } | null>(null);

  const addUploads = useCallback((list: UploadOut[]) => {
    setUploads((prev) => {
      const seen = new Set(prev.map((u) => u.id));
      return [...prev, ...list.filter((u) => !seen.has(u.id))];
    });
    setRows((prev) => {
      const next = { ...prev };
      for (const u of list) if (!next[u.id]) next[u.id] = rowFromUpload(u);
      return next;
    });
  }, []);

  useEffect(() => {
    if (pendingRes.data) addUploads(pendingRes.data);
  }, [pendingRes.data, addUploads]);

  // a folder is picked by an input of its own: the attribute is not one React knows
  useEffect(() => folderRef.current?.setAttribute('webkitdirectory', ''), []);

  const startUpload = useCallback(
    async (files: File[]) => {
      const ok: File[] = [];
      let skipped = 0;
      for (const f of files) {
        if (f.size > MAX_SIZE) toast(`«${f.name}» больше 500 МБ — пропущен`, 'error');
        else if (!isAudioFile(f)) skipped++;
        else ok.push(f);
      }
      if (skipped) toast(ok.length ? `Не аудио, пропущено: ${skipped}` : 'Здесь нет аудиофайлов', ok.length ? 'info' : 'error');
      const batch: Transfer[] = ok.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, file, progress: 0 }));
      setTransfers((prev) => [...prev, ...batch]);
      // Sequential: one slow mobile uplink is better used by one file at a time.
      for (const t of batch) {
        try {
          const res = await api.uploadFiles([t.file], (p) => setTransfers((prev) => prev.map((x) => (x.key === t.key ? { ...x, progress: p } : x))));
          addUploads(res);
          setTransfers((prev) => prev.filter((x) => x.key !== t.key));
        } catch (e) {
          setTransfers((prev) => prev.map((x) => (x.key === t.key ? { ...x, error: errorMessage(e) } : x)));
        }
      }
    },
    [addUploads],
  );

  useEffect(() => {
    if (handoff.length) {
      const files = handoff;
      handoff = [];
      void startUpload(files);
    }
  }, [startUpload]);

  // Files dropped anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void filesFromDrop(e.dataTransfer).then((files) => { if (files.length) void startUpload(files); });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [startUpload]);

  const setRow = (id: number, patch: Partial<RowState>) => setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const rowOf = (u: UploadOut) => rows[u.id] ?? rowFromUpload(u);

  const removeUpload = async (u: UploadOut) => {
    const ok = await confirmDialog({ title: 'Убрать файл?', body: u.orig_name, okLabel: 'Убрать', danger: true });
    if (!ok) return;
    if (await attempt(() => api.deleteUpload(u.id))) setUploads((prev) => prev.filter((x) => x.id !== u.id));
  };

  /** The files left unchecked — what the library has already, as a rule — go off the server in one go. */
  const removeLeftOut = async () => {
    const out = uploads.filter((u) => !rowOf(u).include);
    const ok = await confirmDialog({ title: `Убрать невыбранные: ${tracksWord(out.length)}?`, body: 'Загруженные файлы без галочки удалятся с сервера. Библиотеку это не затронет.', okLabel: 'Убрать', danger: true });
    if (!ok) return;
    const gone = new Set<number>();
    for (const u of out) if (await attempt(() => api.deleteUpload(u.id))) gone.add(u.id);
    setUploads((prev) => prev.filter((u) => !gone.has(u.id)));
  };

  /** The record of the catalog a file is, picked by hand (or looked for again): the row is the catalog's then. */
  const rematch = async (u: UploadOut, ref?: string | null) => {
    const next = await attempt(() => api.matchUpload(u.id, ref));
    if (!next) return;
    setUploads((prev) => prev.map((x) => (x.id === u.id ? next : x)));
    const taken = ref ? true : next.match?.state === 'found';
    setRow(u.id, { catalog: taken, cover: taken && next.match?.cover_url ? 'catalog' : 'file' });
  };

  /** Every file's album: the catalog's release when its record is taken; else the file's own album — the same one
   * when a release of that name and artist is among the files (a track the catalog does not know stays with its
   * album); none — a single. */
  const all = useMemo(() => {
    const row = (u: UploadOut) => rows[u.id] ?? rowFromUpload(u);
    const releases = new Map<string, string>(); // name|artist -> the release's key
    const keys = new Map<number, string | null>();
    for (const u of uploads) {
      const a = usesCatalog(u, row(u)) ? catAlbum(u) : null;
      if (!a) continue;
      const k = `c|${low(a)}|${low(u.match?.album_artist ?? u.match?.artist)}`;
      keys.set(u.id, k);
      releases.set(`${low(a)}|${low(u.match?.album_artist ?? u.match?.artist)}`, k);
    }
    for (const u of uploads) {
      if (keys.has(u.id)) continue;
      const r = row(u);
      const a = r.album.trim();
      if (!a || same(a, r.title)) {
        keys.set(u.id, null);
        continue;
      }
      const by = str(u.tags.album_artist) || u.artists?.[0] || r.artist;
      keys.set(u.id, releases.get(`${low(a)}|${low(by)}`) ?? `o|${low(a)}|${low(by)}`);
    }
    const groups = new Map<string, Group>();
    for (const u of uploads) {
      const k = keys.get(u.id);
      if (!k) continue;
      const g = groups.get(k) ?? groups.set(k, { key: k, files: [], release: null, titles: [], artists: [], years: [], pictures: [], title: '', artist: '', year: '', cover: null }).get(k)!;
      g.files.push(u);
    }
    for (const g of groups.values()) {
      const taken = g.files.filter((u) => usesCatalog(u, row(u)) && !!catAlbum(u));
      g.release = taken[0] ?? null;
      const m = g.release?.match;
      const own = g.files.filter((u) => !u.single);
      g.titles = byCount([m ? catAlbum(g.release!) : null, ...own.map((u) => str(u.tags.album))]);
      g.artists = byCount([m?.album_artist ?? null, ...own.map((u) => str(u.tags.album_artist) || u.artists?.[0])]);
      g.years = byCount([m?.year ? String(m.year) : null, ...own.map((u) => str(u.tags.year).slice(0, 4))]);
      g.title = (m ? catAlbum(g.release!) : null) ?? g.titles[0] ?? '';
      g.artist = m?.album_artist ?? g.artists[0] ?? '';
      g.year = m?.year ? String(m.year) : (g.years[0] ?? '');
      const pics = new Map<string, Picture>();
      const withCat = taken.find((u) => u.match?.cover_url);
      if (withCat) pics.set('catalog', { key: 'catalog', url: imageUrl(withCat.match!.cover_url!) as string, from: 'catalog', upload: withCat.id, count: 0 });
      for (const u of g.files) {
        const info = u.tags.cover_info;
        if (!u.tags.has_cover) continue;
        const key = `f:${info?.hash ?? u.id}`;
        const p = pics.get(key);
        if (p) p.count++;
        else pics.set(key, { key, url: uploadCoverUrl(u.id), from: 'file', upload: u.id, count: 1, info });
      }
      g.pictures = [...pics.values()].sort((a, b) => Number(b.from === 'catalog') - Number(a.from === 'catalog') || b.count - a.count);
      g.cover = g.pictures[0]?.key ?? null;
    }
    return { keys, groups };
  }, [uploads, rows]);

  const albumOf = (g: Group) => {
    const c = chosen[g.key] ?? {};
    return { title: c.title ?? g.title, artist: c.artist ?? g.artist, year: c.year ?? g.year, cover: g.pictures.find((p) => p.key === (c.cover ?? g.cover)) ?? null };
  };
  const choose = (g: Group, patch: AlbumChoice) => setChosen((prev) => ({ ...prev, [g.key]: { ...prev[g.key], ...patch } }));
  const groupOf = (u: UploadOut): Group | null => {
    const k = all.keys.get(u.id);
    return k ? (all.groups.get(k) ?? null) : null;
  };

  const included = uploads.filter((u) => rowOf(u).include);
  const ready = included.filter((u) => valid(u, rowOf(u)));
  const toFill = included.filter((u) => !valid(u, rowOf(u)));
  const isNone = (u: UploadOut) => !u.match?.ref;
  const changes = (u: UploadOut) => usesCatalog(u, rowOf(u)) && changesOf(u, !!groupOf(u)).length > 0;
  const counts = {
    fill: toFill.length,
    doubt: uploads.filter((u) => unsure(u, rowOf(u))).length,
    changes: uploads.filter(changes).length,
    none: uploads.filter(isNone).length,
    twin: uploads.filter((u) => u.twin).length,
  };
  const passes = (u: UploadOut) =>
    only === 'fill' ? rowOf(u).include && !valid(u, rowOf(u)) : only === 'doubt' ? unsure(u, rowOf(u)) : only === 'changes' ? changes(u) : only === 'none' ? isNone(u) : only === 'twin' ? !!u.twin : true;
  const shown = uploads.filter(passes);
  const shownGroups = [...all.groups.values()].map((g) => ({ g, files: g.files.filter(passes) })).filter((x) => x.files.length);
  const shownSingles = shown.filter((u) => !all.keys.get(u.id));

  /** The picture a file is shown with — and filed with: its album's, or a single's own choice. */
  const pictureOf = (u: UploadOut): string | null => {
    const g = groupOf(u);
    if (g) return albumOf(g).cover?.url ?? null;
    const r = rowOf(u);
    const theirs = usesCatalog(u, r) && u.match?.cover_url ? (imageUrl(u.match.cover_url) as string) : null;
    const mine = u.tags.has_cover ? uploadCoverUrl(u.id) : null;
    return r.cover === 'catalog' ? (theirs ?? mine) : (mine ?? theirs);
  };
  /** The files as the tracks of the app's player: a tap on a cover plays from that file on, down the page. */
  const asTrack = (u: UploadOut): ListenTrack => {
    const r = rowOf(u);
    const by = usesCatalog(u, r);
    const g = groupOf(u);
    return {
      ref: `up:${u.id}`,
      title: by ? (same(u.title, u.match?.title) ? u.title : (u.match?.title ?? u.title)) : r.title || u.title,
      artist: by ? (u.match?.artists?.length ? u.match.artists.join(', ') : (u.match?.artist ?? '')) : r.artist,
      cover_url: pictureOf(u),
      cover_small_url: pictureOf(u),
      album: g ? albumOf(g).title : undefined,
      duration_s: u.duration_s ? Math.round(u.duration_s) : null,
    };
  };
  const order = [...shownGroups.flatMap((x) => x.files), ...shownSingles];
  const play = (u: UploadOut) => listen(asTrack(u), order.map(asTrack), 'upload');

  const uploadingNow = transfers.some((t) => !t.error);
  const canCommit = ready.length > 0 && !uploadingNow && !moving;

  const trackIn = (u: UploadOut): UploadTrackIn => {
    const r = rowOf(u);
    return {
      upload_id: u.id, catalog: usesCatalog(u, r), title: r.title.trim(), artist: r.artist.trim(), album: r.album.trim() || null, year: toIntOrNull(r.year),
      album_key: all.keys.get(u.id) ?? null, cover: r.cover, replace_track_id: r.replace && u.twin ? u.twin.track_id : null,
    };
  };
  const albumIn = (g: Group): UploadAlbumIn => {
    const a = albumOf(g);
    return {
      key: g.key, title: a.title.trim() || g.title, album_artist: a.artist.trim() || g.artist || 'Various Artists', year: toIntOrNull(a.year), release_of: g.release?.id ?? null,
      cover_of_match: a.cover?.from === 'catalog' ? a.cover.upload : null, cover_of_file: a.cover?.from === 'file' ? a.cover.upload : null,
    };
  };

  /** The files go in by parts, so that the page says how far it has got; what went in leaves the list. The ones
   * that lack a name stay on the page. Then the second step: the weak files are looked for anew there, and the
   * records that were only like their files are settled by the sound. */
  const commit = async () => {
    const list = [...order.filter((u) => ready.includes(u)), ...ready.filter((u) => !order.includes(u))]; // an album's files together
    const albums = new Map([...all.groups.values()].map((g) => [g.key, albumIn(g)]));
    let imported = 0;
    let weak = 0;
    let doubts = 0;
    const tracks: number[] = [];
    setMoving({ done: 0, of: list.length });
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK).map(trackIn);
      const res = await attempt(() =>
        api.commitUploads({ tracks: part, albums: [...new Set(part.map((t) => t.album_key).filter((k): k is string => !!k))].map((k) => albums.get(k)!), playlist_ids: playlists.map((p) => p.id), star: like, tag_ids: tagIds, keep_in: keep ? keepName : null }));
      if (!res) break;
      imported += res.imported;
      weak += res.weak;
      doubts += res.unsure;
      tracks.push(...res.track_ids);
      const done = new Set(part.map((t) => t.upload_id));
      setUploads((prev) => prev.filter((u) => !done.has(u.id)));
      setMoving({ done: Math.min(i + CHUNK, list.length), of: list.length });
    }
    setMoving(null);
    if (!imported) return;
    const whole = imported === list.length && !toFill.length;
    if (weak || doubts) {
      if (weak) await attempt(() => api.qualityStart(tracks));
      toast(`Перенесено: ${tracksWord(imported)}. Дальше — качество звука: ${[weak ? `слабых файлов ${weak}` : null, doubts ? `уточнить по звуку ${doubts}` : null].filter(Boolean).join(', ')}`, 'success');
      if (whole) navigate('/quality', { replace: true });
      return;
    }
    toast(`Перенесено: ${tracksWord(imported)}`, 'success');
    if (whole) navigate('/files', { replace: true });
  };

  const totalSize = included.reduce((n, u) => n + u.size, 0);
  const chips: [Only, string, number, boolean?][] = [
    ['all', 'Все', uploads.length],
    ['fill', 'Нужно заполнить', counts.fill, true],
    ['changes', 'Изменится', counts.changes],
    ['doubt', 'Уточню на шаге 2', counts.doubt],
    ['none', 'Не найдено', counts.none],
    ['twin', 'Уже есть', counts.twin],
  ];

  const importButton = uploads.length > 0 && (
    <Button variant="primary" small icon="check" busy={!!moving} disabled={!canCommit} onClick={commit}>
      {moving ? `Переношу ${moving.done} из ${moving.of}` : `Перенести ${tracksWord(ready.length)}`}
    </Button>
  );

  const pick = (label: string, ref: React.RefObject<HTMLInputElement | null>) => (
    <Button small onClick={() => ref.current?.click()}>
      {label}
    </Button>
  );

  const row = (u: UploadOut, g: Group | null, at: number) => (
    <FileRow
      key={u.id}
      u={u}
      r={rowOf(u)}
      desktop={desktop}
      inAlbum={!!g}
      number={g ? ((usesCatalog(u, rowOf(u)) && u.match?.track_no) || toIntOrNull(str(u.tags.track_no))) : at + 1}
      picture={pictureOf(u)}
      open={open === u.id}
      onPlay={() => play(u)}
      onOpen={() => setOpen(open === u.id ? null : u.id)}
      onChange={(patch) => setRow(u.id, patch)}
      onFind={() => setFinding(u)}
      onAgain={() => void rematch(u)}
      onRemove={() => void removeUpload(u)}
    />
  );

  return (
    <div className="pb-10">
      <PageHeader title="Загрузить файлы" back="/files" sub={included.length ? `${plural(included.length, ['Выбран', 'Выбрано', 'Выбрано'])} ${included.length} из ${uploads.length} · ${fmtSize(totalSize)}` : undefined} right={importButton || undefined} />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" aria-hidden="true">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-accent">
            <Icon name="upload" size={32} />
            <span className="font-semibold">Отпустите, чтобы загрузить</span>
          </div>
        </div>
      )}

      {uploads.length > 0 && <Steps at={1} />}

      <div className="px-4 lg:px-6">
        {[fileRef, folderRef].map((ref, i) => (
          <input
            key={i}
            ref={ref}
            type="file"
            multiple
            accept={i === 0 ? AUDIO_ACCEPT : undefined}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
              e.target.value = '';
              if (files.length) void startUpload(files);
            }}
          />
        ))}
        <div className={cx('flex items-center gap-3 rounded-2xl border-2 border-dashed border-line bg-surface', uploads.length ? 'px-4 py-3' : 'flex-col px-4 py-8 text-center')}>
          <span className={cx('flex shrink-0 items-center justify-center rounded-full bg-accent text-on-accent', uploads.length ? 'h-9 w-9' : 'h-12 w-12')}>
            <Icon name="upload" size={uploads.length ? 18 : 24} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{uploads.length ? 'Добавить ещё' : 'Перетащите сюда аудиофайлы или папку'}</span>
            <span className="block text-xs text-muted">{uploads.length ? 'Перетащите файлы или папку в любое место страницы' : 'MP3, M4A, FLAC, OGG/Opus, WAV · до 500 МБ на файл · папка читается вместе с подпапками'}</span>
          </span>
          <span className="flex shrink-0 flex-wrap justify-center gap-2">
            {pick('Выбрать файлы', fileRef)}
            {desktop && pick('Выбрать папку', folderRef)}
          </span>
        </div>
      </div>

      {transfers.length > 0 && (
        <div className="mx-4 mt-3 rounded-2xl bg-surface p-3 lg:mx-6" aria-label="Передача файлов">
          {(() => {
            const going = transfers.find((t) => !t.error);
            const failed = transfers.filter((t) => t.error);
            return (
              <>
                {going && (
                  <>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{going.file.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted">осталось {transfers.length - failed.length}</span>
                    </div>
                    <ProgressBar value={going.progress} className="mt-2" />
                    <p className="pt-1.5 text-xs text-dim">Каждый файл сверяется с каталогом — это секунда-другая на файл. Вкладку не закрывайте.</p>
                  </>
                )}
                {failed.map((t) => (
                  <div key={t.key} className="flex items-center gap-2 pt-1 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {t.file.name} <span className="text-xs text-danger">— {t.error}</span>
                    </span>
                    <IconButton icon="x" size={16} label="Убрать" onClick={() => setTransfers((prev) => prev.filter((x) => x.key !== t.key))} />
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      )}

      {uploads.length > 0 && (
        <AfterImport
          className="mx-4 mt-3 lg:mx-6"
          count={ready.length}
          like={like}
          onLike={setLike}
          playlists={playlists}
          onPlaylists={setPlaylists}
          onPickPlaylists={() => setPlPicker(true)}
          tagIds={tagIds}
          onTags={setTagIds}
          keepName={keepName}
          keep={keep}
          onKeep={turnKeep}
        />
      )}

      {pendingRes.loading && !uploads.length ? (
        <Loading text="Проверяю незавершённые загрузки…" />
      ) : pendingRes.error && !uploads.length ? (
        <ErrorState text={pendingRes.error} onRetry={() => pendingRes.reload()} />
      ) : uploads.length === 0 ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 pt-4 lg:px-6">
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto" role="group" aria-label="Какие файлы показывать" style={{ scrollbarWidth: 'none' }}>
              {chips.filter(([id, , n]) => id === 'all' || id === only || n > 0).map(([id, label, n, urgent]) => (
                <button key={id} type="button" aria-pressed={only === id} onClick={() => setOnly(only === id ? 'all' : id)} className={cx('shrink-0 rounded-full px-3 py-1.5 text-sm transition', only === id ? (urgent ? 'bg-danger font-semibold text-white' : 'bg-fg font-semibold text-bg') : urgent ? 'bg-danger/15 text-danger' : 'bg-fg/10 text-muted hover:text-fg')}>
                  {label}
                  <span className={cx('pl-1.5 tabular-nums', only === id || urgent ? 'opacity-80' : 'text-dim')}>{n}</span>
                </button>
              ))}
            </div>
            {included.length < uploads.length && (
              <Button small icon="trash" onClick={removeLeftOut}>
                Убрать невыбранные · {uploads.length - included.length}
              </Button>
            )}
          </div>
          {toFill.length > 0 && (
            <p className="px-4 pt-2 text-xs text-muted lg:px-6">
              {tracksWord(toFill.length)} без названия или исполнителя не {plural(toFill.length, ['перенесётся', 'перенесутся', 'перенесутся'])}, пока вы {plural(toFill.length, ['его', 'их', 'их'])} не заполните — метка «Нужно заполнить». Остальные {ready.length} можно переносить.
            </p>
          )}
          {only === 'doubt' && <p className="px-4 pt-2 text-xs text-muted lg:px-6">В каталоге есть похожая запись, но не точно эта: другая длина или версия. Такие треки переносятся со своими тегами, а на шаге 2 запись каталога скачивается и сравнивается с вашим файлом по звуку.</p>}

          {shown.length === 0 && <div className="mx-4 mt-3 rounded-2xl bg-surface lg:mx-6"><Empty icon="search" title="Под эту метку ничего не подходит" /></div>}
          {shownGroups.map(({ g, files }) => (
            <section key={g.key} className="mx-4 mt-3 overflow-hidden rounded-2xl bg-surface lg:mx-6" aria-label={`Альбом «${albumOf(g).title}»`}>
              <AlbumHead g={g} now={albumOf(g)} said={chosen[g.key] ?? {}} onChoose={(patch) => choose(g, patch)} shown={files.length} />
              {files.map((u, i) => row(u, g, i))}
            </section>
          ))}
          {shownSingles.length > 0 && (
            <section className="mx-4 mt-3 overflow-hidden rounded-2xl bg-surface lg:mx-6" aria-label="Синглы и треки без альбома">
              <div className="border-b border-line/60 bg-fg/[0.04] px-4 py-2 text-xs text-muted">
                <span className="text-sm font-semibold text-fg">Синглы и треки без альбома</span> · <span className="tabular-nums">{shownSingles.length}</span>
              </div>
              {shownSingles.map((u, i) => row(u, null, i))}
            </section>
          )}
        </>
      )}

      {plPicker && (
        <PlaylistsPick
          title={`${tracksWord(ready.length)} — в плейлисты`}
          picked={playlists}
          liked={like}
          onClose={() => setPlPicker(false)}
          onDone={(list, liked) => {
            setPlaylists(list);
            setLike(liked);
            setPlPicker(false);
          }}
        />
      )}
      {finding && (
        <FindRecord
          u={finding}
          onClose={() => setFinding(null)}
          onPick={(ref) => {
            const u = finding;
            setFinding(null);
            void rematch(u, ref);
          }}
        />
      )}
    </div>
  );
}

/** The two steps of bringing music in, over both of their pages: where one is. */
export function Steps({ at }: { at: 1 | 2 }) {
  const step = (n: 1 | 2, label: string) => (
    <span className={cx('flex items-center gap-2', at === n ? 'font-semibold text-fg' : 'text-muted')}>
      <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-xs', at === n ? 'bg-accent text-on-accent' : 'bg-fg/10')}>{at > n ? <Icon name="check" size={13} /> : n}</span>
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 pb-3 text-sm lg:px-6" aria-label="Шаги">
      {step(1, 'Данные и обложки')}
      <span className="h-px w-8 bg-line" aria-hidden="true" />
      {step(2, 'Качество звука')}
    </div>
  );
}

/** The head of an album: what the album is called, whose it is, its year and its cover — each chosen among what
 * the files and the catalog say, or written. Where everything says the same there is nothing to choose: it is
 * plain words. */
function AlbumHead({ g, now, said, onChoose, shown }: { g: Group; now: { title: string; artist: string; year: string; cover: Picture | null }; said: AlbumChoice; onChoose: (patch: AlbumChoice) => void; shown: number }) {
  const [writing, setWriting] = useState<'title' | 'artist' | 'year' | null>(null);
  const field = (name: 'title' | 'artist' | 'year', label: string, variants: string[], value: string, none: string) => {
    const own = said[name] !== undefined && !variants.includes(said[name] as string);
    const chip = (v: string) => (
      <button key={v} type="button" aria-pressed={value === v} onClick={() => { setWriting(null); onChoose({ [name]: v }); }} className={cx('max-w-full truncate rounded-full px-3 py-1 text-sm transition', value === v ? 'bg-info/20 font-semibold text-info' : 'bg-fg/10 text-muted hover:text-fg')}>
        {v}
      </button>
    );
    return (
      <div className="grid items-center gap-2 py-1 md:grid-cols-[6.5rem_minmax(0,1fr)]">
        <span className="text-xs text-muted">{label}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {variants.length <= 1 && !own && writing !== name ? <span className={cx('truncate', name === 'title' ? 'text-[15px] font-semibold' : 'text-sm')}>{value || none}</span> : variants.map(chip)}
          {own && writing !== name && chip(said[name] as string)}
          {writing === name ? (
            <input
              className="input !h-8 w-56 !py-1 text-sm"
              autoFocus
              inputMode={name === 'year' ? 'numeric' : undefined}
              placeholder={label}
              aria-label={`${label}: своё`}
              defaultValue={own ? value : ''}
              onBlur={(e) => {
                const v = name === 'year' ? e.target.value.replace(/\D/g, '').slice(0, 4) : e.target.value.trim();
                if (v) onChoose({ [name]: v });
                setWriting(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button type="button" aria-label={`${label}: вписать своё`} title="Вписать своё" onClick={() => setWriting(name)} className="flex h-7 w-7 items-center justify-center rounded-full text-dim hover:bg-fg/10 hover:text-fg">
              <Icon name="edit" size={14} />
            </button>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="border-b border-line/60 bg-fg/[0.04] px-4 pb-3 pt-2">
      <div className="pb-1 text-[11px] text-dim">
        Альбом · {g.files.length} {plural(g.files.length, ['файл', 'файла', 'файлов'])}
        {shown < g.files.length ? ` · показано ${shown}` : ''}
        {g.release ? '' : ' · в каталоге не найден'}
      </div>
      {field('title', 'Название', g.titles, now.title, 'без названия')}
      {field('artist', 'Исполнитель', g.artists, now.artist, 'не указан')}
      {field('year', 'Год', g.years, now.year, 'не указан')}
      {g.pictures.length > 0 && (
        <div className="grid items-start gap-2 pt-1 md:grid-cols-[6.5rem_minmax(0,1fr)]">
          <span className="text-xs text-muted md:pt-7">Обложка</span>
          <div className="flex flex-wrap gap-3">
            {g.pictures.map((p) => (
              <PictureOption key={p.key} p={p} on={now.cover?.key === p.key} only={g.pictures.length === 1} onClick={() => onChoose({ cover: p.key })} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A picture an album may take, with what it is under it: its size in pixels, its kind, its weight. */
function PictureOption({ p, on, only, onClick }: { p: Picture; on: boolean; only: boolean; onClick: () => void }) {
  const fetched = useCatalogCover(p.from === 'catalog' ? p.upload : null);
  const [px, rest] = pictureWords(p.from === 'catalog' ? fetched : p.info);
  return (
    <button type="button" aria-pressed={on} disabled={only} onClick={onClick} title={p.from === 'catalog' ? 'Обложка из каталога' : `Обложка из ${p.count} ${plural(p.count, ['файла', 'файлов', 'файлов'])}`} className="flex w-[5.5rem] flex-col items-center gap-1 text-center">
      <span className={cx('rounded-lg transition', on && !only ? 'ring-2 ring-accent' : !only && 'opacity-60 hover:opacity-100')}>
        <Cover src={p.url} size={72} alt="" />
      </span>
      <span className="text-[11px] leading-tight text-dim">
        {px}
        <br />
        {rest || ' '}
      </span>
    </button>
  );
}

const ROW = { gridTemplateColumns: '2.75rem 1.75rem 2.5rem minmax(0,1.4fr) minmax(0,1fr) 3rem 2.5rem' };

/** A file as a track of a list: its number, the cover that plays it in the app's player, its name with everyone
 * credited, what the catalog changes in it, its length. Open, it is put right by hand. */
function FileRow({ u, r, desktop, inAlbum, number, picture, open, onPlay, onOpen, onChange, onFind, onAgain, onRemove }: { u: UploadOut; r: RowState; desktop: boolean; inAlbum: boolean; number: number | null | false | 0 | undefined; picture: string | null; open: boolean; onPlay: () => void; onOpen: () => void; onChange: (patch: Partial<RowState>) => void; onFind: () => void; onAgain: () => void; onRemove: () => void }) {
  const m = u.match;
  const has = !!m?.ref;
  const by = usesCatalog(u, r);
  const lacks = !by && (!r.title.trim() || !r.artist.trim());
  const phase = useListen((s) => (s.track?.ref === `up:${u.id}` ? s.phase : null));
  const playing = phase === 'playing' || phase === 'resolving' || phase === 'loading';
  const title = by ? (same(u.title, m?.title) ? u.title : m?.title) : r.title;
  const artists = by ? (m?.artists?.length ? m.artists : [m?.artist ?? '']).join(' · ') : r.artist;
  const notes: ReactNode[] = [];
  if (by) for (const c of changesOf(u, inAlbum)) notes.push(<span key={c} className="max-w-full truncate rounded-full bg-fg/10 px-2 py-0.5 text-[11px] text-muted">{c}</span>);
  else if (unsure(u, r)) notes.push(<span key="q" title={`В каталоге похожая запись: «${m?.title}» — ${m?.artist}. ${m?.why ?? ''}`} className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">уточню по звуку на шаге 2</span>);
  else if (has) notes.push(<span key="off" className="text-[11px] text-dim">данные каталога отключены</span>);
  else notes.push(<span key="none" className="text-[11px] text-dim">трека нет в каталоге</span>);
  // a single chooses its own picture, where there are two
  const mine = u.tags.has_cover ? uploadCoverUrl(u.id) : null;
  const theirs = by && m?.cover_url ? (imageUrl(m.cover_url) as string) : null;
  const pictures = !inAlbum && mine && theirs && (
    <span className="flex shrink-0 items-center gap-1" title="Обложка сингла">
      {([['catalog', theirs], ['file', mine]] as const).map(([which, url]) => (
        <button key={which} type="button" aria-pressed={r.cover === which} aria-label={which === 'catalog' ? 'Обложка из каталога' : 'Обложка из файла'} title={which === 'catalog' ? 'Обложка из каталога' : 'Обложка из файла'} onClick={() => onChange({ cover: which })} className={cx('rounded transition', r.cover === which ? 'ring-2 ring-accent' : 'opacity-45 hover:opacity-100')}>
          <Cover src={url} size={22} alt="" />
        </button>
      ))}
    </span>
  );
  const cover = (
    <button type="button" aria-label={playing ? 'Пауза' : `Слушать «${title}»`} onClick={onPlay} className="group/c relative flex h-10 w-10 shrink-0 items-center justify-center">
      <Cover src={picture} size={40} alt="" />
      <span aria-hidden="true" className={cx('absolute inset-0 flex items-center justify-center rounded-md bg-black/60 text-white', !phase && 'opacity-0 group-hover/c:opacity-100')}>
        {phase === 'resolving' || phase === 'loading' ? <Spinner size={16} /> : <Icon name={playing ? 'pause' : 'play'} size={16} filled />}
      </span>
    </button>
  );
  const names = lacks ? (
    <span className="flex min-w-0 flex-col gap-1.5 py-0.5 md:flex-row">
      <input className={cx('input !h-8 !py-1 text-sm', !r.title.trim() && '!border-danger')} placeholder="Название" aria-label="Название" value={r.title} onChange={(e) => onChange({ title: e.target.value })} />
      <input className={cx('input !h-8 !py-1 text-sm', !r.artist.trim() && '!border-danger')} placeholder="Исполнитель" aria-label="Исполнитель" value={r.artist} onChange={(e) => onChange({ artist: e.target.value })} />
    </span>
  ) : (
    <span className="min-w-0">
      <span className={cx('block truncate text-[15px]', phase && 'text-accent')}>{title}</span>
      <span className="block truncate text-[13px] text-muted">{artists}</span>
    </span>
  );
  return (
    <div role="row" className={cx('border-b border-line/60 last:border-0', !r.include && 'opacity-60')}>
      <div className="grid min-h-14 items-center gap-2.5 py-1.5 pr-1" style={desktop ? ROW : { gridTemplateColumns: '2.75rem 2.5rem minmax(0,1fr) 2.5rem' }}>
        <Checkbox checked={r.include} onChange={(v) => onChange({ include: v })} label={`Переносить «${u.title}»`} />
        {desktop && <span className="text-center text-sm tabular-nums text-dim">{number || '—'}</span>}
        {cover}
        {desktop ? (
          names
        ) : (
          <span className="min-w-0">
            {names}
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              {notes}
              {pictures}
              <span className="text-[11px] tabular-nums text-dim">{fmtDuration(u.duration_s)}</span>
            </span>
          </span>
        )}
        {desktop && (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {notes}
            {pictures}
          </span>
        )}
        {desktop && <span className="text-right text-xs tabular-nums text-dim">{fmtDuration(u.duration_s)}</span>}
        <IconButton icon={open ? 'down' : 'edit'} size={17} label={open ? 'Свернуть' : 'Изменить'} aria-expanded={open} onClick={onOpen} className="text-dim hover:text-fg" />
      </div>
      {u.twin && <div className="pb-2 pl-12 pr-4 md:pl-[7.5rem]"><TwinNote u={u} r={r} onChange={onChange} /></div>}
      {open && (
        <div className="space-y-3 border-t border-line/60 bg-fg/[0.03] px-4 py-3 md:pl-[7.5rem]">
          {has && (
            <p className="text-sm text-muted">
              {by ? 'Название, исполнители и номер берутся из каталога' : `В каталоге ${m?.state === 'doubt' ? 'похожая запись' : 'запись'}`}: «{m?.title}» — {(m?.artists?.length ? m.artists : [m?.artist]).join(', ')}
              {m?.album ? ` · «${m.album}»` : ''} · {fmtDuration(m?.duration_s)}
              {m?.why ? ` · ${m.why}` : ''}
              {m?.by_hand ? ' · выбрана вручную' : ''}
            </p>
          )}
          {!by && (
            <div className={cx('grid gap-3', inAlbum ? 'md:grid-cols-2' : 'md:grid-cols-[2fr_2fr_2fr_5rem]')}>
              <Field label="Название">
                <input className="input" value={r.title} onChange={(e) => onChange({ title: e.target.value })} />
              </Field>
              <Field label="Исполнители (через запятую)">
                <input className="input" value={r.artist} onChange={(e) => onChange({ artist: e.target.value })} />
              </Field>
              {!inAlbum && (
                <>
                  <Field label="Альбом">
                    <input className="input" value={r.album} placeholder="Пусто — сингл" onChange={(e) => onChange({ album: e.target.value })} />
                  </Field>
                  <Field label="Год">
                    <input className="input" inputMode="numeric" value={r.year} onChange={(e) => onChange({ year: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
                  </Field>
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {has && (
              <Button small onClick={() => onChange({ catalog: !by, cover: !by && m?.cover_url ? 'catalog' : 'file' })}>
                {by ? 'Оставить как в файле' : m?.state === 'doubt' ? 'Это она — взять данные каталога' : 'Взять данные каталога'}
              </Button>
            )}
            <Button small icon="search" onClick={onFind}>
              {has ? 'Другая запись каталога…' : 'Найти в каталоге вручную'}
            </Button>
            {!m?.by_hand && (
              <Button small icon="refresh" onClick={onAgain}>
                Сверить заново
              </Button>
            )}
            <Button small icon="trash" onClick={onRemove}>
              Убрать файл
            </Button>
          </div>
          <p className="truncate text-xs text-dim" title={u.orig_name}>
            {u.orig_name} · {fmtSize(u.size)} · {fileWords(u.codec, u.bitrate_kbps)}
            {inAlbum ? '' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

/** The record of the catalog a file is, picked by hand: the catalog is searched by words, a record is taken by a tap. */
function FindRecord({ u, onClose, onPick }: { u: UploadOut; onClose: () => void; onPick: (ref: string) => void }) {
  const [q, setQ] = useState(`${u.artists?.[0] ?? u.artist} ${u.title}`.trim());
  const dq = useDebounced(q.trim(), 350);
  const res = useAsync((s) => (dq.length > 1 ? api.searchTracks(dq, 0, s).then((r) => r.tracks) : Promise.resolve([] as TrackOut[])), [dq]);
  const found = (res.data ?? []).filter((t) => t.ref.startsWith('dz:'));
  return (
    <Sheet open onClose={onClose} title="Какая это запись">
      <p className="pb-3 text-xs text-muted">
        Файл: {u.title} — {u.artist || 'исполнитель не указан'} · {fmtDuration(u.duration_s)}
      </p>
      <input className="input" type="search" value={q} autoFocus placeholder="Исполнитель и название" aria-label="Поиск по каталогу" onChange={(e) => setQ(e.target.value)} />
      <div className="pt-3">
        {res.loading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : !found.length ? (
          <p className="py-6 text-center text-sm text-muted">{dq.length > 1 ? 'Каталог ничего не нашёл — попробуйте другие слова.' : 'Введите исполнителя и название.'}</p>
        ) : (
          <ul>
            {found.map((t) => (
              <li key={t.ref}>
                <button type="button" onClick={() => onPick(t.ref)} className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-fg/10">
                  <Cover src={t.cover_small_url || t.cover_url} size={40} alt="" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px]">{t.title}</span>
                    <span className="block truncate text-[13px] text-muted">{[t.artists?.length ? t.artists.join(', ') : t.artist, t.album_title].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-dim">{fmtDuration(t.duration_s)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

const KEEP_OFF = 'hm-upload-keep-off';

/** «После загрузки»: where the imported tracks go besides the library — «Любимое», playlists, tags. The same icons
 * as the selection bar's and the same windows; what is chosen stands beside them and is taken off by its ✕. An
 * upload also has the playlist that keeps it together (`keepName`): on unless taken off, and put back by its chip. */
export function AfterImport({ count, like, onLike, playlists, onPlaylists, onPickPlaylists, tagIds, onTags, keepName, keep = false, onKeep, label = 'После загрузки', className = 'mx-4 mt-5' }: { keepName?: string; keep?: boolean; onKeep?: (on: boolean) => void; label?: string; className?: string; count: number; like: boolean; onLike: (v: boolean) => void; playlists: { id: string; name: string }[]; onPlaylists: (list: { id: string; name: string }[]) => void; onPickPlaylists: () => void; tagIds: number[]; onTags: (ids: number[]) => void }) {
  const tags = useTags();
  const picked = tagIds.map((id) => tags.byId.get(id)).filter((t) => !!t);
  const chip = 'flex min-w-0 items-center gap-1.5 rounded-full bg-fg/10 py-1 pl-3 pr-1 text-sm';
  const off = (label: string, onClick: () => void) => (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted hover:bg-fg/10 hover:text-fg">
      <Icon name="x" size={13} stroke={2.5} />
    </button>
  );
  const kept = !!keepName && keep;
  const nothing = !like && !playlists.length && !picked.length && !kept;
  return (
    <div className={cx(className, 'flex flex-wrap items-center gap-x-1 gap-y-2 rounded-2xl bg-surface px-3 py-2')}>
      <span className="pr-2 text-sm text-muted">{label}</span>
      <IconButton icon="playlist" label="В «Любимое» и плейлисты" onClick={onPickPlaylists} className={like || playlists.length ? 'text-accent' : 'text-muted hover:text-fg'} />
      <IconButton icon="tag" label="Теги" onClick={() => openTagsPick(`${tracksWord(count)} — теги`, tagIds, onTags)} className={picked.length ? 'text-accent' : 'text-muted hover:text-fg'} />
      <span className="mx-2 h-5 w-px bg-line" aria-hidden="true" />
      {nothing && <span className="text-xs text-dim">Только в библиотеку. Можно сразу добавить в «Любимое», плейлисты и поставить теги.</span>}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {like && (
          <span className={chip}>
            <Icon name="heart" size={14} filled className="text-accent" />
            Любимое
            {off('Не добавлять в «Любимое»', () => onLike(false))}
          </span>
        )}
        {keepName && onKeep && (kept ? (
          <span className={chip} title="Плейлист создастся сам: в нём останется всё, что загружено за день">
            <Icon name="playlist" size={14} className="shrink-0 text-accent" />
            <span className="truncate">{keepName}</span>
            {off('Не собирать загруженное в плейлист', () => onKeep(false))}
          </span>
        ) : (
          <button type="button" onClick={() => onKeep(true)} className="rounded-full border border-dashed border-line px-3 py-1 text-sm text-muted hover:text-fg">
            + плейлист «{keepName}»
          </button>
        ))}
        {playlists.map((p) => (
          <span key={p.id} className={chip}>
            <Icon name="playlist" size={14} className="shrink-0 text-muted" />
            <span className="truncate">{p.name}</span>
            {off(`Не добавлять в «${p.name}»`, () => onPlaylists(playlists.filter((x) => x.id !== p.id)))}
          </span>
        ))}
        {picked.map((t) => (
          <span key={t.id} className={chip}>
            <Icon name="tag" size={14} className="shrink-0 text-muted" />
            <span className="truncate">{t.name}</span>
            {off(`Не ставить тег «${t.name}»`, () => onTags(tagIds.filter((x) => x !== t.id)))}
          </span>
        ))}
      </div>
    </div>
  );
}
