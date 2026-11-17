import { useSyncExternalStore } from 'react';

/** The window of a song's versions (`components/Versions.tsx`): asked for from a track's menu or from the mark of
 * a row, drawn once over everything. The track is named the way a row knows it — the Hub's id, the catalog's ref or
 * Navidrome's song. */
export interface VersionsOf {
  title: string;
  library_track_id?: number | null;
  ref?: string | null;
  nd_song_id?: string | null;
}

let state: VersionsOf | null = null;
const subs = new Set<() => void>();
const set = (next: VersionsOf | null) => {
  state = next;
  subs.forEach((f) => f());
};

export const useVersions = (): VersionsOf | null =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => state,
    () => state,
  );
export const openVersions = (track: VersionsOf) => set(track);
export const closeVersions = () => set(null);
