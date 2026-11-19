import { useSyncExternalStore } from 'react';
import { api, errorMessage } from '../api/client';
import type { StationPlayIn, StationStatus, StationTrackIn } from '../api/types';
import { getListenState, pauseListening, toggle } from './listen';

/** Where the PWA plays: this device (its `<audio>`) or the Yandex Station. */
export type StationSource = 'device' | 'station';

export interface StationState {
  source: StationSource;
  status: StationStatus | null;
  busy: boolean;
  error: string | null;
}

const KEY = 'hm:station-source';
const TOKEN_KEY = 'hm:station-token';
const URL_KEY = 'hm:station-url';
const DEFAULT_URL = 'http://192.168.50.181:8099';

export function stationConfig(): { url: string; token: string } {
  try {
    return {
      url: (localStorage.getItem(URL_KEY) || DEFAULT_URL).trim(),
      token: (localStorage.getItem(TOKEN_KEY) || '').trim(),
    };
  } catch {
    return { url: DEFAULT_URL, token: '' };
  }
}

export function saveStationConfig(url: string, token: string) {
  try {
    localStorage.setItem(URL_KEY, url.trim() || DEFAULT_URL);
    localStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    /* private mode: the config lives until the page is closed */
  }
}

export function stationConfigured(): boolean {
  return !!stationConfig().token;
}

export function stationHeaders(): Record<string, string> {
  const c = stationConfig();
  return { 'X-HM-Station-URL': c.url, 'X-HM-Station-Token': c.token };
}
const saved = (() => {
  try {
    return localStorage.getItem(KEY) === 'station' ? 'station' : 'device';
  } catch {
    return 'device';
  }
})();

let state: StationState = { source: saved as StationSource, status: null, busy: false, error: null };
let timer: number | null = null;
// the page player was sounding when the user sent the queue to the station
let resumeLocal = false;

const listeners = new Set<() => void>();

function set(patch: Partial<StationState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useStation<T>(select: (s: StationState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export async function refreshStation() {
  if (!stationConfigured()) {
    set({ status: null, error: 'Укажите токен станции в меню «Яндекс Станция»' });
    return;
  }
  try {
    set({ status: await api.stationStatus(stationHeaders()), error: null });
  } catch (e) {
    set({ error: errorMessage(e) });
  }
}

export function startStationPolling() {
  if (timer !== null) return;
  void refreshStation();
  timer = window.setInterval(() => {
    if (state.source !== 'station') {
      stopStationPolling();
      return;
    }
    void refreshStation();
  }, 2000);
}

export function stopStationPolling() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

/** Queue of the page player, only the tracks the station can pull from Navidrome. */
function stationQueue(): { tracks: StationTrackIn[]; index: number; position: number; playing: boolean } | null {
  const listen = getListenState();
  const current = listen.track;
  if (!current) return null;
  const tracks: StationTrackIn[] = [];
  let index = 0;
  for (const t of listen.queue) {
    if (!t.nd_song_id) continue;
    if (t.ref === current.ref) index = tracks.length;
    tracks.push({ id: t.nd_song_id, artist: t.artist, title: t.title, duration: t.duration_s ?? 0 });
  }
  if (!tracks.length) return null;
  return {
    tracks,
    index,
    position: Math.max(0, Math.floor(listen.position || 0)),
    playing: listen.phase === 'playing' || listen.phase === 'loading' || listen.phase === 'resolving',
  };
}

export async function selectSource(next: StationSource): Promise<void> {
  if (next === state.source && (next === 'device' || state.status)) return;
  if (next === 'station' && !stationConfigured()) {
    set({ error: 'Укажите токен станции в меню «Яндекс Станция»' });
    return;
  }
  set({ busy: true, error: null });
  try {
    if (next === 'station') {
      const queue = stationQueue();
      if (queue) {
        resumeLocal = queue.playing;
        const body: StationPlayIn = { index: queue.index, position: queue.position, tracks: queue.tracks };
        await api.stationPlay(body, stationHeaders());
        pauseListening();
      } else {
        // Nothing in the page player: show what the station already plays.
        await refreshStation();
        if (!state.status) {
          set({ busy: false, error: 'Сначала выберите трек в приложении' });
          return;
        }
      }
      try { localStorage.setItem(KEY, 'station'); } catch { /* private mode */ }
      set({ source: 'station', busy: false });
      startStationPolling();
      return;
    }

    // back to this device: the station stops and the page player resumes
    try { await api.stationCommand('stop', stationHeaders()); } catch { /* station offline: still switch */ }
    stopStationPolling();
    try { localStorage.setItem(KEY, 'device'); } catch { /* private mode */ }
    set({ source: 'device', status: null, busy: false });
    if (resumeLocal) {
      resumeLocal = false;
      toggle();
    }
  } catch (e) {
    set({ busy: false, error: errorMessage(e) });
  }
}

export async function stationCommand(action: 'next' | 'prev' | 'pause' | 'resume' | 'stop'): Promise<void> {
  if (state.source !== 'station') return;
  set({ busy: true });
  try {
    set({ status: await api.stationCommand(action, stationHeaders()), error: null });
  } catch (e) {
    set({ error: errorMessage(e) });
  } finally {
    set({ busy: false });
  }
}

export const stationNext = () => stationCommand('next');
export const stationPrev = () => stationCommand('prev');
export const stationToggle = () => stationCommand(state.status?.paused ? 'resume' : 'pause');
