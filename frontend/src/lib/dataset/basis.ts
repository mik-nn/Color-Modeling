// src/lib/dataset/basis.ts
//
// Tiny linear-algebra utilities for PCA over spectral data.
//
// The matrices we work with are at most N×L = 905×36 (one profile) or
// (27·905)×36 (pool). 36 is small, so an L×L Jacobi eigendecomposition is
// fine — no need for a heavy SVD library.
//
// Conventions:
//   - X is N×L row-major, rows = patches, cols = wavelengths.
//   - "Centering" subtracts the column mean (per-wavelength mean across patches).
//   - PCs are sorted by descending variance.
//   - V is L×p, columns are principal directions in λ space.

/** Row-major matrix helper: M[i][j] when stored as length-rows*cols Float64Array. */
function at(M: Float64Array, cols: number, i: number, j: number): number {
  return M[i * cols + j];
}
function setAt(M: Float64Array, cols: number, i: number, j: number, v: number): void {
  M[i * cols + j] = v;
}

/**
 * Column means of an N×L row-major matrix.
 */
export function columnMeans(X: Float64Array, N: number, L: number): Float64Array {
  const mean = new Float64Array(L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) mean[l] += X[i * L + l];
  }
  for (let l = 0; l < L; l++) mean[l] /= N;
  return mean;
}

/**
 * Center X in place against a precomputed per-column mean.
 */
export function centerInPlace(X: Float64Array, N: number, L: number, mean: Float64Array): void {
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) X[i * L + l] -= mean[l];
  }
}

/**
 * Covariance matrix L×L of an already-centered X.
 *
 * cov = (1 / (N-1)) · X^T · X.
 */
export function covariance(Xc: Float64Array, N: number, L: number): Float64Array {
  const C = new Float64Array(L * L);
  for (let i = 0; i < L; i++) {
    for (let j = i; j < L; j++) {
      let s = 0;
      for (let r = 0; r < N; r++) s += at(Xc, L, r, i) * at(Xc, L, r, j);
      const v = s / Math.max(1, N - 1);
      setAt(C, L, i, j, v);
      if (i !== j) setAt(C, L, j, i, v);
    }
  }
  return C;
}

/**
 * Symmetric Jacobi eigendecomposition.
 *
 * Returns eigenvectors as the columns of V (L×L row-major) and eigenvalues in
 * descending order. Converges quadratically near the solution; for L = 36 this
 * runs in a handful of milliseconds.
 */
export function jacobiEigen(
  A: Float64Array,
  L: number,
  maxSweeps = 100,
  tol = 1e-12,
): { values: Float64Array; vectors: Float64Array } {
  // Work copy so caller's A is preserved.
  const M = new Float64Array(A);
  const V = new Float64Array(L * L);
  for (let i = 0; i < L; i++) setAt(V, L, i, i, 1);

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < L - 1; i++) {
      for (let j = i + 1; j < L; j++) {
        const aij = at(M, L, i, j);
        off += aij * aij;
      }
    }
    if (off < tol) break;

    for (let p = 0; p < L - 1; p++) {
      for (let q = p + 1; q < L; q++) {
        const apq = at(M, L, p, q);
        if (Math.abs(apq) < 1e-15) continue;

        const app = at(M, L, p, p);
        const aqq = at(M, L, q, q);
        const theta = (aqq - app) / (2 * apq);
        const t = theta >= 0
          ? 1 / (theta + Math.sqrt(1 + theta * theta))
          : 1 / (theta - Math.sqrt(1 + theta * theta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        // Update M in place.
        setAt(M, L, p, p, app - t * apq);
        setAt(M, L, q, q, aqq + t * apq);
        setAt(M, L, p, q, 0);
        setAt(M, L, q, p, 0);

        for (let r = 0; r < L; r++) {
          if (r !== p && r !== q) {
            const arp = at(M, L, r, p);
            const arq = at(M, L, r, q);
            setAt(M, L, r, p, c * arp - s * arq);
            setAt(M, L, p, r, c * arp - s * arq);
            setAt(M, L, r, q, s * arp + c * arq);
            setAt(M, L, q, r, s * arp + c * arq);
          }
          const vrp = at(V, L, r, p);
          const vrq = at(V, L, r, q);
          setAt(V, L, r, p, c * vrp - s * vrq);
          setAt(V, L, r, q, s * vrp + c * vrq);
        }
      }
    }
  }

  const values = new Float64Array(L);
  for (let i = 0; i < L; i++) values[i] = at(M, L, i, i);

  // Sort eigenpairs by eigenvalue, descending.
  const order = Array.from({ length: L }, (_, i) => i).sort((a, b) => values[b] - values[a]);
  const sortedValues = new Float64Array(L);
  const sortedVectors = new Float64Array(L * L);
  for (let k = 0; k < L; k++) {
    const src = order[k];
    sortedValues[k] = values[src];
    for (let r = 0; r < L; r++) setAt(sortedVectors, L, r, k, at(V, L, r, src));
  }

  return { values: sortedValues, vectors: sortedVectors };
}

export interface PCABasis {
  /** Per-wavelength mean used to center; subtract before projection. */
  mean: Float64Array;
  /** L×p (row-major) — columns are principal directions. */
  V: Float64Array;
  /** p eigenvalues, descending. Variance explained by each PC. */
  eigenvalues: Float64Array;
  L: number;
  p: number;
}

/**
 * Fit a PCA basis to an N×L row-major matrix.
 *
 * `p` defaults to L (keep all directions). Pass a smaller p to truncate.
 */
export function fitPCA(X: Float64Array, N: number, L: number, p?: number): PCABasis {
  if (N < 2) throw new Error(`fitPCA: need N ≥ 2, got ${N}`);
  if (p !== undefined && (p < 1 || p > L)) {
    throw new Error(`fitPCA: p must be in [1, ${L}], got ${p}`);
  }
  const pKeep = p ?? L;

  const mean = columnMeans(X, N, L);
  const Xc = new Float64Array(X);
  centerInPlace(Xc, N, L, mean);

  const cov = covariance(Xc, N, L);
  const eig = jacobiEigen(cov, L);

  // Truncate to top-p eigenpairs.
  const V = new Float64Array(L * pKeep);
  for (let r = 0; r < L; r++) {
    for (let c = 0; c < pKeep; c++) {
      setAt(V, pKeep, r, c, at(eig.vectors, L, r, c));
    }
  }
  const eigenvalues = eig.values.slice(0, pKeep);

  return { mean, V, eigenvalues, L, p: pKeep };
}

/**
 * Project rows of X (N×L) into the basis. Returns Z (N×p).
 *
 * Z[i, :] = (X[i, :] - mean) · V
 */
export function pcaProject(X: Float64Array, N: number, basis: PCABasis): Float64Array {
  const { mean, V, L, p } = basis;
  const Z = new Float64Array(N * p);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < p; c++) {
      let s = 0;
      for (let l = 0; l < L; l++) {
        s += (X[i * L + l] - mean[l]) * V[l * p + c];
      }
      Z[i * p + c] = s;
    }
  }
  return Z;
}

/**
 * Reconstruct X̂ (N×L) from PC scores Z (N×p).
 *
 * X̂[i, :] = Z[i, :] · V^T + mean
 */
export function pcaReconstruct(Z: Float64Array, N: number, basis: PCABasis): Float64Array {
  const { mean, V, L, p } = basis;
  const X = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) {
      let s = mean[l];
      for (let c = 0; c < p; c++) s += Z[i * p + c] * V[l * p + c];
      X[i * L + l] = s;
    }
  }
  return X;
}

/**
 * Fraction of total variance explained by each PC.
 */
export function varianceExplained(basis: PCABasis): Float64Array {
  let total = 0;
  for (const v of basis.eigenvalues) total += Math.max(0, v);
  const out = new Float64Array(basis.p);
  if (total <= 0) return out;
  for (let i = 0; i < basis.p; i++) out[i] = Math.max(0, basis.eigenvalues[i]) / total;
  return out;
}

/**
 * Build a "pool" PCA basis by concatenating matrices from multiple profiles
 * (each N_k × L) row-wise into one big matrix, then fitting PCA.
 *
 * Use case: hypothesis H7 in docs/RESEARCH_HYPOTHESIS.md — does a basis built
 * over the entire substrate pool generalise better than a single-profile basis?
 */
export function fitPoolPCA(matrices: Float64Array[], rowCounts: number[], L: number, p?: number): PCABasis {
  if (matrices.length === 0) throw new Error('fitPoolPCA: no matrices supplied');
  if (matrices.length !== rowCounts.length) {
    throw new Error('fitPoolPCA: matrices and rowCounts length mismatch');
  }

  let totalRows = 0;
  for (const r of rowCounts) totalRows += r;

  const Xall = new Float64Array(totalRows * L);
  let cursor = 0;
  for (let i = 0; i < matrices.length; i++) {
    const M = matrices[i];
    const N = rowCounts[i];
    if (M.length !== N * L) {
      throw new Error(`fitPoolPCA: matrix ${i} length ${M.length} ≠ N·L = ${N * L}`);
    }
    Xall.set(M, cursor * L);
    cursor += N;
  }

  return fitPCA(Xall, totalRows, L, p);
}
