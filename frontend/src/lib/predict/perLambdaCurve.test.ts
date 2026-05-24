import { describe, it, expect } from 'vitest';
import {
  fitPerLambdaCurve,
  applyPerLambdaCurve,
  runPerLambdaCurveTransfer,
} from './perLambdaCurve';
import { D50_PERFECT_WHITE } from '../colormath';

const L = 4;

describe('fitPerLambdaCurve', () => {
  it('recovers exact (A, B) pairs at anchor positions', () => {
    const k = 5;
    const A = new Float64Array(k * L);
    const B = new Float64Array(k * L);
    // Per λ: linear A vs B with different slope/intercept.
    const sl = [0.8, 0.6, 1.2, 0.9];
    const it = [0.05, 0.1, -0.05, 0.02];
    for (let i = 0; i < k; i++) {
      for (let l = 0; l < L; l++) {
        const x = 0.1 + 0.18 * i;
        A[i * L + l] = x;
        B[i * L + l] = sl[l] * x + it[l];
      }
    }
    const fit = fitPerLambdaCurve(A, B, L);
    // Apply at the anchors themselves — should be exact (within clamp).
    const pred = applyPerLambdaCurve(A, L, fit);
    for (let i = 0; i < k * L; i++) {
      expect(pred[i]).toBeCloseTo(B[i], 6);
    }
  });

  it('merges duplicate A values by averaging B', () => {
    // Three anchors at A=0.5: B values 0.4, 0.6, 0.5 → averaged B=0.5.
    const k = 3;
    const A = Float64Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const B = Float64Array.from([0.4, 0.4, 0.4, 0.4, 0.6, 0.6, 0.6, 0.6, 0.5, 0.5, 0.5, 0.5]);
    const fit = fitPerLambdaCurve(A, B, L);
    for (let l = 0; l < L; l++) {
      expect(fit.curvesA[l].length).toBe(1);
      expect(fit.curvesB[l][0]).toBeCloseTo(0.5, 6);
    }
    expect(fit.k).toBe(k);
  });

  it('clamps output to [0, 1] including extrapolation', () => {
    // Two anchors with a steep slope; extrapolate far beyond endpoints.
    const A = Float64Array.from([0.1, 0.2, 0.3, 0.4, 0.9, 0.8, 0.7, 0.6]);
    const B = Float64Array.from([0.05, 0.1, 0.15, 0.2, 0.45, 0.4, 0.35, 0.3]);
    const fit = fitPerLambdaCurve(A, B, L);

    const X = Float64Array.from([0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]);
    const pred = applyPerLambdaCurve(X, L, fit);
    for (let i = 0; i < pred.length; i++) {
      expect(pred[i]).toBeGreaterThanOrEqual(0);
      expect(pred[i]).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to constant offset when after dedup only 1 unique A per λ', () => {
    // Two anchors with identical A at each λ — dedup leaves 1 point per λ.
    // applyPerLambdaCurve must apply constant offset (B - A) for any input.
    const A = Float64Array.from([0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
    const B = Float64Array.from([0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6]);
    const fit = fitPerLambdaCurve(A, B, L);
    for (let l = 0; l < L; l++) {
      expect(fit.curvesA[l].length).toBe(1);
    }
    // For arbitrary input, expect output = input + 0.2 (clamped).
    const X = Float64Array.from([0.1, 0.1, 0.1, 0.1, 0.5, 0.5, 0.5, 0.5]);
    const pred = applyPerLambdaCurve(X, L, fit);
    expect(pred[0]).toBeCloseTo(0.3, 6);
    expect(pred[L]).toBeCloseTo(0.7, 6);
  });

  it('throws on k < 2', () => {
    const A = new Float64Array(L);
    const B = new Float64Array(L);
    expect(() => fitPerLambdaCurve(A, B, L)).toThrow(/k ≥ 2/);
  });
});

describe('runPerLambdaCurveTransfer', () => {
  it('low ΔE00 when target is monotone transform of ref at each λ', () => {
    const N = 20;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        const a = 0.1 + 0.04 * i + 0.01 * l;
        X_A[i * L + l] = a;
        // Non-affine but monotone: B = 0.9 · sqrt(A) + 0.05.
        X_B[i * L + l] = 0.9 * Math.sqrt(a) + 0.05;
      }
    }
    const sampleIds = Array.from({ length: N }, (_, i) => `s${i}`);
    const anchorIdx = [0, 4, 8, 12, 16, 19];

    const r = runPerLambdaCurveTransfer({
      X_A, X_B, sampleIds, anchorIdx, L,
      paperWP: D50_PERFECT_WHITE,
      refProfile: 'A', targetProfile: 'B',
    });

    expect(r.report.medianDE00).toBeLessThan(1.0);
    expect(r.report.k).toBe(6);
    expect(r.report.variant).toBe('C7_perLambdaCurve');
  });
});
