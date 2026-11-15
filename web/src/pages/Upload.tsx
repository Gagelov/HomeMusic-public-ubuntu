import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, uploadCoverUrl } from '../api/client';
import type { TrackOut, UploadOut, UploadTrackIn } from '../api/types';
import { Icon } from '../components/Icon';
import { PlaylistsPick } from '../components/PlaylistsButton';
import { Button, Checkbox, Cover, Empty, ErrorState, Field, IconButton, Loading, PageHeader, ProgressBar, Sheet, Spinner, cx } from '../components/ui';
import { useDesktop } from '../lib/desktop';
import { fmtDuration, fmtSize, plural, toIntOrNull, tracksWord } from '../lib/format';
import { useAsync, useDebounced } from '../lib/hooks';
import { imageUrl } from '../lib/img';
import { navigate } from '../lib/router';
import { openTagsPick, useTags } from '../lib/tags';
import { attempt, confirmDialog, toast } from '../lib/ui';

/** «Загрузить файлы», the first of two steps: what the files are. Files — or a folder, with what is inside its
 * folders — are dropped anywhere on the page or picked. The Hub reads each and looks for the song it is in the
 * catalog (`library/recognize.py`); the page lays the two one over the other — «Ваш файл» and «Каталог» — with what
 * the catalog says otherwise marked, and the listener takes one of them by its dot: a found record is taken by
 * itself, one only like the file («Похожая») is not. The picture is chosen apart from the names, by a tap on it —
 * an album has one cover, chosen in the album's head, and a track may keep a picture of its own over it. Both can
 * be heard: the file whole, the catalog's record for half a minute. A file with nothing to compare takes one line.
 * The files stand by the albums they go into, the singles last.
 *
 * Nothing here is about how good the files sound: that is the second step, «Качество звука» (`pages/Quality.tsx`),
 * where the weak ones are looked for anew — the page goes there once the files are in the library. */

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
  /** a track of an album keeps the file's picture as its own, over the album's */
  ownCover: boolean;
  title: string;
  artist: string;
  album: string;
  year: string;
}

type Only = 'all' | 'fill' | 'doubt' | 'changes' | 'none' | 'twin';

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const same = (a?: string | null, b?: string | null) => (a ?? '').trim().toLocaleLowerCase('ru') === (b ?? '').trim().toLocaleLowerCase('ru');

function rowFromUpload(u: UploadOut): RowState {
  const found = u.match?.state === 'found';
  return {
    // a recording the library has is left out — unless this file is the better one: then it takes the old one's
    // place. One that only sounds like a track of the library (another version of the song) is a track of its own
    include: !u.twin || u.twin.better || !u.twin.sure,
    replace: !!u.twin?.better,
    catalog: found,
    cover: found && u.match?.cover_url ? 'catalog' : 'file',
    ownCover: false,
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

/** What the catalog's record says otherwise than the file: the fields marked in its line. A name in another case
 * («утром» for «Утром») is no difference — the file's spelling is kept. */
function differences(u: UploadOut) {
  const m = u.match;
  if (!m?.ref) return null;
  const mine = (u.artists ?? []).map((a) => a.toLocaleLowerCase('ru')).join('|');
  const theirs = (m.artists?.length ? m.artists : [m.artist ?? '']).map((a) => a.toLocaleLowerCase('ru')).join('|');
  const album = !same(u.single ? '' : str(u.tags.album), catAlbum(u) ?? '');
  const d = {
    title: !same(u.title, m.title),
    artist: mine !== theirs,
    album,
    no: !!catAlbum(u) && !!m.track_no && String(m.track_no) !== str(u.tags.track_no),
    year: !!m.year && String(m.year) !== str(u.tags.year).slice(0, 4),
  };
  return { ...d, any: d.title || d.artist || d.album || d.no || d.year };
}

/** The album a file goes into, as the page groups by it: the catalog's release when its record is taken, else the
 * file's own album; none — a single. */
function albumOf(u: UploadOut, r: RowState): { key: string; title: string; artist: string; year: string } | null {
  if (usesCatalog(u, r)) {
    const a = catAlbum(u);
    return a ? { key: `c|${a}|${u.match?.album_artist ?? ''}`.toLocaleLowerCase('ru'), title: a, artist: u.match?.album_artist ?? u.match?.artist ?? '', year: u.match?.year ? String(u.match.year) : '' } : null;
  }
  const a = r.album.trim();
  if (!a || same(a, r.title)) return null;
  const by = str(u.tags.album_artist) || u.artists?.[0] || r.artist;
  return { key: `o|${a}|${by}`.toLocaleLowerCase('ru'), title: a, artist: by, year: r.year };
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

/** What is heard on the page: one thing at a time — a file whole, or half a minute of a catalog's record. */
function useListening() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState<string | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = async (key: string, src: () => Promise<string | null>) => {
    const a = (audio.current ??= new Audio());
    if (on === key) {
      a.pause();
      setOn(null);
      return;
    }
    const url = await src();
    if (!url) return;
    a.src = url;
    a.onended = () => setOn(null);
    a.onerror = () => {
      setOn(null);
      toast('Не удалось воспроизвести', 'error');
    };
    setOn(key);
    void a.play().catch(() => setOn(null));
  };
  return { on, play };
}

export function UploadPage() {
  const desktop = useDesktop();
  const pendingRes = useAsync((s) => api.uploads('uploaded', s), []);
  const [uploads, setUploads] = useState<UploadOut[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  /** an album's cover, by the album's key (not said: the catalog's when its files have one, else the files') */
  const [albumCover, setAlbumCover] = useState<Record<string, 'catalog' | 'file'>>({});
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
  const listening = useListening();

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

  const included = uploads.filter((u) => rowOf(u).include);
  const ready = included.filter((u) => valid(u, rowOf(u)));
  const toFill = included.filter((u) => !valid(u, rowOf(u)));
  const isNone = (u: UploadOut) => !u.match?.ref;
  const changes = (u: UploadOut) => usesCatalog(u, rowOf(u)) && !!differences(u)?.any;
  const counts = {
    fill: toFill.length,
    doubt: uploads.filter((u) => u.match?.state === 'doubt').length,
    changes: uploads.filter(changes).length,
    none: uploads.filter(isNone).length,
    twin: uploads.filter((u) => u.twin).length,
  };
  const shown = uploads.filter((u) =>
    only === 'fill' ? rowOf(u).include && !valid(u, rowOf(u)) : only === 'doubt' ? u.match?.state === 'doubt' : only === 'changes' ? changes(u) : only === 'none' ? isNone(u) : only === 'twin' ? !!u.twin : true);

  /** The files shown, by the albums they go into: the albums in the order their first file came, the singles last. */
  const groups = useMemo(() => {
    const albums = new Map<string, { key: string; title: string; artist: string; year: string; files: UploadOut[] }>();
    const singles: UploadOut[] = [];
    for (const u of shown) {
      const a = albumOf(u, rows[u.id] ?? rowFromUpload(u));
      if (!a) singles.push(u);
      else (albums.get(a.key) ?? albums.set(a.key, { ...a, files: [] }).get(a.key)!).files.push(u);
    }
    return { albums: [...albums.values()], singles };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads, rows, only]);

  /** An album's cover: what was said in its head, else the catalog's when a file of it has one. */
  const coverOfAlbum = (g: { key: string; files: UploadOut[] }): 'catalog' | 'file' =>
    albumCover[g.key] ?? (g.files.some((u) => usesCatalog(u, rowOf(u)) && u.match?.cover_url) ? 'catalog' : 'file');
  const fileCoverOf = (g: { files: UploadOut[] }) => g.files.find((u) => u.tags.has_cover);

  const uploadingNow = transfers.some((t) => !t.error);
  const canCommit = ready.length > 0 && !uploadingNow && !moving;

  const trackIn = (u: UploadOut): UploadTrackIn => {
    const r = rowOf(u);
    const a = albumOf(u, r);
    const g = a ? groups.albums.find((x) => x.key === a.key) : undefined;
    const albumPicture = g ? coverOfAlbum(g) : null;
    // in an album: the album's picture, and the file's as the track's own where it was asked for — or where the
    // album takes its files' picture and this file's is another one
    const first = g ? fileCoverOf(g) : undefined;
    const other = !!g && albumPicture === 'file' && !!u.tags.cover_hash && !!first && first.id !== u.id && u.tags.cover_hash !== first.tags.cover_hash;
    return {
      upload_id: u.id, catalog: usesCatalog(u, r), title: r.title.trim(), artist: r.artist.trim(), album: r.album.trim() || null, year: toIntOrNull(r.year),
      replace_track_id: r.replace && u.twin ? u.twin.track_id : null,
      cover: albumPicture ?? r.cover, own_cover: !!g && (other || (r.ownCover && albumPicture !== 'file')),
    };
  };

  /** The files go in by parts, so that the page says how far it has got; what went in leaves the list. The ones
   * that lack a name stay on the page. Then the second step: the weak files among them are looked for anew. */
  const commit = async () => {
    const list = ready;
    const all = groups; // the albums as they stand now: a part's rows are filed by them
    void all;
    let imported = 0;
    let weak = 0;
    const tracks: number[] = [];
    setMoving({ done: 0, of: list.length });
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      const res = await attempt(() => api.commitUploads({ tracks: part.map(trackIn), playlist_ids: playlists.map((p) => p.id), star: like, tag_ids: tagIds, keep_in: keep ? keepName : null }));
      if (!res) break;
      imported += res.imported;
      weak += res.weak;
      tracks.push(...res.track_ids);
      const done = new Set(part.map((u) => u.id));
      setUploads((prev) => prev.filter((u) => !done.has(u.id)));
      setMoving({ done: Math.min(i + CHUNK, list.length), of: list.length });
    }
    setMoving(null);
    if (!imported) return;
    if (weak) {
      const q = await attempt(() => api.qualityStart(tracks));
      toast(`Перенесено: ${tracksWord(imported)}. Слабых файлов: ${weak} — ищу лучше`, 'success');
      if (q && imported === list.length && !toFill.length) navigate('/quality', { replace: true });
      return;
    }
    toast(`Перенесено: ${tracksWord(imported)}`, 'success');
    if (imported === list.length && !toFill.length) navigate('/files', { replace: true });
  };

  const totalSize = included.reduce((n, u) => n + u.size, 0);
  const chips: [Only, string, number, boolean?][] = [
    ['all', 'Все', uploads.length],
    ['fill', 'Нужно заполнить', counts.fill, true],
    ['doubt', 'Проверьте сами', counts.doubt],
    ['changes', 'Изменится', counts.changes],
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

  const row = (u: UploadOut, inAlbum: { key: string; files: UploadOut[] } | null) => (
    <FilePair
      key={u.id}
      u={u}
      r={rowOf(u)}
      desktop={desktop}
      albumCover={inAlbum ? coverOfAlbum(inAlbum) : null}
      otherCover={!!inAlbum && !!u.tags.cover_hash && !!fileCoverOf(inAlbum) && fileCoverOf(inAlbum)!.tags.cover_hash !== u.tags.cover_hash}
      open={open === u.id}
      playing={listening.on}
      onPlay={(which) => void listening.play(`${u.id}:${which}`, async () => (which === 'file' ? `/api/uploads/${u.id}/audio` : ((await attempt(() => api.uploadPreview(u.id)))?.url ?? null)))}
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

          <div className="mx-4 mt-3 overflow-hidden rounded-2xl bg-surface lg:mx-6" role="table" aria-label="Файлы">
            {shown.length === 0 && <Empty icon="search" title="Под эту метку ничего не подходит" />}
            {groups.albums.map((g) => {
              const picture = coverOfAlbum(g);
              const mine = fileCoverOf(g);
              const theirs = g.files.find((u) => usesCatalog(u, rowOf(u)) && u.match?.cover_url)?.match?.cover_url;
              const choose = (v: 'catalog' | 'file') => {
                setAlbumCover((prev) => ({ ...prev, [g.key]: v }));
                setRows((prev) => ({ ...prev, ...Object.fromEntries(g.files.map((u) => [u.id, { ...(prev[u.id] ?? rowFromUpload(u)), ownCover: false }])) }));
              };
              return (
                <div key={g.key}>
                  <div className="flex items-center gap-3 border-b border-line/60 bg-fg/[0.04] px-4 py-2 text-xs text-muted">
                    <span className="min-w-0 truncate">
                      <span className="text-sm font-semibold text-fg">«{g.title}»</span> · {[g.artist, g.year].filter(Boolean).join(' · ')}
                    </span>
                    <span className="shrink-0 tabular-nums text-dim">{g.files.length} {plural(g.files.length, ['файл', 'файла', 'файлов'])}</span>
                    <span className="flex-1" />
                    {mine && theirs && (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="hidden sm:inline">обложка альбома:</span>
                        <Pic src={uploadCoverUrl(mine.id)} on={picture === 'file'} label="Обложка из файлов" size={30} onClick={() => choose('file')} />
                        <Pic src={imageUrl(theirs)} on={picture === 'catalog'} label="Обложка из каталога" size={30} onClick={() => choose('catalog')} />
                      </span>
                    )}
                  </div>
                  {g.files.map((u) => row(u, g))}
                </div>
              );
            })}
            {groups.singles.length > 0 && (
              <>
                {groups.albums.length > 0 && (
                  <div className="border-b border-line/60 bg-fg/[0.04] px-4 py-2 text-xs text-muted">
                    <span className="text-sm font-semibold text-fg">Синглы и треки без альбома</span> · <span className="tabular-nums">{groups.singles.length}</span>
                  </div>
                )}
                {groups.singles.map((u) => row(u, null))}
              </>
            )}
          </div>
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

/** A picture that is chosen by a tap: the chosen one is ringed. */
function Pic({ src, on, label, size = 40, onClick, dim }: { src?: string | null; on: boolean; label: string; size?: number; onClick?: () => void; dim?: boolean }) {
  return (
    <button type="button" disabled={!onClick} aria-pressed={on} aria-label={label} title={label} onClick={onClick} className={cx('shrink-0 rounded-md transition', on ? 'ring-2 ring-accent' : dim ? 'opacity-45 hover:opacity-100' : '', onClick && 'cursor-pointer')}>
      <Cover src={src} size={size} alt="" />
    </button>
  );
}

const LINE = { gridTemplateColumns: '1.25rem 4.5rem 2rem 2.5rem minmax(0,1.3fr) minmax(0,1fr) 3rem' };

/** A file of the list and, under it, the catalog's record of it: the names are taken from one of the two by its
 * dot, the picture by a tap on it, and each is heard by its ▶. A file with nothing to choose — the record says the
 * same, or there is none — takes one line. Open, the file is put right by hand. */
function FilePair({ u, r, desktop, albumCover, otherCover, open, playing, onPlay, onOpen, onChange, onFind, onAgain, onRemove }: { u: UploadOut; r: RowState; desktop: boolean; /** the file goes into an album: the album's picture (null: a single) */ albumCover: 'catalog' | 'file' | null; /** its own picture is not its album's files' */ otherCover: boolean; open: boolean; playing: string | null; onPlay: (which: 'file' | 'catalog') => void; onOpen: () => void; onChange: (patch: Partial<RowState>) => void; onFind: () => void; onAgain: () => void; onRemove: () => void }) {
  const m = u.match;
  const has = !!m?.ref;
  const by = usesCatalog(u, r);
  const d = differences(u);
  const doubt = m?.state === 'doubt';
  const two = has && (doubt || !!d?.any); // there is something to choose between
  const lacks = !by && (!r.title.trim() || !r.artist.trim());
  const mark = (on: boolean | undefined, text: ReactNode) => (on ? <span className="rounded bg-info/20 px-1 text-info">{text}</span> : text);
  const play = (which: 'file' | 'catalog', label: string) => {
    const on = playing === `${u.id}:${which}`;
    return (
      <button type="button" aria-label={on ? 'Пауза' : label} title={on ? 'Пауза' : label} onClick={() => onPlay(which)} className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition hover:scale-105', on ? 'border-accent text-accent' : 'border-line text-fg')}>
        <Icon name={on ? 'pause' : 'play'} size={14} filled className={on ? '' : 'translate-x-px'} />
      </button>
    );
  };
  // whose picture the track gets: a single's own choice; in an album the album's — and the file's as the track's own
  const picture: 'catalog' | 'file' = albumCover ? (r.ownCover ? 'file' : albumCover) : r.cover;
  const mine = u.tags.has_cover ? uploadCoverUrl(u.id) : null;
  const theirs = m?.cover_url ? imageUrl(m.cover_url) : null;
  const pickFile = albumCover ? (albumCover === 'file' ? undefined : () => onChange({ ownCover: !r.ownCover })) : () => onChange({ cover: 'file' });
  const pickCat = albumCover ? (r.ownCover ? () => onChange({ ownCover: false }) : undefined) : () => onChange({ cover: 'catalog' });
  const ownAlbum = u.single ? 'без альбома' : `«${str(u.tags.album)}»`;
  const fileLine = (
    <>
      <span className="min-w-0">
        {lacks ? (
          <span className="flex flex-col gap-1.5 py-0.5 md:flex-row">
            <input className={cx('input !h-8 !py-1 text-sm', !r.title.trim() && '!border-danger')} placeholder="Название" aria-label="Название" value={r.title} onChange={(e) => onChange({ title: e.target.value })} />
            <input className={cx('input !h-8 !py-1 text-sm', !r.artist.trim() && '!border-danger')} placeholder="Исполнитель" aria-label="Исполнитель" value={r.artist} onChange={(e) => onChange({ artist: e.target.value })} />
          </span>
        ) : (
          <>
            <span className="block truncate text-[15px]">{by ? u.title : r.title}</span>
            <span className="block truncate text-[13px] text-muted">{by ? u.artist || 'исполнитель не указан' : r.artist}</span>
          </>
        )}
      </span>
      <span className="hidden min-w-0 truncate text-[13px] text-muted md:block">
        {by || two ? [ownAlbum, str(u.tags.year).slice(0, 4) || null].filter(Boolean).join(' · ') : [r.album.trim() && !same(r.album, r.title) ? `«${r.album.trim()}»` : u.single ? 'без альбома → сингл' : 'сингл', r.year].filter(Boolean).join(' · ')}
      </span>
      <span className="text-right text-xs tabular-nums text-dim">{fmtDuration(u.duration_s)}</span>
    </>
  );
  const catLine = has && (
    <>
      <span className="min-w-0">
        <span className="block truncate text-[15px]">{mark(d?.title, m?.title)}</span>
        <span className="block truncate text-[13px] text-muted">{mark(d?.artist, (m?.artists?.length ? m.artists : [m?.artist]).filter(Boolean).join(' · '))}</span>
      </span>
      <span className="hidden min-w-0 truncate text-[13px] text-muted md:block">
        {mark(d?.album, catAlbum(u) ? `«${catAlbum(u)}»` : 'сингл')}
        {catAlbum(u) && m?.track_no ? <> · {mark(d?.no, `№ ${m.track_no}`)}</> : null}
        {m?.year ? <> · {mark(d?.year, m.year)}</> : null}
      </span>
      <span className={cx('text-right text-xs tabular-nums', doubt && m?.duration_s && u.duration_s && Math.abs(m.duration_s - u.duration_s) > 5 ? 'text-warn' : 'text-dim')}>{fmtDuration(m?.duration_s)}</span>
    </>
  );
  const dot = (on: boolean, label: string, set: () => void) => (
    <input type="radio" className="h-4 w-4 accent-(--color-accent)" checked={on} aria-label={label} onChange={set} />
  );
  const line = (first: ReactNode, label: ReactNode, button: ReactNode, pic: ReactNode, body: ReactNode, off: boolean) => (
    <div className={cx('grid items-center gap-2.5 py-1', off && 'opacity-55')} style={desktop ? LINE : { gridTemplateColumns: '1.25rem 2rem 2.5rem minmax(0,1fr) 2.75rem' }}>
      {first}
      {desktop && <span className="truncate text-[11px] text-dim">{label}</span>}
      {button}
      {pic}
      {body}
    </div>
  );
  return (
    <div role="row" className={cx('border-b border-line/60 last:border-0', !r.include && 'opacity-60')}>
      <div className="grid items-center py-1.5 pr-1" style={{ gridTemplateColumns: '2.75rem minmax(0,1fr) 2.5rem' }}>
        <Checkbox checked={r.include} onChange={(v) => onChange({ include: v })} label={`Переносить «${u.title}»`} />
        <div className="min-w-0">
          {line(
            two ? dot(!by, 'Взять данные из файла', () => onChange({ catalog: false })) : <span />,
            'Ваш файл',
            play('file', 'Слушать файл'),
            <Pic src={mine} on={picture === 'file' && (two || !!theirs)} dim={picture !== 'file'} label={albumCover && albumCover !== 'file' ? 'Оставить эту обложку этому треку' : 'Обложка из файла'} onClick={mine && theirs ? pickFile : undefined} />,
            fileLine,
            two && by,
          )}
          {two &&
            line(
              dot(by, 'Взять данные из каталога', () => onChange({ catalog: true })),
              <span className={doubt ? 'text-warn' : undefined}>{doubt ? 'Похожая' : 'Каталог'}</span>,
              play('catalog', 'Слушать 30 секунд записи из каталога'),
              <Pic src={theirs} on={picture === 'catalog'} dim={picture !== 'catalog'} label="Обложка из каталога" onClick={theirs && mine ? pickCat : undefined} />,
              catLine,
              !by,
            )}
          <div className="space-y-1 pb-0.5 pl-[1.9rem] text-[11px] text-dim md:pl-[7.2rem]">
            {doubt && <div className="text-warn">Проверьте сами: {m?.why}. Без вашего выбора файл уйдёт со своими тегами.</div>}
            {has && !two && (
              <div className="flex flex-wrap items-center gap-2">
                <span>найден в каталоге · {by ? 'всё совпадает' : 'данные каталога отключены'}</span>
                {theirs && mine && (
                  <span className="flex items-center gap-1.5">
                    обложка:
                    <Pic src={theirs} on={picture === 'catalog'} dim={picture !== 'catalog'} size={24} label="Обложка из каталога" onClick={pickCat} />
                    <span>{picture === 'catalog' ? 'из каталога' : 'ваша'}</span>
                  </span>
                )}
              </div>
            )}
            {!has && (
              <div>
                в каталоге не найден{m?.why ? ` (${m.why})` : ''} ·{' '}
                <button type="button" className="text-info hover:underline" onClick={onFind}>
                  найти вручную
                </button>
              </div>
            )}
            {albumCover && otherCover && albumCover === 'file' && <div>в файле своя обложка, не как у альбома — она останется у этого трека</div>}
            {albumCover && r.ownCover && albumCover !== 'file' && <div>у этого трека останется обложка из файла, поверх альбомной</div>}
            {u.twin && <TwinNote u={u} r={r} onChange={onChange} />}
          </div>
        </div>
        <IconButton icon={open ? 'down' : 'edit'} size={17} label={open ? 'Свернуть' : 'Изменить'} aria-expanded={open} onClick={onOpen} className="self-start text-dim hover:text-fg" />
      </div>
      {open && (
        <div className="space-y-3 border-t border-line/60 bg-fg/[0.03] px-4 py-3 md:pl-[3.5rem]">
          {by ? (
            <p className="text-sm text-muted">Название, исполнители, альбом и год берутся из каталога{m?.by_hand ? ' — запись выбрана вручную' : ''}.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-[2fr_2fr_2fr_5rem]">
              <Field label="Название">
                <input className="input" value={r.title} onChange={(e) => onChange({ title: e.target.value })} />
              </Field>
              <Field label="Исполнители (через запятую)">
                <input className="input" value={r.artist} onChange={(e) => onChange({ artist: e.target.value })} />
              </Field>
              <Field label="Альбом">
                <input className="input" value={r.album} placeholder="Пусто — сингл" onChange={(e) => onChange({ album: e.target.value })} />
              </Field>
              <Field label="Год">
                <input className="input" inputMode="numeric" value={r.year} onChange={(e) => onChange({ year: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
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
