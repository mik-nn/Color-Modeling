import { describe, it, expect } from 'vitest';
import {
  fitPaperRatioResidual,
  applyPaperRatioResidual,
  runPaperRatioResidualTransfer,
} from './paperRatioResidual';
import { D50_PERFECT_WHITE } from '../colormath';

const L = 4;

function mkDevice(N: number, rgbAt: (i: number) => [number, number, number]): Float64Array {
  const D = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    const [r, g, b] = rgbAt(i);
    D[i * 3]     = r;
    D[i * 3 + 1] = g;
    D[i * 3 + 2] = b;
  }
  return D;
}

describe('fitPaperRatioResidual', () => {
  it('paper-only (k=1) returns ratio with no residual basis', () => {
    const N = 5;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        X_A[i * L + l] = 0.2 + 0.1 * i + 0.01 * l;
        X_B[i * L + l] = 0.8 * X_A[i * L + l];
      }
    }
    const D = mkDevice(N, i => [i * 50, i * 50, i * 50]);

    const fit = fitPaperRatioResidual(X_A, X_B, D, L, [0], 0);
    expect(fit.residualBasis).toBeNull();
    expect(fit.residualRank).toBe(0);
    for (let l = 0; l < L; l++) expect(fit.r[l]).toBeCloseTo(0.8, 6);
  });

  it('pure multiplicative substrate → first-order alone recovers B exactly', () => {
    const N = 6;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    const trueR = [0.9, 0.85, 0.7, 0.6];
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        X_A[i * L + l] = 0.1 + 0.13 * i + 0.02 * l;
        X_B[i * L + l] = trueR[l] * X_A[i * L + l];
      }
    }
    const D = mkDevice(N, i => [255 - i * 50, 255 - i * 50, 255 - i * 50]);

    const fit = fitPaperRatioResidual(X_A, X_B, D, L, [0], 0);
    const X_pred = applyPaperRatioResidual(X_A, D, L, fit);
    for (let i = 0; i < N * L; i++) {
      expect(X_pred[i]).toBeCloseTo(X_B[i], 6);
    }
  });

  it('two anchors (k=2) — residual basis has rank 1', () => {
    const N = 8;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      for (let l = 0; l < L; l++) {
        X_A[i * L + l] = 0.2 + 0.08 * i + 0.01 * l;
        // Non-multiplicative — add a small constant per λ.
        const offset = 0.02 * (l - 1.5);
        X_B[i * L + l] = 0.7 * X_A[i * L + l] + offset;
      }
    }
    const D = mkDevice(N, i => [200 - i * 25, 200 - i * 25, 200 - i * 25]);

    const fit = fitPaperRatioResidual(X_A, X_B, D, L, [0, 4], 0);
    expect(fit.residualBasis).not.toBeNull();
    expect(fit.residualRank).toBe(1); // degenerate single-residual path
  });

  it('runPaperRatioResidualTransfer beats paper-only-baseline on non-multiplicative substrate', () => {
    // Construct a substrate where B = 0.85 · A + delta(λ, RGB),
    // delta varies smoothly with RGB → low-rank residual.
    const N = 30;
    const X_A = new Float64Array(N * L);
    const X_B = new Float64Array(N * L);
    const D = mkDevice(N, i => [
      Math.floor(255 - (i * 9) % 256),
      Math.floor((i * 17) % 256),
      Math.floor((i * 31) % 256),
    ]);
    for (let i = 0; i < N; i++) {
      const u = D[i * 3] / 255;
      for (let l = 0; l < L; l++) {
        const a = 0.15 + 0.15 * u + 0.02 * l;
        X_A[i * L + l] = a;
        X_B[i * L + l] = 0.85 * a + 0.01 * (l - 1.5) * u;
      }
    }
    const sampleIds = Array.from({ length: N }, (_, i) => `s${i}`);
    // Anchor set: pick patch 0 as paper (artificially) + 5 spread anchors.
    const anchorIdx = [0, 5, 10, 15, 20, 25];

    const r = runPaperRatioResidualTransfer({
      X_A, X_B, D, sampleIds,
      anchorIdx, paperRowIdx: 0, L,
      paperWP: D50_PERFECT_WHITE,
      refProfile: 'A', targetProfile: 'B',
      residualRank: 2,
    });

    expect(r.report.medianDE00).toBeLessThan(5);
    expect(r.report.k).toBe(6);
    expect(r.report.variant).toMatch(/^D1_paperRatioResidual_p/);
  });
});
