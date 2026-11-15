import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/** «Загрузить файлы»: one's own audio files into the library. Files — or a folder, with what is inside its folders —
 * are dropped anywhere on the page or picked. The Hub reads each file and looks for the song it is in the catalog
 * (`library/recognize.py`): a row shows the file as it says of itself and, beside it, what it becomes in the
 * library. A file found in the catalog is filed as that song — its artists one by one, its real release, year and
 * cover; one the catalog only has something like («Проверьте сами») keeps its own names until the listener says the
 * record is it; one the catalog does not know keeps its own, and an «album» that is no album (nothing, «Single»,
 * the track's own name) makes it a single. A recording the library has already says so and is left out. The marks
 * under the bar sort the rows out; a row opens to be put right by hand. */

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
  title: string;
  artist: string;
  album: string;
  year: string;
}

type Only = 'all' | 'doubt' | 'none' | 'twin' | 'weak';

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function rowFromUpload(u: UploadOut): RowState {
  return {
    // a recording the library has is left out — unless this file is the better one: then it takes the old one's
    // place. One that only sounds like a track of the library (another version of the song) is a track of its own
    include: !u.twin || u.twin.better || !u.twin.sure,
    replace: !!u.twin?.better,
    catalog: u.match?.state === 'found',
    title: u.title,
    artist: u.artist,
    album: u.single ? '' : str(u.tags.album),
    year: str(u.tags.year).slice(0, 4),
  };
}

const fileWords = (codec?: string | null, kbps?: number | null) => [codec ? codec.toUpperCase() : null, kbps ? String(kbps) : null].filter(Boolean).join(' ');
const kindWord = (type?: string | null, album?: string | null) => (type === 'single' || !album ? 'сингл' : type === 'ep' ? `EP «${album}»` : `«${album}»`);

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

export function UploadPage() {
  const desktop = useDesktop();
  const pendingRes = useAsync((s) => api.uploads('uploaded', s), []);
  const [uploads, setUploads] = useState<UploadOut[]>([]);
  const [rows, setRows] = useState<Record<number, RowState>>({});
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
  // a weak file filed as a song of the catalog is looked for anew once it is in: the same recording in a better
  // file takes its place (the Hub: library/upgrade.py)
  const [upgrade, setUpgrade] = useState(true);

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

  const removeUpload = async (u: UploadOut) => {
    const ok = await confirmDialog({ title: 'Убрать файл?', body: u.orig_name, okLabel: 'Убрать', danger: true });
    if (!ok) return;
    if (await attempt(() => api.deleteUpload(u.id))) setUploads((prev) => prev.filter((x) => x.id !== u.id));
  };

  /** The files left unchecked — what the library has already, as a rule — go off the server in one go. */
  const removeLeftOut = async () => {
    const out = uploads.filter((u) => !rows[u.id]?.include);
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
    setRow(u.id, { catalog: ref ? true : next.match?.state === 'found' });
  };

  const included = uploads.filter((u) => rows[u.id]?.include);
  const usesCatalog = (u: UploadOut) => !!rows[u.id]?.catalog && !!u.match?.ref;
  const invalid = included.filter((u) => !usesCatalog(u) && (!rows[u.id].title.trim() || !rows[u.id].artist.trim()));
  const counts = useMemo(() => ({
    doubt: uploads.filter((u) => u.match?.state === 'doubt').length,
    none: uploads.filter((u) => !u.match || u.match.state === 'none').length,
    twin: uploads.filter((u) => u.twin).length,
    weak: uploads.filter((u) => u.weak).length,
  }), [uploads]);
  const shown = uploads.filter((u) => (only === 'doubt' ? u.match?.state === 'doubt' : only === 'none' ? !u.match || u.match.state === 'none' : only === 'twin' ? !!u.twin : only === 'weak' ? !!u.weak : true));

  const uploadingNow = transfers.some((t) => !t.error);
  const canCommit = included.length > 0 && invalid.length === 0 && !uploadingNow && !moving;

  const trackIn = (u: UploadOut): UploadTrackIn => {
    const r = rows[u.id];
    return { upload_id: u.id, catalog: usesCatalog(u), title: r.title.trim(), artist: r.artist.trim(), album: r.album.trim() || null, year: toIntOrNull(r.year), replace_track_id: r.replace && u.twin ? u.twin.track_id : null };
  };

  /** The files go in by parts, so that the page says how far it has got; what went in leaves the list. */
  const commit = async () => {
    const list = included;
    let imported = 0;
    let upgrading = 0;
    setMoving({ done: 0, of: list.length });
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      const res = await attempt(() => api.commitUploads({ tracks: part.map(trackIn), playlist_ids: playlists.map((p) => p.id), star: like, tag_ids: tagIds, keep_in: keep ? keepName : null, upgrade }));
      if (!res) break;
      imported += res.imported;
      upgrading += res.upgrading;
      const done = new Set(part.map((u) => u.id));
      setUploads((prev) => prev.filter((u) => !done.has(u.id)));
      setMoving({ done: Math.min(i + CHUNK, list.length), of: list.length });
    }
    setMoving(null);
    if (!imported) return;
    toast(`Перенесено: ${tracksWord(imported)}` + (upgrading ? `. Ищу лучшее качество для ${upgrading} — в фоне` : ''), 'success');
    if (imported === list.length) navigate('/files', { replace: true });
  };

  const totalSize = included.reduce((n, u) => n + u.size, 0);
  const toUpgrade = included.filter((u) => u.weak && usesCatalog(u)).length;
  const allOn = shown.length > 0 && shown.every((u) => rows[u.id]?.include);
  const chips: [Only, string, number | null][] = [
    ['all', 'Все', uploads.length],
    ['doubt', 'Проверьте сами', counts.doubt],
    ['none', 'Не найдено', counts.none],
    ['twin', 'Уже есть', counts.twin],
    ['weak', 'Слабый файл', counts.weak],
  ];

  const importButton = uploads.length > 0 && (
    <Button variant="primary" small icon="check" busy={!!moving} disabled={!canCommit} onClick={commit}>
      {moving ? `Переношу ${moving.done} из ${moving.of}` : `Перенести${included.length ? ` ${tracksWord(included.length)}` : ''}`}
    </Button>
  );

  const pick = (label: string, ref: React.RefObject<HTMLInputElement | null>) => (
    <Button small onClick={() => ref.current?.click()}>
      {label}
    </Button>
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
          count={included.length}
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
              {chips.filter(([id, , n]) => id === 'all' || id === only || (n ?? 0) > 0).map(([id, label, n]) => (
                <button key={id} type="button" aria-pressed={only === id} onClick={() => setOnly(only === id ? 'all' : id)} className={cx('shrink-0 rounded-full px-3 py-1.5 text-sm transition', only === id ? 'bg-fg font-semibold text-bg' : 'bg-fg/10 text-muted hover:text-fg')}>
                  {label}
                  <span className={cx('pl-1.5 tabular-nums', only === id ? 'opacity-70' : 'text-dim')}>{n}</span>
                </button>
              ))}
            </div>
            {included.length < uploads.length && (
              <Button small icon="trash" onClick={removeLeftOut}>
                Убрать невыбранные · {uploads.length - included.length}
              </Button>
            )}
          </div>
          {toUpgrade > 0 && (
            <label className="flex cursor-pointer items-start gap-2 px-4 pt-3 text-sm lg:px-6">
              <input type="checkbox" className="mt-0.5 accent-(--color-accent)" checked={upgrade} onChange={(e) => setUpgrade(e.target.checked)} />
              <span>
                После переноса поискать лучшее качество для слабых файлов · {toUpgrade}
                <span className="block text-xs text-muted">В фоне, через обычные источники. Файл заменится, только если найдётся та же запись (сверка по звуку) в лучшем качестве; иначе останется ваш.</span>
              </span>
            </label>
          )}
          {invalid.length > 0 && <p className="px-4 pt-2 text-xs text-danger lg:px-6">У {tracksWord(invalid.length)} не хватает названия или исполнителя — откройте строку и впишите.</p>}

          <div className="mx-4 mt-3 overflow-hidden rounded-2xl bg-surface lg:mx-6" role="table" aria-label="Файлы">
            {desktop && (
              <div role="row" className="grid h-9 items-center gap-3 border-b border-line/60 pl-1 pr-2 text-xs text-dim" style={GRID}>
                <Checkbox checked={allOn} onChange={(v) => setRows((prev) => ({ ...prev, ...Object.fromEntries(shown.map((u) => [u.id, { ...prev[u.id], include: v }])) }))} label="Выбрать все показанные" />
                <span />
                <span>В файле</span>
                <span />
                <span>Станет в библиотеке</span>
                <span>Файл</span>
                <span />
              </div>
            )}
            {shown.length === 0 && <Empty icon="search" title="Под эту метку ничего не подходит" />}
            {shown.map((u) => (
              <FileRow
                key={u.id}
                u={u}
                r={rows[u.id] ?? rowFromUpload(u)}
                desktop={desktop}
                open={open === u.id}
                onOpen={() => setOpen(open === u.id ? null : u.id)}
                onChange={(patch) => setRow(u.id, patch)}
                onFind={() => setFinding(u)}
                onAgain={() => void rematch(u)}
                onRemove={() => void removeUpload(u)}
              />
            ))}
          </div>
        </>
      )}

      {plPicker && (
        <PlaylistsPick
          title={`${tracksWord(included.length)} — в плейлисты`}
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

const GRID = { gridTemplateColumns: '2.75rem 2.5rem minmax(0,1fr) 1rem minmax(0,1fr) 8.5rem 2.5rem' };

/** A file of the list: what it says of itself, what it becomes in the library, and what the file is. Open, it is
 * put right: the record of the catalog taken or left, another one picked, or the file's own names written. */
function FileRow({ u, r, desktop, open, onOpen, onChange, onFind, onAgain, onRemove }: { u: UploadOut; r: RowState; desktop: boolean; open: boolean; onOpen: () => void; onChange: (patch: Partial<RowState>) => void; onFind: () => void; onAgain: () => void; onRemove: () => void }) {
  const m = u.match;
  const has = !!m?.ref;
  const by = r.catalog && has;
  const own = `${u.artist || 'исполнитель не указан'} · ${u.single ? 'без альбома' : `«${str(u.tags.album)}»`}`;
  const cover = by && m?.cover_url ? imageUrl(m.cover_url) : u.tags.has_cover ? uploadCoverUrl(u.id) : null;
  const bad = !by && (!r.title.trim() || !r.artist.trim());
  const becomes = by ? (
    <>
      <span className="block truncate text-[15px]">{m?.title}</span>
      <span className="block truncate text-[13px] text-muted">{[(m?.artists?.length ? m.artists : [m?.artist]).filter(Boolean).join(' · '), kindWord(m?.record_type, m?.album), m?.year].filter(Boolean).join(' · ')}</span>
    </>
  ) : (
    <>
      <span className={cx('block truncate text-[15px]', bad && 'text-danger')}>{r.title || 'нет названия'}</span>
      <span className="block truncate text-[13px] text-muted">{[r.artist || 'нет исполнителя', r.album.trim() ? `«${r.album.trim()}»` : 'сингл', r.year].filter(Boolean).join(' · ')}</span>
    </>
  );
  // what the catalog said, under the row: a doubt with its reason, or that there is nothing — the names are the file's
  const note =
    m?.state === 'doubt' ? (
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-warn">
        <span className="min-w-0 truncate">
          В каталоге похожая: «{m.title}» — {m.artist}, {fmtDuration(m.duration_s)} · {m.why}
        </span>
        <button type="button" aria-pressed={by} onClick={() => onChange({ catalog: true })} className={cx('rounded-full px-2 py-0.5 transition', by ? 'bg-warn/20 font-semibold' : 'bg-fg/5 text-muted hover:text-fg')}>
          это она
        </button>
        <button type="button" aria-pressed={!by} onClick={() => onChange({ catalog: false })} className={cx('rounded-full px-2 py-0.5 transition', !by ? 'bg-warn/20 font-semibold' : 'bg-fg/5 text-muted hover:text-fg')}>
          нет, оставить мои теги
        </button>
      </div>
    ) : !has ? (
      <div className="text-[11px] text-dim">Не найдено в каталоге — теги и обложка остаются из файла{m?.why ? ` (${m.why})` : ''}</div>
    ) : !by ? (
      <div className="text-[11px] text-dim">Данные каталога отключены — теги и обложка остаются из файла</div>
    ) : null;
  const file = (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]', u.weak ? 'bg-warn/15 text-warn' : 'bg-fg/5 text-muted')} title={u.weak ? 'Низкое качество: такой файл слышно' : undefined}>
      {fileWords(u.codec, u.bitrate_kbps) || '—'}
      {u.weak ? ' · слабый' : ''}
    </span>
  );
  const picture = <Cover src={cover} size={40} alt="" />;
  const notes = (note || u.twin) && (
    <div className="space-y-1">
      {note}
      {u.twin && <TwinNote u={u} r={r} onChange={onChange} />}
    </div>
  );
  return (
    <div role="row" className={cx('border-b border-line/60 last:border-0', !r.include && 'opacity-60')}>
      {desktop ? (
        <>
          <div className="grid min-h-14 items-center gap-3 py-1.5 pl-1 pr-2" style={GRID}>
            <Checkbox checked={r.include} onChange={(v) => onChange({ include: v })} label={`Переносить «${u.title}»`} />
            {picture}
            <span className="min-w-0" title={u.orig_name}>
              <span className="block truncate text-[15px]">{u.title}</span>
              <span className="block truncate text-[13px] text-muted">{own}</span>
            </span>
            <Icon name="chevron" size={14} className="text-dim" />
            <span className="min-w-0">{becomes}</span>
            <span>{file}</span>
            <IconButton icon={open ? 'down' : 'edit'} size={17} label={open ? 'Свернуть' : 'Изменить'} aria-expanded={open} onClick={onOpen} className="text-dim hover:text-fg" />
          </div>
          {notes && <div className="pb-2 pl-[6.75rem] pr-4">{notes}</div>}
        </>
      ) : (
        <div className="flex items-start gap-3 py-2 pl-1 pr-1">
          <Checkbox checked={r.include} onChange={(v) => onChange({ include: v })} label={`Переносить «${u.title}»`} />
          {picture}
          <div className="min-w-0 flex-1 space-y-1">
            {becomes}
            <div className="truncate text-[11px] text-dim">в файле: {u.title} · {own}</div>
            <div>{file}</div>
            {notes}
          </div>
          <IconButton icon={open ? 'down' : 'edit'} size={17} label={open ? 'Свернуть' : 'Изменить'} aria-expanded={open} onClick={onOpen} className="text-dim" />
        </div>
      )}
      {open && (
        <div className="space-y-3 border-t border-line/60 bg-fg/[0.03] px-4 py-3 md:pl-[6.75rem]">
          {by ? (
            <p className="text-sm text-muted">
              Название, исполнители, альбом, год и обложка берутся из каталога{m?.by_hand ? ' — запись выбрана вручную' : ''}.
            </p>
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
            {has && (
              <Button small onClick={() => onChange({ catalog: !by })}>
                {by ? 'Не из каталога — оставить мои теги' : 'Взять данные каталога'}
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
            {u.orig_name} · {fmtSize(u.size)} · {fmtDuration(u.duration_s)}
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
