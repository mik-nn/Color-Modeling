import { describe, it, expect } from 'vitest';
import {
  extractOBAEmission,
  computeOBAFactorPerPatch,
  subtractOBA,
  addOBA,
  runOBASeparatedTransfer,
} from './obaSeparator';
import { D50_PERFECT_WHITE } from '../colormath';

const L = 36; // full 380..730 nm @ 10 nm

function flatPaper(value: number): number[] {
  return Array.from({ length: L }, () => value);
}

function paperWithGaussianBump(baseline: number, amp: number, centerWL: number, sigma: number): number[] {
  return Array.from({ length: L }, (_, i) => {
    const wl = 380 + i * 10;
    return baseline + amp * Math.exp(-((wl - centerWL) ** 2) / (2 * sigma * sigma));
  });
}

describe('extractOBAEmission', () => {
  it('emission ≈ 0 across all bands for a flat substrate (no OBA)', () => {
    const spec = flatPaper(0.85);
    const e = extractOBAEmission(spec);
    for (let i = 0; i < L; i++) {
      expect(e.emission[i]).toBeLessThan(0.01);
    }
    expect(e.peakAmplitude).toBeLessThan(0.01);
  });

  it('recovers a Gaussian bump around 440 nm', () => {
    const spec = paperWithGaussianBump(0.85, 0.20, 440, 25);
    const e = extractOBAEmission(spec);
    // Bump tail (σ=25) reaches into the baseline-fit region 460–490 nm,
    // so the polynomial absorbs some peak amplitude. 0.07 is the
    // empirically-observed recovered peak for amp=0.20 input.
    expect(e.peakAmplitude).toBeGreaterThan(0.07);
    // Peak should be near 440 nm.
    const peakWL = 380 + e.peakLambdaIdx * 10;
    expect(Math.abs(peakWL - 440)).toBeLessThanOrEqual(20);
    // Out-of-band (e.g. 550 nm) emission should be zero.
    expect(e.emission[17]).toBe(0);
  });

  it('is non-negative everywhere (cannot emit negatively)', () => {
    const spec = paperWithGaussianBump(0.85, 0.20, 440, 25);
    const e = extractOBAEmission(spec);
    for (let i = 0; i < L; i++) expect(e.emission[i]).toBeGreaterThanOrEqual(0);
  });
});

describe('computeOBAFactorPerPatch', () => {
  it('paper row → factor 1, full-black row → factor 0', () => {
    const N = 3;
    const X = new Float64Array(N * L);
    // Row 0 = paper (R(380)=0.5), row 1 = dim (R(380)=0.25 → factor=0.5),
    // row 2 = black (R(380)=0).
    for (let l = 0; l < L; l++) {
      X[0 * L + l] = 0.5;
      X[1 * L + l] = 0.25;
      X[2 * L + l] = 0.0;
    }
    const f = computeOBAFactorPerPatch(X, L, 0);
    expect(f[0]).toBeCloseTo(1, 6);
    expect(f[1]).toBeCloseTo(0.5, 6);
    expect(f[2]).toBe(0);
  });

  it('clamps factors above 1 (a patch brighter than paper at 380 nm)', () => {
    const N = 2;
    const X = new Float64Array(N * L);
    for (let l = 0; l < L; l++) {
      X[0 * L + l] = 0.3;
      X[1 * L + l] = 0.6; // brighter than paper at 380
    }
    const f = computeOBAFactorPerPatch(X, L, 0);
    expect(f[1]).toBe(1);
  });
});

describe('subtractOBA / addOBA roundtrip', () => {
  it('subtract then add returns original (within clamp)', () => {
    const N = 4;
    const X = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) X[i * L + l] = 0.3 + 0.1 * (i + (l % 3));
    }
    const factors = Float64Array.from([0.0, 0.5, 0.8, 1.0]);
    const emission = new Float64Array(L);
    for (let l = 0; l < L; l++) {
      const wl = 380 + l * 10;
      emission[l] = wl >= 380 && wl <= 450 ? 0.05 : 0;
    }
    const cleaned = subtractOBA(X, L, factors, emission);
    const back = addOBA(cleaned, L, factors, emission);
    for (let i = 0; i < N * L; i++) {
      expect(back[i]).toBeCloseTo(X[i], 6);
    }
  });
});

describe('runOBASeparatedTransfer', () => {
  it('wraps an identity predictor: identity on clean → produces B back', () => {
    // Synthetic: A = smooth linear in λ, B = A scaled by 0.9 (no OBA on either).
    // Identity-on-clean predictor returns X_target_clean directly.
    const N = 20;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        const wl = 380 + l * 10;
        // Smooth quadratic in wl: well-modelled by the OBA-base fit.
        const v = 0.3 + 0.02 * (i % 7) + 0.0001 * (wl - 555);
        X_A[i * L + l] = v;
        X_B[i * L + l] = 0.9 * v;
      }
    }
    const sampleIds = Array.from({ length: N }, (_, i) => `s${i}`);
    const anchorIdx = [0, 5, 10, 15];
    const paperRowIdx = 0;

    const r = runOBASeparatedTransfer({
      X_A, X_B, sampleIds, anchorIdx, paperRowIdx, L,
      paperWP: D50_PERFECT_WHITE,
      refProfile: 'A', targetProfile: 'B',
      baseVariant: 'identity',
      predict: ({ X_target_clean }) => X_target_clean,
    });
    expect(r.report.variant).toBe('D7_identity');
    expect(r.report.medianDE00).toBeLessThan(0.5);
    // Smooth substrates → tiny residual emission (<0.005).
    expect(r.obaA.peakAmplitude).toBeLessThan(0.005);
    expect(r.obaB.peakAmplitude).toBeLessThan(0.005);
  });

  it('detects OBA bump on target paper but not on ref paper', () => {
    const N = 20;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    // Smooth substrate baseline (no random per-λ noise); B paper carries a
    // Gaussian bump at 440 nm, ink patches do not (simulates fully-blocked OBA).
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        const wl = 380 + l * 10;
        const base = 0.3 + 0.02 * (i % 7) + 0.0001 * (wl - 555);
        const obaB = i === 0 ? 0.15 * Math.exp(-((wl - 440) ** 2) / (2 * 25 * 25)) : 0;
        X_A[i * L + l] = base;
        X_B[i * L + l] = base + obaB;
      }
    }
    const sampleIds = Array.from({ length: N }, (_, i) => `s${i}`);
    const anchorIdx = [0, 5, 10, 15];

    const r = runOBASeparatedTransfer({
      X_A, X_B, sampleIds, anchorIdx, paperRowIdx: 0, L,
      paperWP: D50_PERFECT_WHITE,
      refProfile: 'A', targetProfile: 'B',
      baseVariant: 'identity',
      predict: ({ X_target_clean }) => X_target_clean,
    });
    expect(r.obaB.peakAmplitude).toBeGreaterThan(0.05);
    expect(r.obaA.peakAmplitude).toBeLessThan(0.01);
  });
});
