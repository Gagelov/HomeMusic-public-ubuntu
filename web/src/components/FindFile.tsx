import { useEffect, useRef, useState } from 'react';
import { api, listenStreamUrl } from '../api/client';
import type { Candidate, PickOut } from '../api/types';
import { closeFindFile, useFindFile, type FileSought } from '../lib/findFile';
import { fmtDuration, providerLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { navigate } from '../lib/router';
import { EDITED_EVENT } from '../lib/trackEdit';
import { attempt, confirmDialog, toast } from '../lib/ui';
import { fileRef } from './candidate';
import { Icon } from './Icon';
import { Button, Cover, IconButton, Sheet, Spinner, cx } from './ui';

/** «Найти другой файл»: another file for a track the library has — one without the censor's cuts, a better copy.
 * Over the list stands the file the track plays from now; under it the files the sources have of the song (the
 * regular sources first, then the re-uploads by small channels, where the uncensored copies are) — each heard
 * before it is taken. A file that was heard, or is being taken, is weighed against the track's own by its sound:
 * the same recording, one only alike, or another. The choice is the listener's: a file that is another recording
 * is taken too, once they say so — that is how a version is picked on purpose. The old file goes to the trash for
 * thirty days, and the two can be heard side by side on «Качество звука». */
export function FindFile() {
  const sought = useFindFile();
  return sought ? <Window key={sought.library_track_id} track={sought} /> : null;
}

const fileWords = (codec?: string | null, kbps?: number | null) => [codec ? codec.toUpperCase() : null, kbps ? String(kbps) : null].filter(Boolean).join(' ') || '—';
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const CLEAN = /(без мата|цензур|clean|radio edit|радио верси)/i;
const UNCENSORED = /(без цензур|uncensored|explicit|нецензур)/i;

function Window({ track }: { track: FileSought }) {
  const id = track.library_track_id;
  const mine = useAsync((s) => api.trackFile(id, s), [id]);
  const q = `${track.artist.split(',')[0].trim()} - ${track.title}`;
  const sources = useAsync((s) => api.searchProviders(q, s, 'sources'), [q]);
  const reuploads = useAsync((s) => api.searchProviders(q, s, 'reuploads'), [q]);
  const [weighed, setWeighed] = useState<Record<string, PickOut | 'busy'>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState<{ key: string; at: number } | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  const play = (key: string, src: string) => {
    const a = (audio.current ??= new Audio());
    if (on?.key === key) {
      a.pause();
      setOn(null);
      return;
    }
    a.src = src;
    a.ontimeupdate = () => setOn((cur) => (cur ? { ...cur, at: a.duration ? a.currentTime / a.duration : 0 } : cur));
    a.onended = () => setOn(null);
    a.onerror = () => {
      setOn(null);
      toast('Не удалось воспроизвести', 'error');
    };
    setOn({ key, at: 0 });
    void a.play().catch(() => setOn(null));
  };
  /** How the file compares with the track's own — asked once, when it is first heard or taken. */
  const weigh = async (ref: string): Promise<PickOut | null> => {
    const have = weighed[ref];
    if (have && have !== 'busy') return have;
    setWeighed((prev) => ({ ...prev, [ref]: 'busy' }));
    try {
      const r = await api.fileWeigh(id, { ref });
      setWeighed((prev) => ({ ...prev, [ref]: r }));
      return r;
    } catch {
      setWeighed((prev) => {
        const next = { ...prev };
        delete next[ref];
        return next;
      });
      return null;
    }
  };
  const done = () => {
    audio.current?.pause();
    window.dispatchEvent(new Event(EDITED_EVENT));
    closeFindFile();
    toast('Файл заменён. Прежний хранится 30 дней', 'success', { label: 'Сравнить', to: '/quality' });
  };
  const take = async (pick: { ref: string } | { url: string }, key: string) => {
    setBusy(key);
    const w = 'ref' in pick ? await weigh(pick.ref) : await attempt(() => api.fileWeigh(id, pick));
    if (!w) {
      setBusy(null);
      if ('ref' in pick) toast('Источник не отдал файл', 'error');
      return;
    }
    const gaps = w.verdict === 'same' ? (w.gaps ?? []) : [];
    if (gaps.length > 0) {
      const quiet = gaps.filter((g) => g.quieter === 'other').length;
      const ok = await confirmDialog({
        title: 'Файлы расходятся местами',
        body: `Запись та же, но отличается на ${gaps.map((g) => clock(g.at)).join(', ')}. Так выглядит вырезанное или запиканное слово` + (quiet ? ' — и там тише именно найденный файл' : '') + '. Заменить всё равно? Сравнить и вернуть прежний можно будет в «Качество звука».',
        okLabel: 'Заменить',
      });
      if (!ok) {
        setBusy(null);
        return;
      }
    }
    if (w.verdict !== 'same') {
      const ok = await confirmDialog({
        title: w.verdict === 'other' ? 'Это другая запись' : w.verdict === 'alike' ? 'Запись только похожа' : 'Не удалось сравнить по звуку',
        body: (w.likeness != null ? `Сходство с вашим файлом по звуку: ${w.likeness.toFixed(2)}. ` : '') + 'Так бывает у ремикса, живой записи, другой версии — или у копии с вырезанными словами. Всё равно поставить этот файл вместо вашего?',
        okLabel: 'Заменить',
      });
      if (!ok) {
        setBusy(null);
        return;
      }
    }
    const r = await attempt(() => api.fileTake(id, { ...pick, sure: true }));
    setBusy(null);
    if (r?.taken) done();
  };

  const seen = new Set<string>();
  const list = [...(sources.data?.candidates ?? []), ...(reuploads.data?.candidates ?? [])].filter((c) => {
    const k = fileRef(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const loading = sources.loading || reuploads.loading;
  const m = mine.data;
  const playButton = (key: string, src: string, label: string, after?: () => void) => {
    const playing = on?.key === key;
    return (
      <button
        type="button"
        aria-label={playing ? 'Пауза' : label}
        onClick={() => {
          play(key, src);
          if (!playing) after?.();
        }}
        className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition hover:scale-105', playing ? 'border-accent text-accent' : 'border-line text-fg')}
      >
        <Icon name={playing ? 'pause' : 'play'} size={14} filled className={playing ? '' : 'translate-x-px'} />
      </button>
    );
  };
  const row = (c: Candidate) => {
    const ref = fileRef(c);
    const w = weighed[ref];
    const told = w && w !== 'busy' ? w : null;
    const name = [c.artist, c.title].filter(Boolean).join(' — ') || c.title;
    const reup = !!(c.extra as { reupload?: boolean } | undefined)?.reupload;
    const far = !!(m?.duration_s && c.duration_s && Math.abs(m.duration_s - c.duration_s) > 5);
    const kbps = told?.bitrate_kbps ?? c.bitrate_kbps;
    const better = told ? told.better : !!(kbps && m?.bitrate_kbps && kbps >= m.bitrate_kbps + 48);
    return (
      <li key={ref} className="flex items-center gap-3 border-b border-line/60 py-2 last:border-0">
        {playButton(ref, listenStreamUrl(ref), `Слушать: ${name}`, () => void weigh(ref))}
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-sm', on?.key === ref && 'text-accent')}>{name}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-dim">
            <span>{providerLabel(c.provider)}{reup ? ' · перезалив' : ''}</span>
            <span className="tabular-nums">· {fmtDuration(told?.duration_s ?? c.duration_s)}</span>
            {(c.explicit || UNCENSORED.test(name)) && <span className="rounded-full bg-info/20 px-1.5 text-info">без цензуры</span>}
            {CLEAN.test(name) && !UNCENSORED.test(name) && <span className="text-warn">возможно, цензурная версия</span>}
            {far && <span className="text-warn">другая длительность</span>}
            {w === 'busy' && <span className="flex items-center gap-1"><Spinner size={10} /> сравниваю по звуку…</span>}
            {told && told.likeness != null && (
              <span className={told.verdict === 'same' ? 'text-accent' : told.verdict === 'alike' ? 'text-warn' : 'text-danger'}>
                {told.verdict === 'same' ? 'та же запись' : told.verdict === 'alike' ? 'похожа' : 'другая запись'} · {told.likeness.toFixed(2)}
              </span>
            )}
            {told && (told.gaps?.length ?? 0) > 0 && (
              <span className="text-danger" title="Так выглядит вырезанное или запиканное слово">
                расходится с вашим: {(told.gaps ?? []).map((g) => `${clock(g.at)}${g.quieter === 'other' ? ' (тут тише)' : g.quieter === 'mine' ? ' (у вас тише)' : ''}`).join(', ')}
              </span>
            )}
          </span>
          {on?.key === ref && <span className="mt-1 block h-0.5 rounded bg-fg/10"><span className="block h-0.5 rounded bg-accent" style={{ width: `${Math.round((on.at ?? 0) * 100)}%` }} /></span>}
        </span>
        <span className={cx('shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]', better ? 'bg-accent/15 text-accent' : 'bg-fg/5 text-muted')}>{fileWords(told?.codec, kbps)}</span>
        <Button small busy={busy === ref} disabled={!!busy && busy !== ref} onClick={() => void take({ ref }, ref)}>
          Заменить
        </Button>
      </li>
    );
  };

  return (
    <Sheet open onClose={() => { audio.current?.pause(); closeFindFile(); }} title="Найти другой файл">
      <div className="flex items-center gap-3 pb-3">
        <Cover src={m?.cover_url} size={44} alt="" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{track.title}</span>
          <span className="block truncate text-sm text-muted">{track.artist}{m?.duration_s ? ` · ${fmtDuration(m.duration_s)}` : ''}</span>
        </span>
      </div>

      <p className="pb-1 text-xs text-dim">Сейчас у трека</p>
      <div className="flex items-center gap-3 rounded-xl bg-fg/5 px-3 py-2">
        {playButton('mine', `/api/quality/track/${id}/audio`, 'Слушать текущий файл')}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{m?.name ?? '…'}</span>
          <span className="block truncate text-[11px] text-dim">{m?.source ? providerLabel(m.source) : ''}</span>
          {on?.key === 'mine' && <span className="mt-1 block h-0.5 rounded bg-fg/10"><span className="block h-0.5 rounded bg-accent" style={{ width: `${Math.round((on.at ?? 0) * 100)}%` }} /></span>}
        </span>
        <span className="shrink-0 whitespace-nowrap rounded-full bg-fg/10 px-2 py-0.5 text-[11px] text-muted">{fileWords(m?.codec, m?.bitrate_kbps)}</span>
      </div>

      <div className="flex items-center gap-2 pb-1 pt-4 text-xs text-dim">
        <span className="flex-1">
          Найдено в источниках{list.length ? ` · ${list.length}` : ''}
          {loading && ' · ищу…'}
        </span>
        <IconButton icon="refresh" size={15} label="Искать заново" onClick={() => { sources.reload(); reuploads.reload(); }} className="!h-7 !w-7 text-dim hover:text-fg" />
      </div>
      {list.length === 0 ? (
        loading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <p className="py-6 text-center text-sm text-muted">Источники ничего не нашли. Вставьте ссылку ниже или откройте <button type="button" className="text-info hover:underline" onClick={() => { closeFindFile(); navigate(`/search?q=${encodeURIComponent(q)}&tab=files`); }}>поиск по файлам</button>.</p>
        )
      ) : (
        <ul>{list.map(row)}</ul>
      )}

      <div className="mt-3 border-t border-line/60 pt-3">
        <p className="pb-1.5 text-xs text-muted">Нет нужного? Вставьте ссылку на страницу трека: YouTube, SoundCloud, hitmoz, hitmos.fm</p>
        <div className="flex gap-2">
          <input className="input min-w-0 flex-1" placeholder="https://www.youtube.com/watch?v=…" aria-label="Ссылка на трек" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button small busy={busy === 'url'} disabled={!url.trim() || (!!busy && busy !== 'url')} onClick={() => void take({ url: url.trim() }, 'url')}>
            Скачать и заменить
          </Button>
        </div>
        <p className="pt-2 text-[11px] text-dim">Прежний файл уйдёт в корзину на 30 дней. Сравнить его с новым и вернуть можно в «Качество звука» → «Заменено».</p>
      </div>
    </Sheet>
  );
}
