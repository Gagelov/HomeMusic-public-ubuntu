import { useSyncExternalStore } from 'react';
import { api, errorMessage } from '../api/client';
import type { StationPlayIn, StationStatus, StationTrackIn } from '../api/types';
import {
  getListenState,
  hideRemote,
  pauseListening,
  setRemoteControls,
  setVolume,
  showRemote,
  toggle,
  updateRemotePosition,
  type ListenPhase,
  type ListenTrack,
  type RemoteControls,
} from './listen';
import { toast } from './ui';

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

const initial: StationSource = (() => {
  try {
    if (localStorage.getItem(KEY) !== 'station') return 'device';
    if (stationConfig().token) return 'station';
    localStorage.setItem(KEY, 'device');
  } catch {
    /* storage is optional */
  }
  return 'device';
})();

let state: StationState = { source: initial, status: null, busy: false, error: null };
let timer: number | null = null;
let tick: number | null = null;
let statusAt = 0;
let basePosition = 0;
// the user moved the volume: polls that started before the command must not pull the slider back
let volumeSetAt = 0;
// the page player was sounding when the user sent the queue to the station
let resumeLocal = false;
// the queue actually sent to the station (only Navidrome tracks, with covers and links)
let stationItems: ListenTrack[] = [];
let remoteActive = false;
let stationWasPlaying = false;

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

function stationView(status: StationStatus) {
  if (!status.title && !status.id) return null;
  let items = stationItems;
  let index = status.index;
  let track = items[index];
  if (!track) {
    track = {
      ref: `station:${status.id || 'current'}`,
      nd_song_id: status.id || null,
      title: status.title || 'Станция',
      artist: status.artist || '',
      duration_s: status.duration || null,
    };
    items = [track];
    index = 0;
  }
  return {
    track,
    queue: items,
    index,
    position: status.position,
    duration: status.duration,
    phase: (status.playing ? 'playing' : status.paused ? 'paused' : 'ended') as ListenPhase,
    volume: Math.max(0, Math.min(1, (status.master ?? 0) / 100)),
  };
}

const controls: RemoteControls = {
  toggle: () => void stationCommand(state.status?.paused ? 'resume' : 'pause'),
  next: () => void stationCommand('next'),
  prev: () => void stationCommand('prev'),
  seek: (seconds) => void stationSeek(seconds),
  volume: (value) => void stationVolume(value),
  release: () => void releaseToDevice(true),
};

function showStatus(status: StationStatus) {
  const view = stationView(status);
  if (!view) return;
  if (!remoteActive) {
    remoteActive = true;
    setRemoteControls(controls);
  }
  // While the user is moving the slider, keep their value: a status request sent before the
  // volume command answers with the old Master and would make the handle jump back.
  if (Date.now() - volumeSetAt < 2500) view.volume = getListenState().volume;
  showRemote(view);
  statusAt = Date.now();
  basePosition = status.position;
}

function startTicking() {
  if (tick !== null) return;
  tick = window.setInterval(() => {
    if (state.source !== 'station' || !state.status?.playing) return;
    updateRemotePosition(basePosition + (Date.now() - statusAt) / 1000);
  }, 500);
}

function stopTicking() {
  if (tick !== null) {
    window.clearInterval(tick);
    tick = null;
  }
}

export async function refreshStation() {
  if (!stationConfigured()) {
    set({ status: null, error: 'Укажите токен станции в меню «Яндекс Станция»' });
    return;
  }
  try {
    const status = await api.stationStatus(stationHeaders());
    set({ status, error: null });
    if (state.source !== 'station') return;
    if (stationWasPlaying && !status.playing && !status.paused) {
      toast('Станция остановлена — звук снова на этом устройстве', 'info');
      await releaseToDevice(false);
      return;
    }
    if (status.playing || status.paused) stationWasPlaying = true;
    if (status.title || status.id) showStatus(status);
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
  }, 1500);
  startTicking();
}

export function stopStationPolling() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  stopTicking();
}

/** Queue of the page player, only the tracks the station can pull from Navidrome. */
function stationQueue(): {
  tracks: StationTrackIn[];
  items: ListenTrack[];
  index: number;
  position: number;
  playing: boolean;
} | null {
  const listen = getListenState();
  const current = listen.track;
  if (!current) return null;
  const items: ListenTrack[] = [];
  let index = 0;
  for (const t of listen.queue) {
    if (!t.nd_song_id) continue;
    if (t.ref === current.ref) index = items.length;
    items.push(t);
  }
  if (!items.length) return null;
  return {
    tracks: items.map((t) => ({ id: t.nd_song_id!, artist: t.artist, title: t.title, duration: t.duration_s ?? 0 })),
    items,
    index,
    position: Math.max(0, Math.floor(listen.position || 0)),
    playing: listen.phase === 'playing' || listen.phase === 'loading' || listen.phase === 'resolving',
  };
}

async function releaseToDevice(stop: boolean) {
  // the station's loudness stays: the one volume of the app carries over to this device
  const master = state.status?.master;
  if (remoteActive) {
    setRemoteControls(null);
    hideRemote();
    remoteActive = false;
  }
  stopStationPolling();
  stationWasPlaying = false;
  try { localStorage.setItem(KEY, 'device'); } catch { /* storage is optional */ }
  set({ source: 'device', status: null, busy: false, error: null });
  if (master !== undefined && master !== null) setVolume(master / 100);
  if (stop) {
    try { await api.stationCommand('stop', stationHeaders()); } catch { /* station offline: still switch */ }
  }
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
        stationItems = queue.items;
        const body: StationPlayIn = { index: queue.index, position: queue.position, tracks: queue.tracks };
        const status = await api.stationPlay(body, stationHeaders());
        pauseListening();
        stationWasPlaying = status.playing || status.paused;
        try { localStorage.setItem(KEY, 'station'); } catch { /* storage is optional */ }
        set({ source: 'station', status, busy: false });
        showStatus(status);
        startStationPolling();
        return;
      }
      // Nothing in the page player: show what the station already plays.
      const status = await api.stationStatus(stationHeaders());
      if (!status.title && !status.id) {
        set({ busy: false, error: 'Сначала выберите трек в приложении' });
        return;
      }
      stationItems = [];
      stationWasPlaying = status.playing || status.paused;
      try { localStorage.setItem(KEY, 'station'); } catch { /* storage is optional */ }
      set({ source: 'station', status, busy: false });
      pauseListening();
      showStatus(status);
      startStationPolling();
      return;
    }

    // back to this device: the station stops and the page player resumes
    const resume = resumeLocal;
    resumeLocal = false;
    await releaseToDevice(true);
    if (resume) toggle();
  } catch (e) {
    set({ busy: false, error: errorMessage(e) });
  }
}

async function stationCommand(
  action: 'next' | 'prev' | 'pause' | 'resume' | 'stop',
  extra?: Record<string, unknown>,
): Promise<void> {
  if (state.source !== 'station') return;
  set({ busy: true });
  try {
    const status = await api.stationCommand(action, stationHeaders(), extra);
    set({ status, error: null });
    if (status.playing || status.paused) stationWasPlaying = true;
    if (status.title || status.id) showStatus(status);
    if (action === 'stop') await releaseToDevice(false);
  } catch (e) {
    set({ error: errorMessage(e) });
  } finally {
    set({ busy: false });
  }
}

export async function stationSeek(seconds: number): Promise<void> {
  if (state.source !== 'station' || !Number.isFinite(seconds)) return;
  try {
    const status = await api.stationCommand('seek', stationHeaders(), { position: Math.max(0, Math.floor(seconds)) });
    set({ status, error: null });
    showStatus(status);
  } catch (e) {
    set({ error: errorMessage(e) });
  }
}

export async function stationVolume(value: number): Promise<void> {
  if (state.source !== 'station') return;
  volumeSetAt = Date.now();
  try {
    const status = await api.stationCommand('volume', stationHeaders(), { value: Math.max(0, Math.min(100, Math.round(value * 100))) });
    set({ status, error: null });
    showStatus(status);
  } catch (e) {
    set({ error: errorMessage(e) });
  }
}

export const stationNext = () => stationCommand('next');
export const stationPrev = () => stationCommand('prev');
export const stationToggle = () => stationCommand(state.status?.paused ? 'resume' : 'pause');

// A reload keeps the station as the source: its status replaces the page player
// as soon as the Hub and the station answer.
if (initial === 'station') {
  window.setTimeout(() => startStationPolling(), 0);
}
