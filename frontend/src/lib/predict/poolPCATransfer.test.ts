import { describe, it, expect } from 'vitest';
import { fitPoolBasis, runPoolPCATransfer } from './poolPCATransfer';
import { D50_PERFECT_WHITE } from '../colormath';

const L = 8;

function mkSpectraMatrix(N: number, L: number, gen: (i: number, l: number) => number): Float64Array {
  const M = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) M[i * L + l] = gen(i, l);
  }
  return M;
}

describe('fitPoolBasis', () => {
  it('builds a basis spanning multiple profiles', () => {
    const M1 = mkSpectraMatrix(10, L, (i, l) => 0.1 + 0.05 * i + 0.02 * l);
    const M2 = mkSpectraMatrix(8, L, (i, l) => 0.2 + 0.04 * i + 0.01 * l);
    const basis = fitPoolBasis({
      matrices: [M1, M2],
      rowCounts: [10, 8],
      L, p: 4,
    });
    expect(basis.L).toBe(L);
    expect(basis.p).toBe(4);
    expect(basis.eigenvalues.length).toBe(4);
    expect(basis.eigenvalues[0]).toBeGreaterThan(basis.eigenvalues[3]);
  });
});

describe('runPoolPCATransfer', () => {
  it('predicts target from ref via pool-basis diagonal mapping', () => {
    // Build 4 synthetic profiles all from the same low-rank generator with
    // per-profile substrate transforms in PC space.
    const N = 30;
    const profiles: Float64Array[] = [];
    for (let p = 0; p < 4; p++) {
      const scale = 0.9 + 0.05 * p;
      const offset = 0.02 * p;
      profiles.push(mkSpectraMatrix(N, L, (i, l) => {
        const u = i / N;
        const v = (l / L);
        const base = 0.2 + 0.5 * u * (1 + 0.3 * v) + Math.sin(2 * Math.PI * u) * (0.1 - 0.02 * l);
        return scale * base + offset;
      }));
    }

    const basis = fitPoolBasis({
      matrices: profiles, rowCounts: [N, N, N, N], L, p: 3,
    });

    // Ref + target chosen from the same family with slightly different params.
    const X_ref = mkSpectraMatrix(N, L, (i, l) => {
      const u = i / N;
      const v = (l / L);
      return 0.2 + 0.5 * u * (1 + 0.3 * v) + Math.sin(2 * Math.PI * u) * (0.1 - 0.02 * l);
    });
    const X_target = mkSpectraMatrix(N, L, (i, l) => {
      const u = i / N;
      const v = (l / L);
      return 0.18 + 0.48 * u * (1 + 0.28 * v) + Math.sin(2 * Math.PI * u) * (0.09 - 0.018 * l);
    });

    const sampleIds = Array.from({ length: N }, (_, i) => `s${i}`);
    const anchorIdx = [0, 5, 10, 15, 20, 25, 29];

    const r = runPoolPCATransfer({
      basis, X_ref, X_target, sampleIds, anchorIdx, L,
      paperWP: D50_PERFECT_WHITE,
      refProfile: 'ref', targetProfile: 'target',
    });

    expect(r.report.variant).toMatch(/^B3_poolPCA_p/);
    expect(r.report.k).toBe(7);
    expect(r.report.nTest).toBe(N - 7);
    expect(r.report.medianDE00).toBeLessThan(2.0);
    expect(r.s.length).toBe(3);
    expect(r.b.length).toBe(3);
    expect(r.rSquaredPerPC.length).toBe(3);
  });

  it('throws on shape mismatches and k < 2', () => {
    const basis = fitPoolBasis({
      matrices: [mkSpectraMatrix(10, L, () => 0.5)], rowCounts: [10], L, p: 3,
    });
    const X = new Float64Array(L * 5);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(() => runPoolPCATransfer({
      basis, X_ref: X, X_target: X, sampleIds: ids, anchorIdx: [0], L,
      paperWP: D50_PERFECT_WHITE, refProfile: 'r', targetProfile: 't',
    })).toThrow(/k ≥ 2/);

    expect(() => runPoolPCATransfer({
      basis, X_ref: new Float64Array(L * 4), X_target: X,
      sampleIds: ids, anchorIdx: [0, 1], L,
      paperWP: D50_PERFECT_WHITE, refProfile: 'r', targetProfile: 't',
    })).toThrow(/X_ref shape/);
  });
});
