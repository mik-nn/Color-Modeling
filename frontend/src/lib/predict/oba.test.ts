import { describe, it, expect } from 'vitest';
import { detectOBA, obaMismatch, obaMismatchSeverity } from './oba';

// 36 bands, 380..730 nm @ 10 nm
function flat(value: number): number[] {
  return Array.from({ length: 36 }, () => value);
}

function withOBAPeak(baseline: number, peakAt440: number): number[] {
  // Synthetic: flat baseline with a Gaussian-ish bump centred at 440 nm.
  const spectrum = flat(baseline);
  for (let i = 0; i < 36; i++) {
    const wl = 380 + i * 10;
    const k = Math.exp(-((wl - 440) ** 2) / (2 * 25 * 25)); // σ = 25 nm
    spectrum[i] = baseline + peakAt440 * k;
  }
  return spectrum;
}

describe('detectOBA', () => {
  it('flat spectrum (no fluorescence) → score ≈ 1.0, hasOBA = false', () => {
    const r = detectOBA(flat(0.85));
    expect(r.score).toBeCloseTo(1.0, 6);
    expect(r.hasOBA).toBe(false);
    expect(r.r380).toBeCloseTo(0.85, 6);
    expect(r.r440).toBeCloseTo(0.85, 6);
    expect(r.r550).toBeCloseTo(0.85, 6);
  });

  it('synthetic spectrum with 440 nm bump → score > 1.1', () => {
    const r = detectOBA(withOBAPeak(0.85, 0.20));
    expect(r.score).toBeGreaterThan(1.1);
    expect(r.hasOBA).toBe(true);
    expect(r.r440).toBeGreaterThan(r.r550);
  });

  it('throws on too-short spectrum', () => {
    expect(() => detectOBA([0.5, 0.5, 0.5])).toThrow(/too short/);
  });

  it('throws on wavelength out of range', () => {
    expect(() => detectOBA(flat(0.5), { startWL: 600 })).toThrow(/out of range/);
  });
});

describe('obaMismatch', () => {
  it('symmetric and absolute', () => {
    const a = detectOBA(flat(0.85));
    const b = detectOBA(withOBAPeak(0.5, 0.4));
    expect(obaMismatch(a, b)).toBeCloseTo(obaMismatch(b, a), 8);
    expect(obaMismatch(a, b)).toBeGreaterThan(0);
  });

  it('zero when both profiles match', () => {
    const a = detectOBA(flat(0.85));
    const b = detectOBA(flat(0.65));
    // Different reflectance levels but both flat → both score ≈ 1.0 → mismatch ≈ 0.
    expect(obaMismatch(a, b)).toBeCloseTo(0, 6);
  });
});

describe('obaMismatchSeverity', () => {
  it('buckets the mismatch into low / moderate / high', () => {
    expect(obaMismatchSeverity(0.02)).toBe('low');
    expect(obaMismatchSeverity(0.05)).toBe('low');
    expect(obaMismatchSeverity(0.10)).toBe('moderate');
    expect(obaMismatchSeverity(0.15)).toBe('moderate');
    expect(obaMismatchSeverity(0.16)).toBe('high');
    expect(obaMismatchSeverity(0.5)).toBe('high');
  });
});
