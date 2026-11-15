import { useState } from 'react';
import { api } from '../api/client';
import type { ArtistCardOut, ArtistPickOut } from '../api/types';
import { useAsync } from '../lib/hooks';
import { Link } from '../lib/router';
import { attempt, confirmDialog, toast } from '../lib/ui';
import { Icon } from './Icon';
import { Button, Sheet, cx } from './ui';

/** An artist as the Hub knows them — the one name, the other spellings, the other projects — for a page of theirs:
 * by what the catalog calls its own artist (`ref`) or by the name. The page shows `card.name` as its title. */
export function useArtistCard(name: string | null | undefined, ref?: string | null) {
  const res = useAsync((s) => (name || ref ? api.artistOf({ name: name ?? undefined, ref: ref ?? undefined }, s) : Promise.resolve(null)), [name, ref], true, `artist-card:${ref ?? name}`);
  const [said, setSaid] = useState<ArtistCardOut | null>(null); // what a change in the window answered
  return { card: said ?? res.data ?? null, set: setSaid };
}

const SOURCE: Record<string, string> = { catalog: 'каталог', library: 'из файлов', manual: 'вручную' };
const enc = encodeURIComponent;

/** Under an artist's name on their page: «также: LSP» — the other spellings; the other projects of who it is, each
 * a link to its page; and the way into the window that changes them. */
export function ArtistAlso({ card, onChange, className }: { card: ArtistCardOut | null; onChange: (next: ArtistCardOut) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!card) return null;
  const also = card.names.filter((n) => !n.main).map((n) => n.name);
  return (
    <div className={cx('px-4 text-[13px] text-muted lg:px-6', className)}>
      <p className="flex flex-wrap items-center gap-x-1.5">
        {also.length > 0 && <span>Также: {also.join(', ')}</span>}
        {card.suggestions.length > 0 && <span className="rounded-full bg-info/15 px-2 text-info">похоже на: {card.suggestions.map((x) => x.name).join(', ')}</span>}
        <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-dim hover:text-fg">
          <Icon name="edit" size={13} />
          {also.length || card.projects.length ? 'имя и написания' : 'другие написания и проекты'}
        </button>
      </p>
      {card.projects.length > 0 && (
        <p className="pt-0.5">
          Другие проекты:{' '}
          {card.projects.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <Link to={p.ref ? `/artist/${enc(p.ref)}` : `/artist-named/${enc(p.name)}`} className="text-fg hover:underline">
                {p.name}
              </Link>
              {p.also.length > 0 && <span className="text-dim"> ({p.also.join(', ')})</span>}
            </span>
          ))}
        </p>
      )}
      {open && <NamesWindow card={card} onChange={onChange} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** «Имя и написания»: the artist's one name among their spellings, the artists that are the same one, and the
 * other projects of who it is. Whatever is changed here is changed for everyone; a new name, or an artist joined,
 * rewrites the library — its tracks, albums and the files' tags — which takes the Hub a little while. */
function NamesWindow({ card, onChange, onClose }: { card: ArtistCardOut; onChange: (next: ArtistCardOut) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [spelling, setSpelling] = useState('');
  const [other, setOther] = useState('');
  const picks = useAsync((s) => (other.trim().length > 1 ? api.artistFind(other.trim(), s) : Promise.resolve([] as ArtistPickOut[])), [other]);
  const run = async (what: () => Promise<ArtistCardOut>, said?: string) => {
    setBusy(true);
    const next = await attempt(what);
    setBusy(false);
    if (!next) return false;
    onChange(next);
    if (said) toast(said, 'success');
    return true;
  };
  const REWRITE = 'Библиотека переписывается: треки, альбомы и теги файлов. Это займёт немного времени';

  const makeMain = async (id: number, name: string) => {
    const ok = await confirmDialog({ title: `Основное имя — «${name}»?`, body: `Все увидят исполнителя под этим именем. Треки и альбомы, где он записан как «${card.name}», будут переписаны, в том числе теги в файлах.`, okLabel: 'Сделать основным' });
    if (ok) await run(() => api.artistMain(card.id, id), REWRITE);
  };
  const dropName = async (id: number, name: string, source: string) => {
    const ok = source === 'manual' || (await confirmDialog({ title: `«${name}» — другой исполнитель?`, body: 'Написание станет отдельным исполнителем: музыка, которая придёт под ним дальше, будет его. Треки, уже переписанные под основным именем, останутся как есть.', okLabel: 'Отделить' }));
    if (ok) await run(() => api.artistDropName(card.id, id));
  };
  const merge = async (who: { other_id?: number; name?: string }, name: string) => {
    const ok = await confirmDialog({ title: `«${name}» — это ${card.name}?`, body: `Они станут одним исполнителем под именем «${card.name}». Треки и альбомы «${name}» будут переписаны под этим именем, в том числе теги в файлах. Если это отдельный проект того же человека со своими релизами — выберите «другой проект».`, okLabel: 'Объединить' });
    if (ok && (await run(() => api.artistMerge(card.id, who), REWRITE))) setOther('');
  };
  const addSpelling = async () => {
    const name = spelling.trim();
    if (!name) return;
    // a spelling that is somebody's: the two are joined, by their word
    const theirs = (await api.artistFind(name).catch(() => [] as ArtistPickOut[])).find((x) => x.id !== card.id && x.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    if (theirs) {
      await merge({ other_id: theirs.id }, theirs.name);
      setSpelling('');
      return;
    }
    if (await run(() => api.artistAddName(card.id, name))) setSpelling('');
  };
  const project = async (who: { other_id?: number; name?: string }) => {
    if (await run(() => api.artistAddProject(card.id, who))) setOther('');
  };
  const typed = other.trim();
  const found = (picks.data ?? []).filter((x) => x.id !== card.id);
  const chip = 'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-sm';
  const mini = 'flex h-5 w-5 items-center justify-center rounded-full text-dim hover:bg-fg/10 hover:text-fg';

  return (
    <Sheet open onClose={onClose} title="Имя и написания">
      <div className={cx('space-y-4 text-fg', busy && 'pointer-events-none opacity-60')}>
        <section>
          <p className="pb-1.5 text-[13px] text-muted">Имя, под которым исполнителя видят все, и другие написания — по ним он тоже находится.</p>
          <div className="flex flex-wrap gap-1.5">
            {card.names.map((n) => (
              <span key={n.id} className={cx(chip, n.main && 'border-accent text-accent')}>
                <span className="truncate">{n.name}</span>
                <span className={cx('text-[11px]', n.main ? 'text-accent' : 'text-dim')}>{n.main ? 'основное' : (SOURCE[n.source] ?? n.source)}</span>
                {!n.main && (
                  <>
                    <button type="button" className={mini} aria-label={`Сделать основным: ${n.name}`} title="Сделать основным" onClick={() => void makeMain(n.id, n.name)}>
                      <Icon name="chevron" size={12} className="-rotate-90" />
                    </button>
                    <button type="button" className={mini} aria-label={`Убрать написание: ${n.name}`} title={n.source === 'manual' ? 'Убрать' : 'Это другой исполнитель — отделить'} onClick={() => void dropName(n.id, n.name, n.source)}>
                      <Icon name="x" size={12} />
                    </button>
                  </>
                )}
              </span>
            ))}
          </div>
          <div className="flex gap-2 pt-2">
            <input className="input min-w-0 flex-1" placeholder="Ещё написание: LSP" aria-label="Ещё написание" value={spelling} onChange={(e) => setSpelling(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addSpelling()} maxLength={300} />
            <Button small disabled={!spelling.trim()} onClick={() => void addSpelling()}>
              Добавить
            </Button>
          </div>
        </section>

        {card.suggestions.length > 0 && (
          <section className="rounded-xl bg-info/10 px-3 py-2 text-[13px]">
            <p className="pb-1 text-muted">Похоже на того же исполнителя:</p>
            {card.suggestions.map((x) => (
              <p key={x.id} className="flex flex-wrap items-center gap-x-3 py-0.5">
                <span className="text-sm">{x.name}</span>
                <button type="button" className="text-info hover:underline" onClick={() => void merge({ other_id: x.id }, x.name)}>объединить</button>
                <button type="button" className="text-info hover:underline" onClick={() => void project({ other_id: x.id })}>это его проект</button>
                <button type="button" className="text-muted hover:underline" onClick={() => void run(() => api.artistApart(card.id, { other_id: x.id }))}>это другой</button>
              </p>
            ))}
          </section>
        )}

        <section>
          <p className="pb-1.5 text-[13px] text-muted">Другие проекты того же человека. У проекта свои релизы и своя страница — музыка не смешивается, страницы ссылаются друг на друга.</p>
          {card.projects.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2">
              {card.projects.map((p) => (
                <span key={p.id} className={chip}>
                  <span className="truncate">{p.name}</span>
                  <button type="button" className={mini} aria-label={`Убрать проект: ${p.name}`} title="Больше не проект" onClick={() => void run(() => api.artistDropProject(card.id, p.id))}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input className="input w-full" placeholder="Другой исполнитель: имя" aria-label="Другой исполнитель" value={other} onChange={(e) => setOther(e.target.value)} maxLength={300} />
          {typed.length > 1 && (
            <div className="space-y-1 pt-2 text-[13px]">
              {[...found.map((x) => ({ who: { other_id: x.id }, name: x.name, known: true })), ...(found.some((x) => x.name.toLocaleLowerCase() === typed.toLocaleLowerCase()) ? [] : [{ who: { name: typed }, name: typed, known: false }])].map((x) => (
                <p key={`${x.known}:${x.name}`} className="flex flex-wrap items-center gap-x-3 rounded-lg px-2 py-1 hover:bg-fg/5">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {x.name}
                    {!x.known && <span className="text-dim"> — пока нет в библиотеке</span>}
                  </span>
                  <button type="button" className="text-info hover:underline" onClick={() => void project(x.who)}>это его другой проект</button>
                  <button type="button" className="text-info hover:underline" onClick={() => void merge(x.who, x.name)}>это тот же исполнитель</button>
                </p>
              ))}
            </div>
          )}
        </section>
        <p className="text-[12px] text-dim">Изменения видят все на этом сервере. Основное имя записывается и в файлы — так же исполнитель называется в Navidrome и других плеерах.</p>
      </div>
    </Sheet>
  );
}
