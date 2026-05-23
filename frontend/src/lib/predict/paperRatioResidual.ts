// src/lib/predict/paperRatioResidual.ts
//
// D1 — Paper-ratio first-order + PCA residual.
//
// First-order substrate transform: B̂₁(λ, RGB) = r(λ) · A(λ, RGB)
//   where r(λ) = B_paper(λ) / A_paper(λ) is the per-wavelength paper-white
//   ratio. Costs ONE anchor (the paper patch) and immediately gives a sane
//   prediction for every RGB.
//
// Second-order correction: residuals at the non-paper anchors are decomposed
// by PCA into a low-rank basis (rank 2–3); the per-anchor scores are then
// interpolated to every patch's RGB via inverse-distance-weighted kNN.
//
// Pros: graceful degradation. k = 1 → first-order only. Each added anchor
// strictly improves the residual fit. Residual is small → small basis →
// fewer anchors needed than per-λ affine for the same target ΔE00.
//
// Cons: ratio breaks when A_paper has near-zero reflectance at some λ; we
// guard by skipping/clamping. UV-brightener fluorescence not under D50
// reading dominantly affects 380–410 nm where the guard kicks in.

import type { PredictionReport, WhitePointXYZ } from '../../types';
import { evaluatePrediction } from '../dataset/evaluate';
import {
  fitPCA,
  pcaProject,
  pcaReconstruct,
  type PCABasis,
} from '../dataset/basis';

const RATIO_GUARD = 1e-3;

export interface PaperRatioResidualFit {
  /** Row index of the paper anchor in the aligned matrices. */
  paperRowIdx: number;
  /** Per-λ ratio r(λ) = B_paper(λ) / A_paper(λ). Length L. */
  r: Float64Array;
  /** PCA basis fit on residuals at non-paper anchors. Null if k ≤ 1. */
  residualBasis: PCABasis | null;
  /** Residual anchor row indices (paper excluded). Length k-1. */
  residualAnchorIdx: number[];
  /** Residual anchor RGB values (k-1) × 3 — used by kNN interpolation. */
  residualAnchorRGB: Float64Array;
  /** Residual anchor PCA scores (k-1) × p. */
  residualAnchorScores: Float64Array;
  /** Total anchor count including paper. */
  k: number;
  /** Effective residual rank used (≤ requested rank; ≤ k-1; ≤ L). */
  residualRank: number;
}

export interface PaperRatioResidualOptions {
  /** Requested PCA rank for the residual. Default 2. */
  residualRank?: number;
  /** kNN K for residual-score interpolation. Default 4. */
  knnK?: number;
}

/**
 * Compute the per-λ paper-white ratio with a guard against zero division.
 */
function computeRatio(specA: number[], specB: number[]): Float64Array {
  const L = specA.length;
  const r = new Float64Array(L);
  for (let l = 0; l < L; l++) {
    const a = specA[l];
    const b = specB[l];
    r[l] = a > RATIO_GUARD ? b / a : 1;
  }
  return r;
}

/**
 * Build per-row first-order prediction: B̂₁[i, λ] = r[λ] · X_A[i, λ].
 */
function applyRatio(X_A: Float64Array, L: number, r: Float64Array): Float64Array {
  const N = X_A.length / L;
  const out = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) {
      out[i * L + l] = r[l] * X_A[i * L + l];
    }
  }
  return out;
}

/**
 * Inverse-distance-weighted kNN interpolation of vector-valued scores.
 *
 * For each query row in D_query (M×3 RGB), pick the K nearest anchors in
 * D_anchors (k×3 RGB), weight by 1 / (dist + eps), produce M×p score matrix.
 */
function knnInterpolate(
  D_anchors: Float64Array,
  anchorScores: Float64Array,
  p: number,
  D_query: Float64Array,
  K: number,
): Float64Array {
  const kAnchors = anchorScores.length / p;
  const M = D_query.length / 3;
  const out = new Float64Array(M * p);
  const Keff = Math.min(K, kAnchors);
  const dists: { idx: number; d: number }[] = new Array(kAnchors);

  for (let q = 0; q < M; q++) {
    const qr = D_query[q * 3];
    const qg = D_query[q * 3 + 1];
    const qb = D_query[q * 3 + 2];
    for (let a = 0; a < kAnchors; a++) {
      const dr = D_anchors[a * 3] - qr;
      const dg = D_anchors[a * 3 + 1] - qg;
      const db = D_anchors[a * 3 + 2] - qb;
      dists[a] = { idx: a, d: Math.sqrt(dr * dr + dg * dg + db * db) };
    }
    dists.sort((u, v) => u.d - v.d);

    let wSum = 0;
    const w = new Array<number>(Keff);
    for (let j = 0; j < Keff; j++) {
      w[j] = 1 / (dists[j].d + 1e-6);
      wSum += w[j];
    }
    for (let c = 0; c < p; c++) {
      let s = 0;
      for (let j = 0; j < Keff; j++) {
        s += w[j] * anchorScores[dists[j].idx * p + c];
      }
      out[q * p + c] = s / wSum;
    }
  }

  return out;
}

/**
 * Fit D1: paper ratio + PCA residual.
 *
 * Requirements:
 *   - X_A, X_B aligned by row (same SAMPLE_ID at same row index).
 *   - anchorIdx[0] == paperRowIdx by S1 convention; if not, pass paperRowIdx
 *     explicitly.
 *   - k = anchorIdx.length ≥ 1.
 */
export function fitPaperRatioResidual(
  X_A: Float64Array,
  X_B: Float64Array,
  D: Float64Array, // N×3 (RGB of B / same as A's chart by construction)
  L: number,
  anchorIdx: number[],
  paperRowIdx: number,
  options: PaperRatioResidualOptions = {},
): PaperRatioResidualFit {
  const k = anchorIdx.length;
  if (k < 1) throw new Error(`fitPaperRatioResidual: need k ≥ 1, got ${k}`);

  // Per-λ ratio from paper anchor.
  const paperA = new Array<number>(L);
  const paperB = new Array<number>(L);
  for (let l = 0; l < L; l++) {
    paperA[l] = X_A[paperRowIdx * L + l];
    paperB[l] = X_B[paperRowIdx * L + l];
  }
  const r = computeRatio(paperA, paperB);

  // Residual anchors = anchors minus the paper anchor.
  const residualIdx = anchorIdx.filter(i => i !== paperRowIdx);
  const kRes = residualIdx.length;

  if (kRes === 0) {
    return {
      paperRowIdx,
      r,
      residualBasis: null,
      residualAnchorIdx: [],
      residualAnchorRGB: new Float64Array(0),
      residualAnchorScores: new Float64Array(0),
      k,
      residualRank: 0,
    };
  }

  // Residuals at residual anchors: ε = B - B̂₁ where B̂₁ = r ⊙ X_A.
  const epsAnchors = new Float64Array(kRes * L);
  for (let a = 0; a < kRes; a++) {
    const src = residualIdx[a];
    for (let l = 0; l < L; l++) {
      const pred1 = r[l] * X_A[src * L + l];
      epsAnchors[a * L + l] = X_B[src * L + l] - pred1;
    }
  }

  // PCA on the residual anchor matrix.
  const requestedRank = Math.max(1, options.residualRank ?? 2);
  // fitPCA requires N ≥ 2. If kRes < 2, fall back to a constant offset basis.
  let residualBasis: PCABasis;
  if (kRes < 2) {
    // Degenerate: one residual anchor. Build a trivial basis = the residual
    // itself as the only "direction" with score = 1. This makes
    // ε̂(any RGB) = single anchor's residual (a constant offset).
    const v = new Float64Array(L);
    let norm = 0;
    for (let l = 0; l < L; l++) norm += epsAnchors[l] * epsAnchors[l];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let l = 0; l < L; l++) v[l] = epsAnchors[l] / norm;
    }
    residualBasis = {
      mean: new Float64Array(L),
      V: v,
      eigenvalues: Float64Array.from([norm * norm]),
      L,
      p: 1,
    };
  } else {
    const pKeep = Math.min(requestedRank, kRes - 1, L);
    residualBasis = fitPCA(epsAnchors, kRes, L, Math.max(1, pKeep));
  }

  // Score the anchors in the basis.
  const anchorScores = pcaProject(epsAnchors, kRes, residualBasis);

  // Collect anchor RGB.
  const anchorRGB = new Float64Array(kRes * 3);
  for (let a = 0; a < kRes; a++) {
    const src = residualIdx[a];
    anchorRGB[a * 3]     = D[src * 3];
    anchorRGB[a * 3 + 1] = D[src * 3 + 1];
    anchorRGB[a * 3 + 2] = D[src * 3 + 2];
  }

  return {
    paperRowIdx,
    r,
    residualBasis,
    residualAnchorIdx: residualIdx,
    residualAnchorRGB: anchorRGB,
    residualAnchorScores: anchorScores,
    k,
    residualRank: residualBasis.p,
  };
}

/**
 * Apply D1: predict B for every patch.
 */
export function applyPaperRatioResidual(
  X_A: Float64Array,
  D: Float64Array, // N×3
  L: number,
  fit: PaperRatioResidualFit,
  options: PaperRatioResidualOptions = {},
): Float64Array {
  const N = X_A.length / L;
  // Step 1: B̂₁ = r ⊙ X_A
  const out = applyRatio(X_A, L, fit.r);

  // Step 2: add residual ε̂ if a basis exists.
  if (fit.residualBasis && fit.residualAnchorScores.length > 0) {
    const knnK = options.knnK ?? 4;
    const queryScores = knnInterpolate(
      fit.residualAnchorRGB,
      fit.residualAnchorScores,
      fit.residualRank,
      D,
      knnK,
    );
    const eps = pcaReconstruct(queryScores, N, fit.residualBasis);
    for (let i = 0; i < N * L; i++) out[i] += eps[i];
  }

  // Clamp to [0, 1].
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

export interface PaperRatioResidualRunInput {
  X_A: Float64Array;
  X_B: Float64Array;
  /** N×3 device matrix (RGB shared between A and B by chart construction). */
  D: Float64Array;
  sampleIds: string[];
  anchorIdx: number[] | Int32Array;
  /** Row index of the paper anchor; defaults to anchorIdx[0]. */
  paperRowIdx?: number;
  L: number;
  paperWP: WhitePointXYZ;
  refProfile: string;
  targetProfile: string;
  residualRank?: number;
  knnK?: number;
}

export interface PaperRatioResidualRunResult {
  fit: PaperRatioResidualFit;
  X_pred: Float64Array;
  report: PredictionReport;
}

export function runPaperRatioResidualTransfer(
  input: PaperRatioResidualRunInput,
): PaperRatioResidualRunResult {
  const {
    X_A, X_B, D, sampleIds, L, paperWP,
    refProfile, targetProfile,
  } = input;
  const N = sampleIds.length;
  if (X_A.length !== N * L || X_B.length !== N * L) {
    throw new Error(`runPaperRatioResidualTransfer: matrix shape mismatch`);
  }
  const anchorIdx = Array.from(input.anchorIdx);
  const paperRowIdx = input.paperRowIdx ?? anchorIdx[0];

  const fit = fitPaperRatioResidual(X_A, X_B, D, L, anchorIdx, paperRowIdx, {
    residualRank: input.residualRank,
    knnK: input.knnK,
  });
  const X_pred = applyPaperRatioResidual(X_A, D, L, fit, {
    residualRank: input.residualRank,
    knnK: input.knnK,
  });

  // Test set: non-anchor patches.
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
      XTrueTest[t * L + l] = X_B[src * L + l];
    }
  }

  const report = evaluatePrediction({
    variant: `D1_paperRatioResidual_p${fit.residualRank}`,
    k: anchorIdx.length,
    XPred: XPredTest,
    XTrue: XTrueTest,
    L,
    sampleIds: sampleIdsTest,
    paperWP,
    refProfile,
    targetProfile,
  });

  return { fit, X_pred, report };
}
