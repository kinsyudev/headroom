import { describe, expect, test } from 'bun:test';
import { readDelta } from '../src/ui/components/charts/deltaRule';

describe('one rule colours every delta', () => {
  test('volume stays neutral however far it moves', () => {
    expect(readDelta(0.2, null)).toEqual({ direction: 'up', tone: 'neutral' });
    expect(readDelta(-0.6, null)).toEqual({ direction: 'down', tone: 'neutral' });
  });

  test('a clear move of a figure with a better direction is good or bad by that direction', () => {
    expect(readDelta(0.02, 'up')).toEqual({ direction: 'up', tone: 'good' });
    expect(readDelta(-0.02, 'up')).toEqual({ direction: 'down', tone: 'bad' });
    expect(readDelta(-0.05, 'down')).toEqual({ direction: 'down', tone: 'good' });
    expect(readDelta(0.05, 'down')).toEqual({ direction: 'up', tone: 'bad' });
  });

  test('a move under a point keeps its arrow and stays neutral, because it is not clearly good or bad', () => {
    expect(readDelta(0.002, 'up', 0.0005)).toEqual({ direction: 'up', tone: 'neutral' });
    expect(readDelta(-0.009, 'up', 0.0005)).toEqual({ direction: 'down', tone: 'neutral' });
  });

  test('a move below the flat line has no direction and no colour', () => {
    expect(readDelta(0.001, 'up')).toEqual({ direction: 'flat', tone: 'neutral' });
    expect(readDelta(0, 'down')).toEqual({ direction: 'flat', tone: 'neutral' });
  });
});
