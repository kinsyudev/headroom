/**
 * After macOS hibernates, Bun can come back with its HTTP server answering and no timer ever firing
 * again, so every loop freezes while the page still loads. A timer can't watch timers, so an interval
 * beats and the HTTP path asks. A stale beat is only suspicious, because the first request after any
 * wake beats the timers to it; the timers are dead when a request one grace window later still sees
 * no beat since the suspicion.
 */
import type { Instant } from '../shared/domain';

const BEAT_EVERY_MS = 1_000;

export interface Watchdog {
  start(): void;
  stop(): void;
  beat(): void;
  timersDead(): boolean;
}

export function createWatchdog(deps: { readonly now: () => Instant; readonly graceMs: number }): Watchdog {
  let lastBeat = deps.now();
  let suspectSince: Instant | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const beat = () => {
    lastBeat = deps.now();
  };

  return {
    start() {
      timer ??= setInterval(beat, BEAT_EVERY_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    beat,
    timersDead() {
      const t = deps.now();
      if (t - lastBeat <= deps.graceMs) {
        suspectSince = null;
        return false;
      }
      if (suspectSince === null || suspectSince < lastBeat || t < suspectSince) {
        suspectSince = t;
        return false;
      }
      return t - suspectSince >= deps.graceMs;
    },
  };
}
