// src/lib/predict/obaSeparator.ts
//
// D7 — OBA-separated predictor wrapper.
//
// Optical brightener (OBA / FWA) fluorescence creates a bump near 420–450 nm
// on top of the substrate's smooth base reflectance. Cross-substrate
// predictors that ignore this bump fail catastrophically on OBA-disparate
// pairs (see EXPERIMENTS row "S3 cyan ramp counterexample" — C7+S3cyan
// median 9.28 ΔE00).
//
// D7 separates OBA structurally from the prediction problem:
//
//   1. extractOBAEmission(paperSpec)  → emission shape per λ.
//   2. computeOBAFactorPerPatch(X, paperIdx) → 0…1 per patch
//      (0 = ink fully blocks UV, 1 = paper = full OBA emission).
//   3. R_clean = R_measured − factor · emission  (applied to both A and B).
//   4. Run ANY base predictor on (R_clean_A → R_clean_B).
//   5. R_pred = R_pred_clean + factor · emission_B  (target's emission).
//
// Per knowledge-base §1.5 (path 2). Preferred over C9 because:
//   - 0 extra parameters in the predictor.
//   - Works with all existing predictors as a wrapper.
//   - Removes the OBA non-linearity from the cross-substrate signal,
//     which is the dominant pathology on this dataset.

import type { PredictionReport, WhitePointXYZ } from '../../types';
import { evaluatePrediction } from '../dataset/evaluate';

const DEFAULT_OBA_BAND = [380, 450] as const;  // wavelengths where OBA emits
const DEFAULT_BASE_BAND = [460, 730] as const; // OBA-free range for substrate_base fit

export interface OBAExtraction {
  /** Length-L emission per λ; 0 outside the OBA band. */
  emission: Float64Array;
  /** Fitted polynomial coefficients [c0, c1, c2] in centered wavelength. */
  baseCoeffs: [number, number, number];
  /** Center wavelength used to scale λ for numerical stability. */
  baseCenter: number;
  /** Peak emission value (max over emission). */
  peakAmplitude: number;
  /** λ index at the peak. */
  peakLambdaIdx: number;
}

interface PolyFit {
  c0: number;
  c1: number;
  c2: number;
  center: number;
}

/**
 * Degree-2 OLS polynomial fit on (xs, ys), evaluating at center-shifted
 * wavelengths to keep the 3×3 normal-equations matrix well-conditioned.
 */
function fitQuadratic(xs: number[], ys: number[], center: number): PolyFit {
  const n = xs.length;
  if (n < 3) throw new Error(`fitQuadratic: need ≥ 3 points, got ${n}`);
  // Build XᵀX (3×3) and Xᵀy (3) on scaled x.
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = (xs[i] - center) / 100; // scale to ~[-2, 1.5]
    const y = ys[i];
    const x2 = x * x;
    s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  // Solve [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]] [c0, c1, c2]ᵀ = [t0, t1, t2]ᵀ
  // Use Cramer's rule.
  const det =
    s0 * (s2 * s4 - s3 * s3) -
    s1 * (s1 * s4 - s3 * s2) +
    s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-18) throw new Error('fitQuadratic: singular matrix');

  const detC0 =
    t0 * (s2 * s4 - s3 * s3) -
    s1 * (t1 * s4 - s3 * t2) +
    s2 * (t1 * s3 - s2 * t2);
  const detC1 =
    s0 * (t1 * s4 - s3 * t2) -
    t0 * (s1 * s4 - s3 * s2) +
    s2 * (s1 * t2 - t1 * s2);
  const detC2 =
    s0 * (s2 * t2 - t1 * s3) -
    s1 * (s1 * t2 - t1 * s2) +
    t0 * (s1 * s3 - s2 * s2);

  return { c0: detC0 / det, c1: detC1 / det, c2: detC2 / det, center };
}

function evalPoly(fit: PolyFit, lambda: number): number {
  const x = (lambda - fit.center) / 100;
  return fit.c0 + fit.c1 * x + fit.c2 * x * x;
}

export interface ExtractOBAOptions {
  startWL?: number;
  step?: number;
  /** OBA emission band [low, high] nm. Default [380, 450]. */
  obaBand?: readonly [number, number];
  /** Substrate-base fit band [low, high] nm. Default [460, 730]. */
  baseBand?: readonly [number, number];
}

/**
 * Extract the OBA emission per wavelength from a single paper-white spectrum.
 *
 * Approach: fit a degree-2 polynomial to R_paper(λ) over the OBA-free band
 * (λ ∈ [460, 730] by default), extrapolate that polynomial back into the
 * OBA band ([380, 450]), and take the per-λ excess `R_paper − base` as the
 * emission. Excess values < 0 are clipped to 0 (substrate cannot emit
 * negatively).
 *
 * For low/no-OBA substrates the emission vector is approximately all zeros,
 * which makes the downstream subtract/add operations no-ops — safe to apply
 * universally.
 */
export function extractOBAEmission(
  paperSpec: ArrayLike<number>,
  options: ExtractOBAOptions = {},
): OBAExtraction {
  const startWL = options.startWL ?? 380;
  const step = options.step ?? 10;
  const [obaLo, obaHi] = options.obaBand ?? DEFAULT_OBA_BAND;
  const [baseLo, baseHi] = options.baseBand ?? DEFAULT_BASE_BAND;
  const L = paperSpec.length;
  const center = 600; // around mid-spectrum

  // Collect base-band points for the polynomial fit.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < L; i++) {
    const lambda = startWL + i * step;
    if (lambda >= baseLo && lambda <= baseHi) {
      xs.push(lambda);
      ys.push(paperSpec[i]);
    }
  }
  const fit = fitQuadratic(xs, ys, center);

  const emission = new Float64Array(L);
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < L; i++) {
    const lambda = startWL + i * step;
    if (lambda >= obaLo && lambda <= obaHi) {
      const base = evalPoly(fit, lambda);
      const excess = paperSpec[i] - base;
      const v = excess > 0 ? excess : 0;
      emission[i] = v;
      if (v > peak) { peak = v; peakIdx = i; }
    }
  }

  return {
    emission,
    baseCoeffs: [fit.c0, fit.c1, fit.c2],
    baseCenter: fit.center,
    peakAmplitude: peak,
    peakLambdaIdx: peakIdx,
  };
}

/**
 * Per-patch OBA modulation factor in [0, 1].
 *
 * UV-block proxy: at λ = 380 nm, ink absorbs UV and reduces both the
 * measured reflectance AND the OBA emission proportionally. We estimate:
 *
 *   UV_block(i) = max(0, 1 − R_patch_i(380) / R_paper(380))
 *   OBA_factor(i) = max(0, 1 − UV_block(i))   == clamp(R_patch_i(380) / R_paper(380), 0, 1)
 *
 * This computes from EXISTING spectra alone — no extra measurement needed.
 * Returns a length-N vector.
 *
 * Caveat: this proxy conflates "UV blocked by ink" with "UV reflected away
 * from a non-fluorescent dark patch". For patches whose 380-nm reflectance
 * is depressed by reasons other than UV-blocking ink (e.g. spectrally-dark
 * pigments that happen to have low R(380)), the factor will be biased low.
 * On RGB CMY profiles the bias is acceptable because yellow (strongest UV
 * blocker) is also the channel that most varies R(380) — the proxy and the
 * physical reality move together.
 */
export function computeOBAFactorPerPatch(
  X: Float64Array,
  L: number,
  paperRowIdx: number,
  options: { obaProbeWL?: number; startWL?: number; step?: number } = {},
): Float64Array {
  const startWL = options.startWL ?? 380;
  const step = options.step ?? 10;
  const probeWL = options.obaProbeWL ?? 380;
  const probeIdx = Math.round((probeWL - startWL) / step);
  if (probeIdx < 0 || probeIdx >= L) {
    throw new Error(`computeOBAFactorPerPatch: probe λ=${probeWL} out of range`);
  }
  const N = X.length / L;
  const paperR = X[paperRowIdx * L + probeIdx];
  const out = new Float64Array(N);
  if (paperR <= 1e-6) {
    out.fill(1);
    return out;
  }
  for (let i = 0; i < N; i++) {
    const r = X[i * L + probeIdx] / paperR;
    out[i] = r > 1 ? 1 : r < 0 ? 0 : r;
  }
  return out;
}

/**
 * Apply `R_clean = R − factor · emission` element-wise.
 * Output is clamped to [0, 1] for safety.
 */
export function subtractOBA(
  X: Float64Array,
  L: number,
  factors: Float64Array,
  emission: Float64Array,
): Float64Array {
  if (X.length % L !== 0) {
    throw new Error(`subtractOBA: X.length=${X.length} not a multiple of L=${L}`);
  }
  const N = X.length / L;
  if (factors.length !== N) {
    throw new Error(`subtractOBA: factors.length=${factors.length} ≠ N=${N}`);
  }
  if (emission.length !== L) {
    throw new Error(`subtractOBA: emission.length=${emission.length} ≠ L=${L}`);
  }
  const out = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    const f = factors[i];
    for (let l = 0; l < L; l++) {
      const v = X[i * L + l] - f * emission[l];
      out[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return out;
}

/**
 * Apply `R_pred = R_pred_clean + factor · emission` element-wise.
 * Output clamped to [0, 1].
 */
export function addOBA(
  X_clean: Float64Array,
  L: number,
  factors: Float64Array,
  emission: Float64Array,
): Float64Array {
  if (X_clean.length % L !== 0) {
    throw new Error(`addOBA: X_clean.length=${X_clean.length} not a multiple of L=${L}`);
  }
  const N = X_clean.length / L;
  if (factors.length !== N) {
    throw new Error(`addOBA: factors.length=${factors.length} ≠ N=${N}`);
  }
  if (emission.length !== L) {
    throw new Error(`addOBA: emission.length=${emission.length} ≠ L=${L}`);
  }
  const out = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    const f = factors[i];
    for (let l = 0; l < L; l++) {
      const v = X_clean[i * L + l] + f * emission[l];
      out[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return out;
}

// ─── End-to-end wrapper around any base predictor ─────────────────────────

/**
 * The wrapper runs a base predictor on OBA-cleaned spectra. The base
 * predictor is supplied as a callback so D7 stays predictor-agnostic.
 *
 * The callback receives clean ref + clean target full matrices plus the
 * anchor list and must return a prediction matrix N × L for the WHOLE
 * target chart (not just non-anchor rows) — that lets D7 re-add OBA to
 * every row including anchors before evaluating.
 */
export type BasePredictPredict = (input: {
  X_ref_clean: Float64Array;
  X_target_clean: Float64Array;
  anchorIdx: number[];
  L: number;
  N: number;
}) => Float64Array;

export interface OBASeparatedRunInput {
  X_A: Float64Array;
  X_B: Float64Array;
  sampleIds: string[];
  anchorIdx: number[] | Int32Array;
  paperRowIdx: number;
  L: number;
  paperWP: WhitePointXYZ;
  refProfile: string;
  targetProfile: string;
  /** Variant tag — appended to "D7_" to form the report variant name. */
  baseVariant: string;
  /** Callback that runs the base predictor on OBA-clean spectra. */
  predict: BasePredictPredict;
  options?: ExtractOBAOptions;
}

export interface OBASeparatedRunResult {
  report: PredictionReport;
  obaA: OBAExtraction;
  obaB: OBAExtraction;
  factorsA: Float64Array;
  factorsB: Float64Array;
  X_pred: Float64Array;
}

export function runOBASeparatedTransfer(input: OBASeparatedRunInput): OBASeparatedRunResult {
  const {
    X_A, X_B, sampleIds, paperRowIdx, L, paperWP,
    refProfile, targetProfile, baseVariant, predict, options,
  } = input;
  const N = sampleIds.length;
  if (X_A.length !== N * L || X_B.length !== N * L) {
    throw new Error('runOBASeparatedTransfer: matrix shape mismatch');
  }
  const anchorIdx = Array.from(input.anchorIdx);

  // 1. Extract OBA emission per substrate (paper row only).
  const paperSpecA: number[] = new Array(L);
  const paperSpecB: number[] = new Array(L);
  for (let l = 0; l < L; l++) {
    paperSpecA[l] = X_A[paperRowIdx * L + l];
    paperSpecB[l] = X_B[paperRowIdx * L + l];
  }
  const obaA = extractOBAEmission(paperSpecA, options);
  const obaB = extractOBAEmission(paperSpecB, options);

  // 2. Per-patch factor — use ref's R(380) for ref factors, target's R(380)
  //    for target factors. Conceptually the same RGB → factor mapping should
  //    be substrate-independent, but the proxy is built on a substrate, so
  //    we honour that.
  const factorsA = computeOBAFactorPerPatch(X_A, L, paperRowIdx);
  const factorsB = computeOBAFactorPerPatch(X_B, L, paperRowIdx);

  // 3. Clean both matrices.
  const X_A_clean = subtractOBA(X_A, L, factorsA, obaA.emission);
  const X_B_clean = subtractOBA(X_B, L, factorsB, obaB.emission);

  // 4. Run base predictor on clean spectra.
  const X_pred_clean = predict({
    X_ref_clean: X_A_clean,
    X_target_clean: X_B_clean,
    anchorIdx, L, N,
  });
  if (X_pred_clean.length !== N * L) {
    throw new Error(
      `runOBASeparatedTransfer: predictor must return N×L matrix; got ${X_pred_clean.length}, expected ${N * L}`,
    );
  }

  // 5. Add target's OBA back.
  const X_pred = addOBA(X_pred_clean, L, factorsB, obaB.emission);

  // 6. Evaluate on the non-anchor subset.
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
    variant: `D7_${baseVariant}`,
    k: anchorIdx.length,
    XPred: XPredTest,
    XTrue: XTrueTest,
    L,
    sampleIds: sampleIdsTest,
    paperWP,
    refProfile,
    targetProfile,
  });

  return { report, obaA, obaB, factorsA, factorsB, X_pred };
}
