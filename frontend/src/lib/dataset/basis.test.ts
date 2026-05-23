import { describe, it, expect } from 'vitest';
import {
  jacobiEigen,
  fitPCA,
  pcaProject,
  pcaReconstruct,
  varianceExplained,
  fitPoolPCA,
} from './basis';

function maxAbsDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('jacobiEigen', () => {
  it('diagonalises a symmetric 3×3 matrix', () => {
    // Eigenvalues of [[2,0,0],[0,3,0],[0,0,5]] = [5, 3, 2] (sorted desc).
    const A = Float64Array.from([2, 0, 0, 0, 3, 0, 0, 0, 5]);
    const { values, vectors } = jacobiEigen(A, 3);
    expect(values[0]).toBeCloseTo(5, 8);
    expect(values[1]).toBeCloseTo(3, 8);
    expect(values[2]).toBeCloseTo(2, 8);
    // Columns of vectors are eigenvectors; orthonormal.
    for (let c = 0; c < 3; c++) {
      let norm = 0;
      for (let r = 0; r < 3; r++) norm += vectors[r * 3 + c] ** 2;
      expect(norm).toBeCloseTo(1, 8);
    }
  });

  it('diagonalises a dense symmetric 4×4 matrix', () => {
    // Construct A = Q D Q^T with known D so we can check eigenvalues.
    const A = Float64Array.from([
      4, 1, 0, 0,
      1, 3, 1, 0,
      0, 1, 2, 1,
      0, 0, 1, 1,
    ]);
    const { values, vectors } = jacobiEigen(A, 4);
    // Verify A v = λ v for the leading eigenpair.
    const lead = new Float64Array(4);
    for (let r = 0; r < 4; r++) lead[r] = vectors[r * 4 + 0];
    const Av = new Float64Array(4);
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let c = 0; c < 4; c++) s += A[r * 4 + c] * lead[c];
      Av[r] = s;
    }
    for (let r = 0; r < 4; r++) {
      expect(Av[r]).toBeCloseTo(values[0] * lead[r], 6);
    }
  });
});

describe('PCA round-trip', () => {
  it('reconstructs exactly when keeping all components', () => {
    const N = 20, L = 5;
    const X = new Float64Array(N * L);
    let seed = 1;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < N * L; i++) X[i] = rand();

    const basis = fitPCA(X, N, L);
    expect(basis.p).toBe(L);

    const Z = pcaProject(X, N, basis);
    const Xrec = pcaReconstruct(Z, N, basis);
    expect(maxAbsDiff(X, Xrec)).toBeLessThan(1e-9);
  });

  it('captures most variance with few components on a low-rank signal', () => {
    // Rank-2 underlying signal + tiny noise.
    const N = 50, L = 8;
    const X = new Float64Array(N * L);
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const v = Math.sin(2 * Math.PI * u);
      for (let l = 0; l < L; l++) {
        const a = l / L;
        X[i * L + l] = (3 * u + 2) * (1 + 0.2 * a) + v * (0.5 - 0.05 * a) + 1e-4;
      }
    }
    const basis = fitPCA(X, N, L, 2);
    const ve = varianceExplained(basis);
    let cum = 0;
    for (const v of ve) cum += v;
    expect(cum).toBeGreaterThan(0.99);

    const Z = pcaProject(X, N, basis);
    const Xrec = pcaReconstruct(Z, N, basis);
    // Per-element reconstruction should be tight.
    expect(maxAbsDiff(X, Xrec)).toBeLessThan(5e-3);
  });
});

describe('fitPoolPCA', () => {
  it('concatenates matrices then fits PCA', () => {
    const L = 4;
    const M1 = Float64Array.from([1, 2, 3, 4, 2, 3, 4, 5]); // 2 rows
    const M2 = Float64Array.from([3, 4, 5, 6]);             // 1 row
    const basis = fitPoolPCA([M1, M2], [2, 1], L);
    expect(basis.L).toBe(L);
    expect(basis.p).toBe(L);
    expect(basis.eigenvalues.length).toBe(L);
  });

  it('rejects mismatched row counts', () => {
    const L = 3;
    const M = Float64Array.from([1, 2, 3, 4, 5, 6]); // 2 rows
    expect(() => fitPoolPCA([M], [3], L)).toThrow();
  });
});
