import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { Candidate, FileGap, PickOut } from '../api/types';
import { useDesktop } from '../lib/desktop';
import { closeFindFile, useFindFile, type FileSought } from '../lib/findFile';
import { fmtDuration, providerLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import { EDITED_EVENT } from '../lib/trackEdit';
import { attempt, confirmDialog, toast } from '../lib/ui';
import { BrandIcon } from './BrandIcon';
import { fileRef } from './candidate';
import { Icon } from './Icon';
import { Button, Cover, IconButton, Spinner, cx } from './ui';

/** «Найти другой файл»: another file for a track the library has — one without the censor's cuts, a better copy.
 *
 * Over the list stands the file the track plays from now, with the lane of its loudness to move through it by. Under
 * it are the files the sources have of the song (the regular sources first, then the re-uploads by small channels,
 * where the uncensored copies are), as the rows of a playlist: the cover that plays the file, its name and artists
 * as its source says them, the source with its mark, its length, what the file is. A row that is played opens: the
 * Hub downloads the file, says how it sounds beside the track's own — the same recording, one only alike, another —
 * and lays the two lanes one over the other, with the places where the two part in red: that is what a cut or a
 * bleeped word shows as, and each such place is heard in either file by a tap. A link of one's own is weighed the
 * same way before anything is replaced.
 *
 * The choice is the listener's: a file that is another recording is taken too, once they say so — that is how a
 * version is picked on purpose. The old file goes to the trash for thirty days, and the two can be heard side by
 * side again on «Качество звука». */
export function FindFile() {
  const sought = useFindFile();
  return sought ? <Window key={sought.library_track_id} track={sought} /> : null;
}

const fileWords = (codec?: string | null, kbps?: number | null) => [codec ? codec.toUpperCase() : null, kbps ? String(kbps) : null].filter(Boolean).join(' ') || '—';
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const CLEAN = /(без мата|цензур|clean|radio edit|радио верси)/i;
const UNCENSORED = /(без цензур|uncensored|explicit|нецензур)/i;
const BRAND: Record<string, string> = { ytdlp: 'youtube', soundcloud: 'soundcloud', hitmoz: 'hitmos', hitmos_fm: 'hitmos' };

/** A file of the list: one the sources gave, or one the listener gave the page of. */
interface Row {
  key: string;
  pick: { ref: string } | { url: string };
  title: string;
  artist: string;
  provider: string;
  duration_s?: number | null;
  bitrate_kbps?: number | null;
  explicit?: boolean | null;
  reupload: boolean;
}

/** What is heard in the window, one thing at a time; `from`: where to start, 0…1 of the file. */
function usePlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState<{ key: string; at: number } | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const stop = () => {
    audio.current?.pause();
    setOn(null);
  };
  const play = (key: string, src: string, from?: number) => {
    const a = (audio.current ??= new Audio());
    if (on?.key === key && from === undefined) return stop();
    if (on?.key !== key) {
      a.src = src;
      a.ontimeupdate = () => setOn((cur) => (cur ? { ...cur, at: a.duration ? a.currentTime / a.duration : 0 } : cur));
      a.onended = () => setOn(null);
      a.onerror = () => {
        setOn(null);
        toast('Не удалось воспроизвести', 'error');
      };
    }
    const seek = () => {
      if (from !== undefined && a.duration) a.currentTime = from * a.duration;
    };
    if (a.readyState >= 1) seek();
    else a.onloadedmetadata = seek;
    setOn({ key, at: from ?? 0 });
    void a.play().catch(() => setOn(null));
  };
  return { on, play, stop };
}

/** The loudness of a file along its length: a tap moves the listening there; the places in `marks` (seconds) are red. */
function Lane({ bars, length, marks, playing, at, onSeek, label }: { bars: number[]; length: number; marks: [number, number][]; playing: boolean; at: number; onSeek: (to: number) => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={`Перемотать: ${label}`}
      title="Нажмите, чтобы слушать с этого места"
      className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-px"
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        onSeek(Math.min(0.999, Math.max(0, (e.clientX - box.left) / box.width)));
      }}
    >
      {bars.length ? (
        bars.map((v, i) => {
          const t = ((i + 0.5) / bars.length) * length;
          const red = !!length && marks.some(([a, b]) => t >= a && t <= b);
          return <span key={i} className={cx('min-w-px flex-1 rounded-sm', red ? 'bg-danger' : playing && i / bars.length <= at ? 'bg-accent' : 'bg-fg/30')} style={{ height: `${Math.max(6, v)}%` }} />;
        })
      ) : (
        <span className="h-1 w-full rounded bg-fg/10" />
      )}
    </button>
  );
}

function Window({ track }: { track: FileSought }) {
  const id = track.library_track_id;
  const desktop = useDesktop();
  const mine = useAsync((s) => api.trackFile(id, s), [id]);
  const q = `${track.artist.split(',')[0].trim()} - ${track.title}`;
  const sources = useAsync((s) => api.searchProviders(q, s, 'sources'), [q]);
  const reuploads = useAsync((s) => api.searchProviders(q, s, 'reuploads'), [q]);
  const [weighed, setWeighed] = useState<Record<string, PickOut | 'busy'>>({});
  const [open, setOpen] = useState<string | null>(null); // the row whose file is laid beside the track's own
  const [linked, setLinked] = useState<Row[]>([]); // files the listener gave the pages of
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [myBars, setMyBars] = useState<number[]>([]);
  const player = usePlayer();
  const myAudio = `/api/quality/track/${id}/audio`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    player.stop();
    closeFindFile();
  };

  /** How the file compares with the track's own — asked once: the Hub downloads it for that. */
  const weigh = async (row: Row): Promise<PickOut | null> => {
    const have = weighed[row.key];
    if (have && have !== 'busy') return have;
    if (have === 'busy') return null;
    setWeighed((prev) => ({ ...prev, [row.key]: 'busy' }));
    try {
      const r = await api.fileWeigh(id, row.pick);
      setWeighed((prev) => ({ ...prev, [row.key]: r }));
      if (r.peaks?.mine?.length) setMyBars(r.peaks.mine);
      return r;
    } catch (e) {
      setWeighed((prev) => {
        const next = { ...prev };
        delete next[row.key];
        return next;
      });
      toast(e instanceof Error && e.message ? e.message : 'Источник не отдал файл', 'error');
      return null;
    }
  };
  /** A tap on a row's cover: the file is downloaded and laid beside the track's own, then it plays. */
  const hear = async (row: Row) => {
    const have = weighed[row.key];
    if (player.on?.key === row.key) return player.stop();
    setOpen(row.key);
    const w = have && have !== 'busy' ? have : await weigh(row);
    if (w?.key) player.play(row.key, `/api/quality/picked/${w.key}/audio`);
  };
  const take = async (row: Row) => {
    setBusy(row.key);
    const w = await weigh(row);
    if (!w) return setBusy(null);
    const gaps = w.verdict === 'same' ? (w.gaps ?? []) : [];
    if (gaps.length > 0) {
      setOpen(row.key);
      const quiet = gaps.filter((g) => g.quieter === 'other').length;
      const ok = await confirmDialog({
        title: 'Файлы расходятся местами',
        body: `Запись та же, но отличается на ${gaps.map((g) => clock(g.at)).join(', ')}. Так выглядит вырезанное или запиканное слово` + (quiet ? ' — и там тише именно найденный файл' : '') + '. Заменить всё равно?',
        okLabel: 'Заменить',
      });
      if (!ok) return setBusy(null);
    }
    if (w.verdict !== 'same') {
      const ok = await confirmDialog({
        title: w.verdict === 'other' ? 'Это другая запись' : w.verdict === 'alike' ? 'Запись только похожа' : 'Не удалось сравнить по звуку',
        body: (w.likeness != null ? `Сходство с вашим файлом по звуку: ${w.likeness.toFixed(2)}. ` : '') + 'Так бывает у ремикса, живой записи, другой версии. Всё равно поставить этот файл вместо вашего?',
        okLabel: 'Заменить',
      });
      if (!ok) return setBusy(null);
    }
    const r = await attempt(() => api.fileTake(id, { ...row.pick, sure: true }));
    setBusy(null);
    if (!r?.taken) return;
    player.stop();
    window.dispatchEvent(new Event(EDITED_EVENT));
    closeFindFile();
    toast('Файл заменён. Прежний хранится 30 дней', 'success', { label: 'Сравнить', to: '/quality' });
  };
  /** A page of one's own: the file is downloaded and stands in the list, laid beside the track's own. */
  const addLink = async () => {
    const link = url.trim();
    const row: Row = { key: `url:${link}`, pick: { url: link }, title: link, artist: '', provider: '', reupload: false };
    setBusy('url');
    const w = await weigh(row);
    setBusy(null);
    if (!w) return;
    setLinked((prev) => [{ ...row, title: w.title || link, artist: w.artist ?? '', provider: w.provider ?? '', duration_s: w.duration_s, bitrate_kbps: w.bitrate_kbps }, ...prev.filter((x) => x.key !== row.key)]);
    setOpen(row.key);
    setUrl('');
  };

  const seen = new Set<string>();
  const found: Row[] = [...(sources.data?.candidates ?? []), ...(reuploads.data?.candidates ?? [])]
    .map((c: Candidate) => ({ key: fileRef(c), pick: { ref: fileRef(c) }, title: c.title, artist: c.artist, provider: c.provider, duration_s: c.duration_s, bitrate_kbps: c.bitrate_kbps, explicit: c.explicit, reupload: !!(c.extra as { reupload?: boolean } | undefined)?.reupload }))
    .filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  const list = [...linked, ...found];
  const loading = sources.loading || reuploads.loading;
  const m = mine.data;
  const myLength = m?.duration_s ?? 0;
  const cover = m?.cover_url;
  const grid = { gridTemplateColumns: desktop ? '2.5rem minmax(0,1fr) 8rem 3rem 5.5rem 6.5rem' : '2.5rem minmax(0,1fr) 6.5rem' };

  const coverButton = (key: string, label: string, onClick: () => void, wait = false) => {
    const playing = player.on?.key === key;
    return (
      <button type="button" aria-label={playing ? 'Пауза' : label} onClick={onClick} className="group/c relative flex h-10 w-10 shrink-0 items-center justify-center">
        <Cover src={cover} size={40} alt="" />
        <span aria-hidden="true" className={cx('absolute inset-0 flex items-center justify-center rounded-md bg-black/60 text-white', !playing && !wait && 'opacity-0 group-hover/c:opacity-100')}>
          {wait ? <Spinner size={16} /> : <Icon name={playing ? 'pause' : 'play'} size={16} filled />}
        </span>
      </button>
    );
  };
  const quality = (codec: string | null | undefined, kbps: number | null | undefined, better: boolean) => (
    <span className={cx('justify-self-start whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]', better ? 'bg-accent/15 text-accent' : 'bg-fg/5 text-muted')}>{fileWords(codec, kbps)}</span>
  );
  const sourceOf = (provider: string, reupload: boolean) => (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
      {BRAND[provider] ? <BrandIcon service={BRAND[provider]} size={15} className="shrink-0" /> : <Icon name="link" size={14} className="shrink-0" />}
      <span className="truncate">{provider ? providerLabel(provider) : 'ссылка'}{reupload ? ' · перезалив' : ''}</span>
    </span>
  );

  const row = (r: Row) => {
    const w = weighed[r.key];
    const told = w && w !== 'busy' ? w : null;
    const name = [r.artist, r.title].filter(Boolean).join(' — ');
    const far = !!(myLength && r.duration_s && Math.abs(myLength - r.duration_s) > 5);
    const kbps = told?.bitrate_kbps ?? r.bitrate_kbps;
    const better = told ? told.better : !!(kbps && m?.bitrate_kbps && kbps >= m.bitrate_kbps + 48);
    const isOpen = open === r.key;
    const gaps: FileGap[] = told?.gaps ?? [];
    const length = told?.length?.other ?? told?.duration_s ?? r.duration_s ?? 0;
    const src = told?.key ? `/api/quality/picked/${told.key}/audio` : '';
    const from = (which: 'mine' | 'other', at: number) => {
      const len = which === 'mine' ? myLength : length;
      if (!len) return;
      player.play(which === 'mine' ? 'mine' : r.key, which === 'mine' ? myAudio : src, Math.min(0.999, Math.max(0, (at - 2) / len)));
    };
    return (
      <li key={r.key} className={cx('border-b border-line/60 last:border-0', isOpen && 'bg-fg/[0.04]')}>
        <div className="grid items-center gap-2.5 px-4 py-1.5" style={grid}>
          {coverButton(r.key, `Слушать и сравнить: ${name}`, () => void hear(r), w === 'busy')}
          <span className="min-w-0">
            <span className={cx('flex min-w-0 items-center gap-1.5 text-[15px]', player.on?.key === r.key && 'text-accent')}>
              <span className="truncate">{r.title}</span>
              {(r.explicit || UNCENSORED.test(name)) && <span className="shrink-0 rounded-full bg-info/20 px-1.5 text-[11px] text-info">без цензуры</span>}
            </span>
            <span className="block truncate text-[13px] text-muted">
              {r.artist}
              {CLEAN.test(name) && !UNCENSORED.test(name) && <span className="text-warn"> · возможно, цензурная версия</span>}
              {far && <span className="text-warn"> · другая длительность</span>}
            </span>
            {!desktop && (
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {sourceOf(r.provider, r.reupload)}
                <span className="text-[11px] tabular-nums text-dim">{fmtDuration(told?.duration_s ?? r.duration_s)}</span>
                {quality(told?.codec, kbps, better)}
              </span>
            )}
          </span>
          {desktop && sourceOf(r.provider, r.reupload)}
          {desktop && <span className={cx('text-right text-xs tabular-nums', far ? 'text-warn' : 'text-dim')}>{fmtDuration(told?.duration_s ?? r.duration_s)}</span>}
          {desktop && quality(told?.codec, kbps, better)}
          <Button small busy={busy === r.key} disabled={!!busy && busy !== r.key} onClick={() => void take(r)}>
            Заменить
          </Button>
        </div>
        {isOpen && (
          <div className="px-4 pb-3 md:pl-[4.25rem]">
            {w === 'busy' && <p className="flex items-center gap-2 py-2 text-xs text-muted"><Spinner size={12} /> Скачиваю файл и сравниваю с вашим по звуку…</p>}
            {told && (
              <>
                <div className="flex flex-wrap gap-1.5 pb-1 text-[11px]">
                  <span className={cx('rounded-full px-2 py-0.5', told.verdict === 'same' ? 'bg-accent/15 text-accent' : told.verdict === 'alike' ? 'bg-warn/15 text-warn' : told.verdict === 'other' ? 'bg-danger/15 text-danger' : 'bg-fg/10 text-muted')}>
                    {told.verdict === 'same' ? 'та же запись' : told.verdict === 'alike' ? 'похожа, но не та же' : told.verdict === 'other' ? 'другая запись' : 'сравнить по звуку не удалось'}
                    {told.likeness != null ? ` · ${told.likeness.toFixed(2)}` : ''}
                  </span>
                  {gaps.length > 0 && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-danger">расходится в {gaps.length === 1 ? '1 месте' : `${gaps.length} местах`}</span>}
                  {told.verdict === 'same' && gaps.length === 0 && <span className="rounded-full bg-fg/10 px-2 py-0.5 text-muted">отличающихся мест нет</span>}
                </div>
                {(['mine', 'other'] as const).map((which) => {
                  const key = which === 'mine' ? 'mine' : r.key;
                  const playing = player.on?.key === key;
                  return (
                    <div key={which} className="flex items-center gap-3 py-0.5">
                      <span className="w-12 shrink-0 text-[11px] text-dim">{which === 'mine' ? 'Ваш' : 'Найден'}</span>
                      <button type="button" aria-label={playing ? 'Пауза' : which === 'mine' ? 'Слушать ваш файл' : 'Слушать найденный файл'} onClick={() => player.play(key, which === 'mine' ? myAudio : src)} className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition hover:scale-105', playing ? 'border-accent text-accent' : 'border-line text-fg')}>
                        <Icon name={playing ? 'pause' : 'play'} size={12} filled className={playing ? '' : 'translate-x-px'} />
                      </button>
                      <Lane
                        bars={told.peaks?.[which] ?? []}
                        length={which === 'mine' ? myLength : length}
                        marks={gaps.map((g) => (which === 'mine' ? [g.at, g.to] : [g.other_at, g.other_to]))}
                        playing={playing}
                        at={player.on?.at ?? 0}
                        label={which === 'mine' ? 'ваш файл' : 'найденный файл'}
                        onSeek={(to) => player.play(key, which === 'mine' ? myAudio : src, to)}
                      />
                    </div>
                  );
                })}
                {gaps.length > 0 && (
                  <ul className="space-y-1 pt-1.5 text-xs">
                    {gaps.map((g) => (
                      <li key={g.at} className="flex flex-wrap items-center gap-2">
                        <span className="w-24 tabular-nums text-danger">{clock(g.at)}–{clock(g.to)}</span>
                        <button type="button" onClick={() => from('mine', g.at)} className="rounded-full bg-fg/10 px-2 py-0.5 hover:bg-fg/20">▶ ваш</button>
                        <button type="button" onClick={() => from('other', g.other_at)} className="rounded-full bg-fg/10 px-2 py-0.5 hover:bg-fg/20">▶ найден</button>
                        <span className="text-dim">{g.quieter === 'other' ? 'здесь тише найденный — похоже, вырезано в нём' : g.quieter === 'mine' ? 'здесь тише ваш — похоже, вырезано в нём' : 'так выглядит вырезанное или запиканное слово'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </li>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Найти другой файл">
      <button type="button" aria-label="Закрыть" className="absolute inset-0 bg-black/70" onClick={close} />
      <div className="anim-up pb-safe relative flex h-[100dvh] w-full max-w-4xl flex-col bg-surface sm:h-auto sm:max-h-[90dvh] sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <h2 className="flex-1 truncate text-base font-bold">Найти другой файл</h2>
          <IconButton icon="refresh" size={17} label="Искать заново" onClick={() => { sources.reload(); reuploads.reload(); }} />
          <IconButton icon="x" label="Закрыть" onClick={close} />
        </div>

        <div className="border-b border-line px-4 py-2.5">
          <p className="pb-1.5 text-[11px] text-dim">Сейчас у трека · {m?.name ?? '…'}{m?.source ? ` · ${providerLabel(m.source)}` : ''}</p>
          <div className="flex items-center gap-2.5">
            {coverButton('mine', 'Слушать текущий файл', () => player.play('mine', myAudio))}
            <span className="w-32 min-w-0 shrink-0 md:w-52">
              <span className={cx('block truncate text-[15px]', player.on?.key === 'mine' && 'text-accent')}>{track.title}</span>
              <span className="block truncate text-[13px] text-muted">{track.artist}</span>
            </span>
            <Lane bars={myBars} length={myLength} marks={[]} playing={player.on?.key === 'mine'} at={player.on?.at ?? 0} label="ваш файл" onSeek={(to) => player.play('mine', myAudio, to)} />
            <span className="shrink-0 text-xs tabular-nums text-dim">{fmtDuration(m?.duration_s)}</span>
            <span className="shrink-0 whitespace-nowrap rounded-full bg-fg/10 px-2 py-0.5 text-[11px] text-muted">{fileWords(m?.codec, m?.bitrate_kbps)}</span>
          </div>
          {myBars.length === 0 && <p className="pt-1 text-[11px] text-dim">Дорожка вашего файла появится, когда вы включите первый найденный — тогда сервер сравнит их.</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {desktop && list.length > 0 && (
            <div className="grid h-8 items-center gap-2.5 border-b border-line/60 px-4 text-xs text-dim" style={grid}>
              <span />
              <span>Найдено · {list.length}{loading ? ' · ищу ещё…' : ''}</span>
              <span>Источник</span>
              <span className="text-right">Время</span>
              <span>Качество</span>
              <span />
            </div>
          )}
          {list.length === 0 ? (
            loading ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : (
              <p className="px-4 py-10 text-center text-sm text-muted">Источники ничего не нашли. Вставьте ссылку на страницу трека ниже.</p>
            )
          ) : (
            <ul>{list.map(row)}</ul>
          )}
        </div>

        <div className="border-t border-line px-4 py-2.5">
          <div className="flex gap-2">
            <input className="input min-w-0 flex-1" placeholder="Своя ссылка: YouTube, SoundCloud, hitmoz, hitmos.fm" aria-label="Ссылка на трек" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void addLink()} />
            <Button small busy={busy === 'url'} disabled={!url.trim() || (!!busy && busy !== 'url')} onClick={() => void addLink()}>
              Скачать и сравнить
            </Button>
          </div>
          <p className="pt-1.5 text-[11px] text-dim">После замены прежний файл хранится 30 дней: сравнить и вернуть его можно в «Качество звука» → «Заменено».</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
