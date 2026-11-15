import type { SyntheticEvent } from 'react';

/** The catalog's pictures live under several host names with the same paths. The one its answers name (`cdn-images`)
 * is a cache that refuses some networks whatever it has not kept yet — an artist's photo or a cover that never shows
 * while its neighbours do; the others answer, though each of them refuses now and then too. So a picture is asked
 * of the second, and of the next ones in turn while it fails. */
const HOSTS = ['e-cdns-images.dzcdn.net', 'e-cdn-images.dzcdn.net', 'cdn-images.dzcdn.net'];
const NAMED = 'cdn-images.dzcdn.net';
const at = (h: string) => `https://${h}/`;

/** The address a picture is asked at. */
export function imageUrl<T extends string | null | undefined>(src: T): T | string {
  return src && src.startsWith(at(NAMED)) ? at(HOSTS[0]) + src.slice(at(NAMED).length) : src;
}

function nextHost(src: string): string | null {
  for (const [i, h] of HOSTS.entries()) if (src.startsWith(at(h))) return i + 1 < HOSTS.length ? at(HOSTS[i + 1]) + src.slice(at(h).length) : null;
  return null;
}

/** `onError` of an `<img>`: ask the next host for it. False: there is none left. */
export function retryImage(e: SyntheticEvent<HTMLImageElement>): boolean {
  const img = e.currentTarget;
  const alt = nextHost(img.src);
  if (!alt) return false;
  img.src = alt;
  return true;
}
