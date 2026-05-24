// src/lib/predict/perLambdaCurve.ts
//
// C7 — Per-wavelength piecewise-linear monotone curve.
//
// Hypothesis under test: the substrate transform between two profiles is a
// per-λ function of the reference reflectance — not a constant slope
// (which A3 assumes). If true, every ink behaves the same way under a
// substrate change (no separate per-ink slope), and the curve can be learned
// from anchors that span any subset of inks.
//
// Per λ, sort the k (A, B) anchor pairs by A and build a piecewise-linear
// interpolant. For patches where A(λ) lies between two anchor A values,
// linearly interpolate B. For A outside the anchor range, extrapolate using
// the slope of the nearest two anchor points (clamped to [0, 1] at the end).
//
// Compared to A3 (per-λ affine, 2·L params):
//   - C7 has k anchor points per λ → up to k DOF per λ, expressive enough
//     to capture saturation curves and OBA non-linearity.
//   - When B = a·A + b exactly, C7 with k > 2 still recovers the same fit
//     within numerical noise; A3 stays as a fast, robust baseline.
//
// Compared to D1 (paper-ratio + PCA residual):
//   - C7 has no "first-order then residual" split; it fits B directly per λ.
//   - C7 cannot share information across wavelengths, so OBA bands at
//     380–410 nm are still independent fits (no spectral smoothness prior).
//
// The S3 single-channel-ramp anchor strategy is the natural partner for C7:
// if substrate transform is shared across inks, a cyan-ramp's (A, B) pairs
// at each λ should sufficient to fit f_λ everywhere on the manifold.

import type { PredictionReport, WhitePointXYZ } from '../../types';
import { evaluatePrediction } from '../dataset/evaluate';

export interface PerLambdaCurveFit {
  /** For each wavelength index, sorted anchor A values (de-duplicated). */
  curvesA: Float64Array[];
  /** For each wavelength index, anchor B values matching curvesA order. */
  curvesB: Float64Array[];
  /** Anchor count used to fit. */
  k: number;
}

/**
 * Fit one monotone-PCH-free piecewise-linear curve per wavelength. Anchors
 * with identical A(λ) are merged by averaging their B values (typical for
 * pure paper or pure black patches where multiple anchors collide at the
 * extremes).
 */
export function fitPerLambdaCurve(
  X_A_anchors: Float64Array,
  X_B_anchors: Float64Array,
  L: number,
): PerLambdaCurveFit {
  if (X_A_anchors.length !== X_B_anchors.length || X_A_anchors.length % L !== 0) {
    throw new Error(
      `fitPerLambdaCurve: shape mismatch — A.length=${X_A_anchors.length}, B.length=${X_B_anchors.length}, L=${L}`,
    );
  }
  const k = X_A_anchors.length / L;
  if (k < 2) throw new Error(`fitPerLambdaCurve: need k ≥ 2 anchors, got ${k}`);

  const curvesA: Float64Array[] = new Array(L);
  const curvesB: Float64Array[] = new Array(L);

  for (let l = 0; l < L; l++) {
    const pairs: { a: number; b: number }[] = new Array(k);
    for (let i = 0; i < k; i++) {
      pairs[i] = { a: X_A_anchors[i * L + l], b: X_B_anchors[i * L + l] };
    }
    pairs.sort((u, v) => u.a - v.a);

    // Merge duplicates by averaging B at the same A.
    const dedupA: number[] = [];
    const dedupB: number[] = [];
    let i = 0;
    while (i < pairs.length) {
      let j = i;
      let sumB = 0;
      let count = 0;
      while (j < pairs.length && Math.abs(pairs[j].a - pairs[i].a) < 1e-9) {
        sumB += pairs[j].b;
        count++;
        j++;
      }
      dedupA.push(pairs[i].a);
      dedupB.push(sumB / count);
      i = j;
    }
    curvesA[l] = Float64Array.from(dedupA);
    curvesB[l] = Float64Array.from(dedupB);
  }

  return { curvesA, curvesB, k };
}

/**
 * Evaluate the fit at every (patch, λ). Linear inside the anchor range,
 * slope-of-edge extrapolation outside; clamped to [0, 1].
 */
export function applyPerLambdaCurve(
  X_A: Float64Array,
  L: number,
  fit: PerLambdaCurveFit,
): Float64Array {
  if (X_A.length % L !== 0) {
    throw new Error(`applyPerLambdaCurve: X_A.length=${X_A.length} not a multiple of L=${L}`);
  }
  const N = X_A.length / L;
  const out = new Float64Array(N * L);

  for (let l = 0; l < L; l++) {
    const cA = fit.curvesA[l];
    const cB = fit.curvesB[l];
    const m = cA.length;
    if (m === 0) {
      // Degenerate: copy A through (no transform).
      for (let i = 0; i < N; i++) out[i * L + l] = X_A[i * L + l];
      continue;
    }
    if (m === 1) {
      // Constant offset learned from the single anchor: B - A.
      const off = cB[0] - cA[0];
      for (let i = 0; i < N; i++) {
        const v = X_A[i * L + l] + off;
        out[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
      continue;
    }

    const slopeLo = (cB[1] - cB[0]) / (cA[1] - cA[0] || 1e-9);
    const slopeHi = (cB[m - 1] - cB[m - 2]) / (cA[m - 1] - cA[m - 2] || 1e-9);

    for (let i = 0; i < N; i++) {
      const a = X_A[i * L + l];
      let v: number;
      if (a <= cA[0]) {
        v = cB[0] + slopeLo * (a - cA[0]);
      } else if (a >= cA[m - 1]) {
        v = cB[m - 1] + slopeHi * (a - cA[m - 1]);
      } else {
        // Binary search for the bracketing interval.
        let lo = 0, hi = m - 1;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >> 1;
          if (cA[mid] <= a) lo = mid;
          else hi = mid;
        }
        const dA = cA[hi] - cA[lo];
        const t = dA > 1e-12 ? (a - cA[lo]) / dA : 0;
        v = cB[lo] + t * (cB[hi] - cB[lo]);
      }
      out[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  return out;
}

export interface PerLambdaCurveRunInput {
  X_A: Float64Array;
  X_B: Float64Array;
  sampleIds: string[];
  anchorIdx: number[] | Int32Array;
  L: number;
  paperWP: WhitePointXYZ;
  refProfile: string;
  targetProfile: string;
}

export interface PerLambdaCurveRunResult {
  fit: PerLambdaCurveFit;
  X_pred: Float64Array;
  report: PredictionReport;
}

export function runPerLambdaCurveTransfer(input: PerLambdaCurveRunInput): PerLambdaCurveRunResult {
  const { X_A, X_B, sampleIds, L, paperWP, refProfile, targetProfile } = input;
  const N = sampleIds.length;
  if (X_A.length !== N * L || X_B.length !== N * L) {
    throw new Error(`runPerLambdaCurveTransfer: matrix shape mismatch`);
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

  const fit = fitPerLambdaCurve(Aanchors, Banchors, L);
  const X_pred = applyPerLambdaCurve(X_A, L, fit);

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
    variant: 'C7_perLambdaCurve',
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
