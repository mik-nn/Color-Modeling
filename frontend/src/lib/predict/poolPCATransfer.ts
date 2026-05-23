// src/lib/predict/poolPCATransfer.ts
//
// B3 — Pool-PCA transfer with diagonal score mapping from a reference profile.
//
// Builds a PCA basis from the concatenated spectra of all available substrate
// profiles (the "pool"). The reference profile is fully known; the target
// profile is known only at k anchors. We:
//
//   1. Pool basis = SVD over (Σ profiles) × L matrix → V (L×p), mean (L).
//   2. Project the entire reference profile into the basis → Z_A (N × p).
//   3. Project target anchor spectra → Z_B_anchors (k × p).
//   4. Per PC dimension, fit a 1-D affine map on the anchors:
//        Z_B[i, c] ≈ s[c] · Z_A[i, c] + b[c]
//      via OLS (2p free parameters total).
//   5. Apply: Ẑ_B = diag(s) · Z_A + b (N × p), then reconstruct → spectra.
//   6. Clamp to [0, 1] and evaluate on the non-anchor subset.
//
// Pros: lower-variance than per-profile PCA on small k because the basis
//   already encodes cross-substrate axes (OBA, ink-paper optics, surface
//   scatter). The diagonal mapping costs only 2p params (e.g. 12 for p=6)
//   and is well-conditioned even with k = 13 anchors.
// Cons: assumes the substrate transform decouples in the pool's PC basis
//   (no cross-PC coupling). If it does not, residuals persist; a future
//   "full M" variant could absorb them at a 6× parameter cost.
//
// Why not pure RGB-kNN of scores: with 13 sparse anchors, a kNN-RGB-only
// interpolator of (k × p) scores has no idea what to do for the bulk of
// the 905 patches. The reference profile carries that information.

import type { PredictionReport, WhitePointXYZ } from '../../types';
import { evaluatePrediction } from '../dataset/evaluate';
import {
  fitPoolPCA,
  pcaProject,
  pcaReconstruct,
  type PCABasis,
} from '../dataset/basis';

// kNN interpolation no longer used in the canonical B3 (kept as dead code-
// adjacent reference) — see the file header for why the score-space-only
// approach failed empirically with 13 sparse anchors.

export interface PoolBasisInput {
  /** Per-profile N×L spectral matrices (row-major). */
  matrices: Float64Array[];
  /** Row counts for each matrix in the same order. */
  rowCounts: number[];
  /** Wavelength count. */
  L: number;
  /** Requested basis rank. Default 6. */
  p?: number;
}

/**
 * Build the pool basis once per session.
 *
 * Use case: cache this in the UI store; per-target prediction reuses the
 * same basis without re-running SVD.
 */
export function fitPoolBasis(input: PoolBasisInput): PCABasis {
  const p = input.p ?? 6;
  return fitPoolPCA(input.matrices, input.rowCounts, input.L, p);
}

/**
 * Per-dimension OLS on anchors: find s[c] and b[c] minimising
 * Σ_i (Z_B[i, c] - (s[c] * Z_A[i, c] + b[c]))² for each PC dimension c.
 *
 * Returns (s, b) each of length p. Falls back to s=1, b=mean(B)-mean(A)
 * when the anchor variance at a given PC is degenerate (rare; safe).
 */
function fitDiagonalScoreMap(
  Z_A_anchors: Float64Array,
  Z_B_anchors: Float64Array,
  p: number,
): { s: Float64Array; b: Float64Array; rSquaredPerPC: Float64Array } {
  const k = Z_A_anchors.length / p;
  if (k < 2) throw new Error(`fitDiagonalScoreMap: need k ≥ 2 anchors, got ${k}`);
  const s = new Float64Array(p);
  const b = new Float64Array(p);
  const r2 = new Float64Array(p);
  for (let c = 0; c < p; c++) {
    let sumA = 0, sumB = 0;
    for (let i = 0; i < k; i++) {
      sumA += Z_A_anchors[i * p + c];
      sumB += Z_B_anchors[i * p + c];
    }
    const meanA = sumA / k;
    const meanB = sumB / k;
    let covAB = 0, varA = 0, varB = 0;
    for (let i = 0; i < k; i++) {
      const dA = Z_A_anchors[i * p + c] - meanA;
      const dB = Z_B_anchors[i * p + c] - meanB;
      covAB += dA * dB;
      varA += dA * dA;
      varB += dB * dB;
    }
    if (varA < 1e-12) {
      s[c] = 1;
      b[c] = meanB - meanA;
      r2[c] = 0;
    } else {
      s[c] = covAB / varA;
      b[c] = meanB - s[c] * meanA;
      r2[c] = varB > 0 ? (covAB * covAB) / (varA * varB) : 0;
    }
  }
  return { s, b, rSquaredPerPC: r2 };
}

export interface PoolPCATransferInput {
  /** Pre-fit pool basis (built from many profiles, ideally not including the target). */
  basis: PCABasis;
  /** Full reference spectral matrix N×L — fully known. */
  X_ref: Float64Array;
  /** Full target spectral matrix N×L (ground truth; only anchor rows are used to fit). */
  X_target: Float64Array;
  /** Sample IDs (length N) for the report. */
  sampleIds: string[];
  /** Row indices of anchor patches (positions known on both ref and target). */
  anchorIdx: number[] | Int32Array;
  /** Wavelength count. */
  L: number;
  /** Paper-relative white point for ΔE00. */
  paperWP: WhitePointXYZ;
  /** Reference profile filename for the report. */
  refProfile: string;
  /** Target profile filename for the report. */
  targetProfile: string;
}

export interface PoolPCATransferResult {
  /** Diagonal slope per PC dimension (length p). */
  s: Float64Array;
  /** Diagonal intercept per PC dimension (length p). */
  b: Float64Array;
  /** Per-PC R² of the diagonal fit on the anchors. */
  rSquaredPerPC: Float64Array;
  /** Predicted spectra for every patch (N × L). */
  X_pred: Float64Array;
  /** Report on non-anchor patches. */
  report: PredictionReport;
  /** Effective basis rank used. */
  p: number;
  /** Fraction of total energy captured by the truncated basis. */
  varianceExplainedCumulative: number;
}

/**
 * End-to-end B3 run.
 *
 * Project ref + target anchors into the pool basis, fit a per-PC diagonal
 * affine map on the anchors, apply to all ref scores, reconstruct → spectra.
 */
export function runPoolPCATransfer(input: PoolPCATransferInput): PoolPCATransferResult {
  const { basis, X_ref, X_target, sampleIds, L, paperWP, refProfile, targetProfile } = input;
  const N = sampleIds.length;
  if (X_ref.length !== N * L) {
    throw new Error(`runPoolPCATransfer: X_ref shape mismatch — expected ${N * L}, got ${X_ref.length}`);
  }
  if (X_target.length !== N * L) {
    throw new Error(`runPoolPCATransfer: X_target shape mismatch — expected ${N * L}, got ${X_target.length}`);
  }
  const anchorIdx = Array.from(input.anchorIdx);
  const k = anchorIdx.length;
  if (k < 2) {
    throw new Error(`runPoolPCATransfer: need k ≥ 2 anchors, got ${k}`);
  }
  const p = basis.p;

  // 1. Extract anchor sub-matrices for ref and target.
  const X_A_anchors = new Float64Array(k * L);
  const X_B_anchors = new Float64Array(k * L);
  for (let a = 0; a < k; a++) {
    const src = anchorIdx[a];
    for (let l = 0; l < L; l++) {
      X_A_anchors[a * L + l] = X_ref[src * L + l];
      X_B_anchors[a * L + l] = X_target[src * L + l];
    }
  }

  // 2. Project ref + target anchors and the full ref into the pool basis.
  const Z_A_anchors = pcaProject(X_A_anchors, k, basis);
  const Z_B_anchors = pcaProject(X_B_anchors, k, basis);
  const Z_A_all = pcaProject(X_ref, N, basis);

  // 3. Fit per-PC diagonal affine on anchors.
  const { s, b, rSquaredPerPC } = fitDiagonalScoreMap(Z_A_anchors, Z_B_anchors, p);

  // 4. Apply: Z_B_pred[i, c] = s[c] * Z_A_all[i, c] + b[c].
  const Z_B_pred = new Float64Array(N * p);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < p; c++) {
      Z_B_pred[i * p + c] = s[c] * Z_A_all[i * p + c] + b[c];
    }
  }

  // 5. Reconstruct + clamp.
  const X_pred = pcaReconstruct(Z_B_pred, N, basis);
  for (let i = 0; i < X_pred.length; i++) {
    const v = X_pred[i];
    if (v < 0) X_pred[i] = 0;
    else if (v > 1) X_pred[i] = 1;
  }

  // 6. Evaluate non-anchor patches.
  const anchorSet = new Set(anchorIdx);
  const testIdx: number[] = [];
  for (let i = 0; i < N; i++) if (!anchorSet.has(i)) testIdx.push(i);
  const nTest = testIdx.length;
  const XPredTest = new Float64Array(nTest * L);
  const XTrueTest = new Float64Array(nTest * L);
  const sampleIdsTest: string[] = new Array(nTest);
  for (let t = 0; t < nTest; t++) {
    const src = testIdx[t];
    sampleIdsTest[t] = sampleIds[src];
    for (let l = 0; l < L; l++) {
      XPredTest[t * L + l] = X_pred[src * L + l];
      XTrueTest[t * L + l] = X_target[src * L + l];
    }
  }

  const report = evaluatePrediction({
    variant: `B3_poolPCA_p${p}`,
    k,
    XPred: XPredTest,
    XTrue: XTrueTest,
    L,
    sampleIds: sampleIdsTest,
    paperWP,
    refProfile,
    targetProfile,
  });

  // Variance-explained diagnostic (cumulative fraction at the truncated rank).
  // The basis only carries the kept eigenvalues, so this number is always 1.0
  // relative to the kept subspace — we expose it for shape consistency, but
  // the meaningful "captured energy" requires the un-truncated SVD which we
  // do not retain.
  let total = 0;
  for (const v of basis.eigenvalues) total += Math.max(0, v);
  const cum = total > 0 ? 1.0 : 0;

  return {
    s, b, rSquaredPerPC,
    X_pred,
    report,
    p,
    varianceExplainedCumulative: cum,
  };
}
