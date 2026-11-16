import { useEffect, useSyncExternalStore } from 'react';
import { UNAUTHORIZED_EVENT, api } from '../api/client';

/** A newcomer: a listener the Hub knows nothing of yet — no listens, no artists picked, no mix. «Моя волна» and
 * «Микс дня» have nothing to start from, so their buttons lead to «Кого вы слушаете?» (`pages/Mix.tsx`). One answer
 * for the whole app, asked anew when a page that shows it opens (not more often than twice a minute). */
let newcomer: boolean | undefined;
let askedAt = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function refresh() {
  if (Date.now() - askedAt < 30_000) return;
  askedAt = Date.now();
  api.mixToday().then(
    (r) => {
      newcomer = r.onboarding && !r.mix && !r.building;
      emit();
    },
    () => {
      askedAt = 0;
    },
  );
}

if (typeof window !== 'undefined')
  window.addEventListener(UNAUTHORIZED_EVENT, () => {
    newcomer = undefined;
    askedAt = 0;
    emit();
  });

/** False until the Hub has said so: nothing is shown that would be taken back a moment later. */
export function useNewcomer(): boolean {
  useEffect(refresh, []);
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => newcomer === true,
  );
}

/** Artists were picked: a newcomer no more. */
export function tastePicked() {
  newcomer = false;
  askedAt = Date.now();
  emit();
}

/** The page of the picker, and where it leads once the artists are picked: into the wave, or to the mix. */
export const tastePath = (then?: 'wave' | 'mix') => (then ? `/taste?then=${then}` : '/taste');
