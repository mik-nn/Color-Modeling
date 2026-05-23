import { describe, it, expect } from 'vitest';
import { fitPerLambdaAffine, applyPerLambdaAffine, runPerLambdaAffineTransfer } from './perLambdaAffine';
import { D50_PERFECT_WHITE } from '../colormath';

const L = 4;

describe('fitPerLambdaAffine', () => {
  it('recovers exact slope+intercept when B is an affine transform of A', () => {
    const k = 10;
    const A = new Float64Array(k * L);
    const B = new Float64Array(k * L);
    const trueA = [0.8, 0.6, 1.2, 0.9];
    const trueB = [0.05, 0.1, -0.05, 0.02];
    for (let i = 0; i < k; i++) {
      for (let l = 0; l < L; l++) {
        const x = 0.1 + (i / k) * 0.8;
        A[i * L + l] = x;
        B[i * L + l] = trueA[l] * x + trueB[l];
      }
    }
    const fit = fitPerLambdaAffine(A, B, L);
    for (let l = 0; l < L; l++) {
      expect(fit.a[l]).toBeCloseTo(trueA[l], 6);
      expect(fit.b[l]).toBeCloseTo(trueB[l], 6);
      expect(fit.rSquaredPerLambda[l]).toBeCloseTo(1, 6);
    }
  });

  it('falls back to a=1 + offset when A is constant at a wavelength', () => {
    const k = 4;
    const A = new Float64Array(k * L);
    const B = new Float64Array(k * L);
    // Wavelength 0: A constant at 0.5; B at 0.6 → expect a=1, b=0.1.
    for (let i = 0; i < k; i++) {
      A[i * L + 0] = 0.5;
      B[i * L + 0] = 0.6;
      for (let l = 1; l < L; l++) {
        A[i * L + l] = 0.1 + 0.2 * i;
        B[i * L + l] = 0.1 + 0.2 * i;
      }
    }
    const fit = fitPerLambdaAffine(A, B, L);
    expect(fit.a[0]).toBeCloseTo(1, 6);
    expect(fit.b[0]).toBeCloseTo(0.1, 6);
  });

  it('throws on shape mismatch and k < 2', () => {
    const A = new Float64Array(4);
    const B = new Float64Array(8);
    expect(() => fitPerLambdaAffine(A, B, L)).toThrow(/shape/);
    const A1 = new Float64Array(L);
    const B1 = new Float64Array(L);
    expect(() => fitPerLambdaAffine(A1, B1, L)).toThrow(/k ≥ 2/);
  });
});

describe('applyPerLambdaAffine', () => {
  it('clamps output to [0, 1]', () => {
    const fit = {
      a: Float64Array.from([2, 2, 2, 2]),
      b: Float64Array.from([0.5, 0.5, 0.5, 0.5]),
      rSquaredPerLambda: Float64Array.from([1, 1, 1, 1]),
      k: 2,
    };
    const X = Float64Array.from([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.0]);
    const out = applyPerLambdaAffine(X, L, fit);
    // 2*0.9 + 0.5 = 2.3 → clamped to 1.
    expect(out[0]).toBe(1);
    // 2*0 + 0.5 = 0.5.
    expect(out[L]).toBeCloseTo(0.5, 6);
  });
});

describe('runPerLambdaAffineTransfer', () => {
  it('produces low ΔE00 when target = identity affine of ref', () => {
    const N = 20;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        const v = 0.1 + 0.04 * i + 0.01 * l;
        X_A[i * L + l] = v;
        X_B[i * L + l] = 0.95 * v + 0.02;
      }
    }
    const sampleIds = Array.from({ length: N }, (_, i) => `s${i}`);
    const anchorIdx = [0, 4, 8, 12, 16]; // 5 anchors evenly spread

    const r = runPerLambdaAffineTransfer({
      X_A, X_B, sampleIds, anchorIdx,
      L,
      paperWP: D50_PERFECT_WHITE,
      refProfile: 'A', targetProfile: 'B',
    });
    expect(r.report.medianDE00).toBeLessThan(1.0);
    expect(r.report.k).toBe(5);
    expect(r.report.nTest).toBe(N - 5);
    expect(r.report.variant).toBe('A3_perLambdaAffine');
  });
});
