import { useSyncExternalStore } from 'react';
import { api, errorMessage } from '../api/client';
import type { StationPlayIn, StationQueue, StationStatus, StationTrackIn } from '../api/types';
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
let watchTimer: number | null = null;
let tick: number | null = null;
let refreshing = false;
let statusAt = 0;
let basePosition = 0;
// the user moved the volume: polls that started before the command must not pull the slider back
let volumeSetAt = 0;
// just left the station: its stop command may still be in flight, do not adopt the old session again
let ignoreVoiceUntil = 0;
// the station is replacing its session (a new voice command, another device): it may be
// silent for a moment, so a stop counts only after it lasts longer than that gap
let stoppedAt = 0;
// the page player was sounding when the user sent the queue to the station
let resumeLocal = false;
// the queue actually played on the station (covers and links when the page player sent it)
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

/** A cover from the station queue: a Navidrome coverArt id (voice) or a ready URL (the app's own queue). */
function coverImage(cover: string | null | undefined, size: number): string | null {
  if (!cover) return null;
  if (cover.startsWith('http') || cover.startsWith('/')) return cover;
  return `/api/nd/cover/${encodeURIComponent(cover)}?size=${size}`;
}

/** A station queue row as the page player's track: no page of its own, but the Navidrome id and cover are kept. */
function queueItems(tracks: readonly StationTrackIn[]): ListenTrack[] {
  return tracks.map((t) => {
    const cover = coverImage(t.cover, 1000);
    return {
      ref: `station:${t.id || t.title}`,
      nd_song_id: t.id || null,
      title: t.title || 'Станция',
      artist: t.artist || '',
      duration_s: t.duration || null,
      cover_url: cover,
      cover_small_url: coverImage(t.cover, 160) ?? cover,
    };
  });
}

function stationView(status: StationStatus) {
  if (!status.title && !status.id) return null;
  let items = stationItems;
  let index = status.index;
  let track = items[index];
  if (!track || (status.id && track.nd_song_id && track.nd_song_id !== status.id)) {
    track = {
      ref: `station:${status.id || 'current'}`,
      nd_song_id: status.id || null,
      title: status.title || 'Станция',
      artist: status.artist || '',
      duration_s: status.duration || null,
      cover_url: coverImage(status.cover, 1000),
      cover_small_url: coverImage(status.cover, 160),
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

/** Sends a list to the station and starts at `index`: the queue the station plays becomes this list. */
async function castStation(items: ListenTrack[], index: number): Promise<void> {
  if (index < 0 || index >= items.length) return;
  set({ busy: true });
  try {
    const body: StationPlayIn = {
      index,
      position: 0,
      tracks: items.map((t) => ({
      id: t.nd_song_id!, artist: t.artist, title: t.title, duration: t.duration_s ?? 0,
      cover: t.cover_url || t.cover_small_url || '',
    })),
    };
    const status = await api.stationPlay(body, stationHeaders());
    stationItems = items;
    stoppedAt = 0;
    stationWasPlaying = status.playing || status.paused;
    try { localStorage.setItem(KEY, 'station'); } catch { /* storage is optional */ }
    set({ source: 'station', status, busy: false, error: null });
    showStatus(status);
    startStationPolling();
  } catch (e) {
    set({ busy: false, error: errorMessage(e) });
  }
}

/** A tap on a row of the station's queue: play that index there, not on this device. */
function stationPlayAt(index: number): void {
  const item = stationItems[index];
  if (!item || !item.nd_song_id) return;
  let at = 0;
  for (let i = 0; i < index; i++) if (stationItems[i].nd_song_id) at++;
  const items = stationItems.filter((t) => !!t.nd_song_id);
  void castStation(items, at);
}

/** A tap on a track somewhere in the app while the station plays: send that list to the station. */
function stationPlayList(track: ListenTrack, queue?: readonly ListenTrack[]): boolean {
  const list = queue?.some((t) => t.ref === track.ref) ? queue : [track];
  const items = list.filter((t) => !!t.nd_song_id);
  let at = -1;
  let byRef = -1;
  let n = 0;
  for (const t of list) {
    if (!t.nd_song_id) continue;
    if (t === track) { at = n; break; }
    if (byRef < 0 && t.ref === track.ref) byRef = n;
    n++;
  }
  if (at < 0) at = byRef;
  if (at < 0) return false; // not in Navidrome: the station cannot pull it
  void castStation(items, at);
  return true;
}

const controls: RemoteControls = {
  toggle: () => void stationCommand(state.status?.paused ? 'resume' : 'pause'),
  next: () => void stationCommand('next'),
  prev: () => void stationCommand('prev'),
  playAt: (index) => stationPlayAt(index),
  playList: (track, queue) => stationPlayList(track, queue),
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

/** The station's own queue: fetched when the app did not start the session (a voice command, another device). */
async function ensureItems(status: StationStatus): Promise<void> {
  const count = status.queue || 0;
  const current = stationItems[status.index];
  if (count > 0 && stationItems.length === count && (!status.id || current?.nd_song_id === status.id)) return;
  if (count === 0) {
    stationItems = [];
    return;
  }
  try {
    const queue: StationQueue = await api.stationQueue(stationHeaders());
    stationItems = queueItems(queue.tracks ?? []);
  } catch {
    // keep what is known; the status still names the playing track
  }
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

/** Mirrors the station's session in the one player. `resume` — put the local queue back on return. */
async function adoptStation(status: StationStatus, resume: boolean): Promise<void> {
  const listen = getListenState();
  resumeLocal = resume && (listen.phase === 'playing' || listen.phase === 'loading' || listen.phase === 'resolving');
  stoppedAt = 0;
  stopStationWatch();
  await ensureItems(status);
  pauseListening();
  stationWasPlaying = status.playing || status.paused;
  try { localStorage.setItem(KEY, 'station'); } catch { /* storage is optional */ }
  set({ source: 'station', status, busy: false, error: null });
  showStatus(status);
  startStationPolling();
}

/**
 * `watch`: a quiet look from the device source, to notice a session started by voice.
 * The station's queue is adopted, never replaced: the page player may be showing another list.
 */
async function refreshStation(watch = false): Promise<void> {
  if (!stationConfigured()) {
    if (!watch) set({ status: null, error: 'Укажите токен станции в меню «Яндекс Станция»' });
    return;
  }
  if (refreshing) return;
  refreshing = true;
  try {
    const status = await api.stationStatus(stationHeaders());
    set({ status, error: null });
    if (state.source === 'station') {
      if (stationWasPlaying && !status.playing && !status.paused) {
        if (!stoppedAt) stoppedAt = Date.now();
        if (Date.now() - stoppedAt >= 2500) {
          toast('Станция остановлена — звук снова на этом устройстве', 'info');
          await releaseToDevice(false);
          return;
        }
      } else {
        stoppedAt = 0;
      }
      if (status.playing || status.paused) stationWasPlaying = true;
      if (status.title || status.id) {
        await ensureItems(status);
        showStatus(status);
      }
    } else if (watch && status.playing && (status.title || status.id) && Date.now() >= ignoreVoiceUntil) {
      // «Включи … через сервер»: the station is already playing HomeMusic, show it here too.
      await adoptStation(status, true);
    }
  } catch (e) {
    if (!watch) set({ error: errorMessage(e) });
  } finally {
    refreshing = false;
  }
}

export function startStationPolling() {
  stopStationWatch();
  if (timer !== null) return;
  void refreshStation();
  timer = window.setInterval(() => {
    if (state.source !== 'station') {
      stopStationPolling();
      startStationWatch();
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

/** A slow, quiet poll while this device plays: notice a HomeMusic session started by voice. */
export function startStationWatch() {
  if (!stationConfigured() || state.source === 'station' || watchTimer !== null) return;
  void refreshStation(true);
  watchTimer = window.setInterval(() => {
    if (state.source !== 'device') {
      stopStationWatch();
      return;
    }
    void refreshStation(true);
  }, 2000);
}

function stopStationWatch() {
  if (watchTimer !== null) {
    window.clearInterval(watchTimer);
    watchTimer = null;
  }
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
    tracks: items.map((t) => ({
      id: t.nd_song_id!, artist: t.artist, title: t.title, duration: t.duration_s ?? 0,
      cover: t.cover_url || t.cover_small_url || '',
    })),
    items,
    index,
    position: Math.max(0, Math.floor(listen.position || 0)),
    playing: listen.phase === 'playing' || listen.phase === 'loading' || listen.phase === 'resolving',
  };
}

async function releaseToDevice(stop: boolean) {
  // the just-sent stop may take a moment; do not mistake the old session for a voice start
  ignoreVoiceUntil = Date.now() + 5000;
  stoppedAt = 0;
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
  startStationWatch();
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
      // A session is already sounding (voice, another app): mirror it instead of
      // replacing its queue with the page player's current one.
      const status = await api.stationStatus(stationHeaders());
      if (status.playing && (status.title || status.id)) {
        await adoptStation(status, true);
        return;
      }
      const queue = stationQueue();
      if (queue) {
        resumeLocal = queue.playing;
        stationItems = queue.items;
        const body: StationPlayIn = { index: queue.index, position: queue.position, tracks: queue.tracks };
        const started = await api.stationPlay(body, stationHeaders());
        pauseListening();
        stoppedAt = 0;
        stationWasPlaying = started.playing || started.paused;
        try { localStorage.setItem(KEY, 'station'); } catch { /* storage is optional */ }
        set({ source: 'station', status: started, busy: false });
        showStatus(started);
        startStationPolling();
        return;
      }
      // Nothing in the page player: show what the station already has, even if paused.
      if (status.title || status.id) {
        await adoptStation(status, false);
        return;
      }
      set({ busy: false, error: 'Сначала выберите трек в приложении' });
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
    if (status.title || status.id) {
      await ensureItems(status);
      showStatus(status);
    }
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

// A reload keeps the station as the source: its status replaces the page player.
// On the device source a quiet watch still notices a session started by voice.
if (initial === 'station') {
  window.setTimeout(() => startStationPolling(), 0);
} else {
  window.setTimeout(() => startStationWatch(), 0);
}
