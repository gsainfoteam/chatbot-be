import { describe, expect, it } from '@jest/globals';
import { parseFiniteNumber } from './parse-finite-number';

describe('parseFiniteNumber', () => {
  it('returns parsed number when finite', () => {
    expect(parseFiniteNumber('120', 60)).toBe(120);
    expect(parseFiniteNumber(42, 0)).toBe(42);
  });

  it('falls back for NaN / non-numeric / undefined', () => {
    expect(parseFiniteNumber('abc', 500)).toBe(500);
    expect(parseFiniteNumber('120s', 120)).toBe(120);
    expect(parseFiniteNumber(undefined, 2000)).toBe(2000);
    expect(parseFiniteNumber(NaN, 1)).toBe(1);
  });

  it('applies min/max after resolving a finite value', () => {
    expect(parseFiniteNumber('0', 1, { min: 1 })).toBe(1);
    expect(parseFiniteNumber('999', 1, { max: 10 })).toBe(10);
    expect(parseFiniteNumber('0.5', 0.1, { min: 0, max: 1 })).toBe(0.5);
  });

  it('clamps the fallback when the input is invalid', () => {
    expect(parseFiniteNumber('nope', -5, { min: 1 })).toBe(1);
  });
});
