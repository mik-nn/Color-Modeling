// src/lib/predict/perLambdaAffine.ts
//
// A3 — Per-wavelength affine substrate transform.
//
//   B(λ, RGB) ≈ a(λ) · A(λ, RGB) + b(λ)
//
// One OLS per wavelength on the k anchor pairs. 72 free parameters (2 × 36),
// closed-form fit, no iterations. Baseline against which D1/B3 must justify
// their complexity.
//
// Inputs assumed already aligned by SAMPLE_ID — see dataset/matrix.ts
// alignByCommonSampleIds. The predictor never touches sample IDs; it operates
// on row-major matrices and index arrays.

import type { PredictionReport, WhitePointXYZ } from '../../types';
import { evaluatePrediction } from '../dataset/evaluate';
import { spectraToXYZ } from '../colormath';

export interface PerLambdaAffineFit {
  /** Slope a(λ), length L. */
  a: Float64Array;
  /** Intercept b(λ), length L. */
  b: Float64Array;
  /** Per-wavelength R² on the anchor fit (sanity diagnostic). */
  rSquaredPerLambda: Float64Array;
  /** Anchor count k used to fit. */
  k: number;
}

/**
 * Fit one affine map per wavelength on k anchor pairs.
 *
 * Inputs:
 *   X_A_anchors, X_B_anchors:  k × L row-major reflectance for the same k anchor
 *                              positions on profiles A and B.
 *   L: wavelength count.
 *
 * Output: (a, b) per λ. Closed-form OLS:
 *   a(λ) = cov(A_λ, B_λ) / var(A_λ)
 *   b(λ) = mean(B_λ) − a(λ) · mean(A_λ)
 *
 * Guards: if var(A_λ) ≈ 0 at some λ (constant reflectance across anchors),
 * falls back to a(λ) = 1 and b(λ) = mean(B_λ) − mean(A_λ) — a pure offset.
 * This prevents division-by-zero on degenerate channels (e.g., very flat
 * reflectance at the long-wavelength end of certain papers).
 */
export function fitPerLambdaAffine(
  X_A_anchors: Float64Array,
  X_B_anchors: Float64Array,
  L: number,
): PerLambdaAffineFit {
  if (X_A_anchors.length !== X_B_anchors.length || X_A_anchors.length % L !== 0) {
    throw new Error(
      `fitPerLambdaAffine: shape mismatch — A.length=${X_A_anchors.length}, B.length=${X_B_anchors.length}, L=${L}`,
    );
  }
  const k = X_A_anchors.length / L;
  if (k < 2) {
    throw new Error(`fitPerLambdaAffine: need k ≥ 2 anchors, got ${k}`);
  }

  const a = new Float64Array(L);
  const b = new Float64Array(L);
  const r2 = new Float64Array(L);

  for (let l = 0; l < L; l++) {
    let sumA = 0, sumB = 0;
    for (let i = 0; i < k; i++) {
      sumA += X_A_anchors[i * L + l];
      sumB += X_B_anchors[i * L + l];
    }
    const meanA = sumA / k;
    const meanB = sumB / k;

    let covAB = 0, varA = 0, varB = 0;
    for (let i = 0; i < k; i++) {
      const dA = X_A_anchors[i * L + l] - meanA;
      const dB = X_B_anchors[i * L + l] - meanB;
      covAB += dA * dB;
      varA += dA * dA;
      varB += dB * dB;
    }

    if (varA < 1e-12) {
      a[l] = 1;
      b[l] = meanB - meanA;
      r2[l] = 0;
    } else {
      a[l] = covAB / varA;
      b[l] = meanB - a[l] * meanA;
      r2[l] = varB > 0 ? (covAB * covAB) / (varA * varB) : 0;
    }
  }

  return { a, b, rSquaredPerLambda: r2, k };
}

/**
 * Apply a fitted affine map to predict B from full reference matrix A.
 *
 *   X_pred[i, λ] = a[λ] · X_A[i, λ] + b[λ]
 *
 * Clamps to [0, 1] because reflectance can't physically leave that range; the
 * fit may extrapolate negative or > 1 values for patches outside the anchor
 * spread.
 */
export function applyPerLambdaAffine(
  X_A: Float64Array,
  L: number,
  fit: PerLambdaAffineFit,
): Float64Array {
  if (X_A.length % L !== 0) {
    throw new Error(`applyPerLambdaAffine: X_A.length=${X_A.length} not a multiple of L=${L}`);
  }
  const N = X_A.length / L;
  const out = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) {
      const v = fit.a[l] * X_A[i * L + l] + fit.b[l];
      out[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return out;
}

export interface TransferRunInput {
  /** N×L reference profile spectra (full). */
  X_A: Float64Array;
  /** N×L target profile spectra (full ground truth). */
  X_B: Float64Array;
  /** Sample IDs in matching order (length N). */
  sampleIds: string[];
  /** Row indices into both matrices that serve as anchors. */
  anchorIdx: number[] | Int32Array;
  /** Wavelength count. */
  L: number;
  /** Paper white point of target profile, for paper-relative ΔE00. */
  paperWP: WhitePointXYZ;
  /** Reference profile filename (for the report). */
  refProfile: string;
  /** Target profile filename (for the report). */
  targetProfile: string;
}

export interface TransferRunResult {
  fit: PerLambdaAffineFit;
  /** Prediction for every patch (anchors included; their ΔE00 will be near 0 by construction). */
  X_pred: Float64Array;
  /** Standard prediction report on the held-out subset (non-anchor patches). */
  report: PredictionReport;
}

/**
 * End-to-end Task-2 run with A3 + a chosen anchor set.
 *
 * 1. Extract anchor rows from X_A and X_B.
 * 2. Fit per-λ affine on those k pairs.
 * 3. Predict B for every patch from full X_A.
 * 4. Evaluate prediction quality on the NON-anchor subset (the only honest
 *    test set since anchors were measured for free under Task 2's framing).
 */
export function runPerLambdaAffineTransfer(input: TransferRunInput): TransferRunResult {
  const { X_A, X_B, sampleIds, L, paperWP, refProfile, targetProfile } = input;
  const N = sampleIds.length;
  if (X_A.length !== N * L || X_B.length !== N * L) {
    throw new Error(`runPerLambdaAffineTransfer: matrix shape mismatch`);
  }
  const anchorIdx = Array.from(input.anchorIdx);
  const k = anchorIdx.length;

  // Extract anchor sub-matrices.
  const Aanchors = new Float64Array(k * L);
  const Banchors = new Float64Array(k * L);
  for (let a = 0; a < k; a++) {
    const src = anchorIdx[a];
    for (let l = 0; l < L; l++) {
      Aanchors[a * L + l] = X_A[src * L + l];
      Banchors[a * L + l] = X_B[src * L + l];
    }
  }

  const fit = fitPerLambdaAffine(Aanchors, Banchors, L);
  const X_pred = applyPerLambdaAffine(X_A, L, fit);

  // Held-out test set: every non-anchor row.
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
    variant: 'A3_perLambdaAffine',
    k,
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

/**
 * Convenience: derive paper-relative white point from the brightest patch of a
 * spectral matrix (used as a default when an explicit paper anchor is not
 * available). For RGB-addressed datasets where (255,255,255) is the paper, the
 * caller should instead pass that patch's XYZ directly.
 */
export function paperWPFromBrightestPatch(X: Float64Array, N: number, L: number, startWL = 380): WhitePointXYZ {
  let bestIdx = 0;
  let bestY = -Infinity;
  const tmp = new Array<number>(L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) tmp[l] = X[i * L + l];
    const [, Y] = spectraToXYZ(tmp, startWL);
    if (Y > bestY) { bestY = Y; bestIdx = i; }
  }
  for (let l = 0; l < L; l++) tmp[l] = X[bestIdx * L + l];
  return spectraToXYZ(tmp, startWL);
}
