import { describe, expect, test } from 'bun:test';
import { createWatchdog } from '../src/server/watchdog';
import type { Instant } from '../src/shared/domain';
import { T0 } from './support';

const GRACE = 30_000;

function harness() {
  let t: number = T0;
  const dog = createWatchdog({ now: () => t as Instant, graceMs: GRACE });
  return {
    dog,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('watchdog', () => {
  test('timers beating every second are alive', () => {
    const { dog, advance } = harness();
    for (let i = 0; i < 120; i++) {
      advance(1_000);
      dog.beat();
      expect(dog.timersDead()).toBe(false);
    }
  });

  test('timers that never fire again after a sleep are declared dead once the grace window passes', () => {
    const { dog, advance } = harness();
    dog.beat();
    advance(2 * 24 * 3_600_000);
    expect(dog.timersDead()).toBe(false);
    advance(GRACE - 2_000);
    expect(dog.timersDead()).toBe(false);
    advance(2_000);
    expect(dog.timersDead()).toBe(true);
  });

  test('a wake where timers catch up within the grace window is not a restart', () => {
    const { dog, advance } = harness();
    dog.beat();
    advance(2 * 24 * 3_600_000);
    expect(dog.timersDead()).toBe(false);
    advance(1_500);
    dog.beat();
    for (let i = 0; i < 60; i++) {
      advance(1_000);
      dog.beat();
      expect(dog.timersDead()).toBe(false);
    }
  });

  test('a second stall after a recovery gets its own grace window', () => {
    const { dog, advance } = harness();
    dog.beat();
    advance(10 * 60_000);
    expect(dog.timersDead()).toBe(false);
    advance(1_000);
    dog.beat();
    advance(10 * 60_000);
    expect(dog.timersDead()).toBe(false);
    advance(GRACE);
    expect(dog.timersDead()).toBe(true);
  });

  test('a wall clock stepping backwards is not a stall', () => {
    const { dog, advance } = harness();
    dog.beat();
    advance(-5 * 60_000);
    expect(dog.timersDead()).toBe(false);
    advance(GRACE * 2);
    expect(dog.timersDead()).toBe(false);
  });
});
