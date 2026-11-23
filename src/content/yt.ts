// YouTube bridge for the isolated content script. Owner: A.
import type { CaptionTrack, Json3, PlayerResponse } from '../shared/types';

/** Current player response via the MAIN-world bridge (movie_player.getPlayerResponse, fallback ytInitialPlayerResponse when videoId matches); null if unavailable. */
export async function getPlayerResponse(): Promise<PlayerResponse | null> {
  return null; // TODO A
}

/** Video id from a URL (default location.href) for /watch?v=; null otherwise. */
export function getVideoId(url?: string): string | null {
  void url;
  return null; // TODO A
}

/** True for https://www.youtube.com/watch?v=… (never /shorts/). */
export function isWatchPage(url?: string): boolean {
  void url;
  return false; // TODO A
}

/** Fetch json3 for a track in the MAIN world (captured URL → performance entry → baseUrl → CC toggle); sets/removes `tlang`. null on empty body; throws DubError('RATE_LIMITED') on 429. */
export async function getJson3(track: CaptionTrack, videoId: string, tlang?: string): Promise<Json3 | null> {
  void track; void videoId; void tlang;
  throw new Error('TODO A');
}

/** The #movie_player element, or null. */
export function getPlayer(): HTMLElement | null {
  return null; // TODO A
}

/** The main <video> element of the player, or null. */
export function getVideo(): HTMLVideoElement | null {
  return null; // TODO A
}
