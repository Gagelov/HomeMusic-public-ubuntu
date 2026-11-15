import { useSyncExternalStore } from 'react';

/** The window that finds another file for a track of the library (`components/FindFile.tsx`): asked for from a
 * track's menu, drawn once over everything. */
export interface FileSought {
  library_track_id: number;
  title: string;
  artist: string;
}

let state: FileSought | null = null;
const subs = new Set<() => void>();
const set = (next: FileSought | null) => {
  state = next;
  subs.forEach((f) => f());
};

export const useFindFile = (): FileSought | null =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => state,
    () => state,
  );
export const openFindFile = (track: FileSought) => set(track);
export const closeFindFile = () => set(null);
