// src/lib/dataset/evaluate.ts
//
// Single source of truth for "is this prediction good enough?". Every predictor
// in lib/predict/ pipes its output through evaluatePrediction so reports are
// comparable across variants.

import type { PredictionReport, WhitePointXYZ } from '../../types';
import { spectraToLab, deltaE00 } from '../colormath';

export interface EvaluateInput {
  variant: string;
  /** Calibration / anchor count for this run (Task 1 K or Task 2 k). */
  k: number;
  /** N_test × L predicted reflectance, row-major. */
  XPred: Float64Array;
  /** N_test × L measured reflectance, row-major. */
  XTrue: Float64Array;
  /** Wavelength count (must match XPred / XTrue stride). */
  L: number;
  /** Sample IDs of the test rows, in matching order. */
  sampleIds: string[];
  /** Paper-derived white point (recommended) or D50_PERFECT_WHITE for absolute Lab. */
  paperWP: WhitePointXYZ;
  /** Starting wavelength for spectraToLab; 380 nm is the project default. */
  startWL?: number;
  /** Task 2: reference profile used for the prediction. */
  refProfile?: string;
  /** Always provided: target profile being predicted. */
  targetProfile: string;
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAsc[mid] : 0.5 * (sortedAsc[mid - 1] + sortedAsc[mid]);
}

function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  // Linear interpolation between closest ranks.
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/**
 * Compute the standard report: median + P95 ΔE00, mean spectral R², mean RMS,
 * and the 5 worst patches by ΔE00.
 *
 * Spectral R² per patch is `1 − SS_res / SS_tot` where SS_tot is computed
 * against the per-patch mean. RMS is the per-patch sqrt-mean-square of
 * reflectance residuals.
 */
export function evaluatePrediction(input: EvaluateInput): PredictionReport {
  const { XPred, XTrue, L, sampleIds, paperWP, variant, k } = input;
  const N = sampleIds.length;
  if (XPred.length !== N * L || XTrue.length !== N * L) {
    throw new Error(
      `evaluatePrediction: matrix shape mismatch — N=${N}, L=${L}, ` +
        `XPred.length=${XPred.length}, XTrue.length=${XTrue.length}`,
    );
  }
  const startWL = input.startWL ?? 380;

  const de00: number[] = new Array(N);
  const r2: number[] = new Array(N);
  const rms: number[] = new Array(N);
  const predRow = new Array<number>(L);
  const trueRow = new Array<number>(L);

  for (let i = 0; i < N; i++) {
    let meanTrue = 0;
    let ssRes = 0;
    let ssTot = 0;
    for (let l = 0; l < L; l++) {
      predRow[l] = XPred[i * L + l];
      trueRow[l] = XTrue[i * L + l];
      meanTrue += trueRow[l];
    }
    meanTrue /= L;
    for (let l = 0; l < L; l++) {
      const d = predRow[l] - trueRow[l];
      ssRes += d * d;
      const dt = trueRow[l] - meanTrue;
      ssTot += dt * dt;
    }
    rms[i] = Math.sqrt(ssRes / L);
    r2[i] = ssTot > 0 ? 1 - ssRes / ssTot : NaN;

    const [Lp, ap, bp] = spectraToLab(predRow, startWL, paperWP);
    const [Lt, at, bt] = spectraToLab(trueRow, startWL, paperWP);
    de00[i] = deltaE00(Lp, ap, bp, Lt, at, bt);
  }

  const sortedDE = [...de00].sort((a, b) => a - b);

  // Indices of 5 worst by ΔE00, descending.
  const order = de00
    .map((v, idx) => ({ v, idx }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 5);
  const worstPatchSampleIds = order.map(o => sampleIds[o.idx]);

  const meanFinite = (arr: number[]) => {
    let s = 0, c = 0;
    for (const v of arr) if (Number.isFinite(v)) { s += v; c++; }
    return c > 0 ? s / c : NaN;
  };

  return {
    variant,
    k,
    medianDE00: median(sortedDE),
    p95DE00: percentile(sortedDE, 0.95),
    meanSpectralR2: meanFinite(r2),
    meanRMS: meanFinite(rms),
    worstPatchSampleIds,
    paperWP,
    refProfile: input.refProfile,
    targetProfile: input.targetProfile,
    nTest: N,
  };
}
