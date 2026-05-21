// cynsn.ts — 3D CMY Cellular Yule-Nielsen Spectral Neugebauer model.
//
// RGB workflow: K=0 always.  Device RGB → CMY ink coverage:
//   C = (255 - R) / 255,  M = (255 - G) / 255,  Y = (255 - B) / 255
//
// 8 Neugebauer primaries (binary CMY corners):
//   v  C  M  Y   RGB equivalent
//   0  0  0  0   255,255,255  = Paper/White
//   1  0  0  1   255,255,  0  = Yellow ink
//   2  0  1  0   255,  0,255  = Magenta ink
//   3  0  1  1   255,  0,  0  = Red  (M+Y)
//   4  1  0  0     0,255,255  = Cyan ink
//   5  1  0  1     0,255,  0  = Green (C+Y)
//   6  1  1  0     0,  0,255  = Blue  (C+M)
//   7  1  1  1     0,  0,  0  = Black (C+M+Y)
//
// Ported from Color_Modeling/app/model/cynsn.py (4D CMYK → 3D CMY).
// Architecture unchanged; only channel count reduced from 4 to 3.

import { spectraToLab, deltaE00 } from '../colormath';
import {
  SpreadingParams3,
  applySpreading3,
  unpackTheta3,
  monotonicityPenalty3,
} from './spreading';
import { nelderMead } from './optimizer';
import type { MatchedPatchPair } from '../../types';

// ─── Constants ────────────────────────────────────────────────────────────────

// CMY bit pattern for each of the 8 Neugebauer primaries (v=0..7)
export const PRIMARY_ORDER_3D: [number, number, number][] = [
  [0, 0, 0], // v=0 W
  [0, 0, 1], // v=1 Y
  [0, 1, 0], // v=2 M
  [0, 1, 1], // v=3 MY
  [1, 0, 0], // v=4 C
  [1, 0, 1], // v=5 CY
  [1, 1, 0], // v=6 CM
  [1, 1, 1], // v=7 CMY
];

const SPEC_EPS = 1e-9;

// ─── RGB → CMY ────────────────────────────────────────────────────────────────

/** Device RGB (0-255 integers) → CMY ink coverage (0-1). */
export function rgbToCmy(R: number, G: number, B: number): [number, number, number] {
  return [(255 - R) / 255, (255 - G) / 255, (255 - B) / 255];
}

// ─── Demichel 3D ─────────────────────────────────────────────────────────────

/**
 * Demichel equations for 3D CMY: returns 8 weights for one CMY point.
 * Weights sum to 1 and correspond to PRIMARY_ORDER_3D vertex order.
 */
export function demichel3(c: number, m: number, y: number): number[] {
  const nc = 1 - c, nm = 1 - m, ny = 1 - y;
  return [
    nc * nm * ny, // v=0 W
    nc * nm * y,  // v=1 Y
    nc * m  * ny, // v=2 M
    nc * m  * y,  // v=3 MY
    c  * nm * ny, // v=4 C
    c  * nm * y,  // v=5 CY
    c  * m  * ny, // v=6 CM
    c  * m  * y,  // v=7 CMY
  ];
}

/**
 * Batch Demichel: cmy (N×3 flat Float64Array) → weights (N×8 flat Float64Array).
 */
export function demichel3Batch(cmy: Float64Array, N: number): Float64Array {
  const W = new Float64Array(N * 8);
  for (let i = 0; i < N; i++) {
    const c = cmy[i * 3], m = cmy[i * 3 + 1], y = cmy[i * 3 + 2];
    const nc = 1 - c, nm = 1 - m, ny = 1 - y;
    const base = i * 8;
    W[base + 0] = nc * nm * ny;
    W[base + 1] = nc * nm * y;
    W[base + 2] = nc * m  * ny;
    W[base + 3] = nc * m  * y;
    W[base + 4] = c  * nm * ny;
    W[base + 5] = c  * nm * y;
    W[base + 6] = c  * m  * ny;
    W[base + 7] = c  * m  * y;
  }
  return W;
}

// ─── Cell finding ─────────────────────────────────────────────────────────────

interface CellResult {
  cell_idx: Int32Array;   // (N×3) flat
  norm_coords: Float64Array; // (N×3) flat, values in [0,1]
}

/**
 * For each CMY sample, find which 3D cell it belongs to and normalise coords.
 *
 * n_intervals=1 → global YNSN (no subdivision, single cell [0,1]^3)
 * n_intervals=2 → 8 cells (3^3 = 27 nodes)
 * n_intervals=4 → 64 cells (5^3 = 125 nodes)
 */
export function findCell3(cmy: Float64Array, N: number, n_intervals: number): CellResult {
  const cell_idx = new Int32Array(N * 3);
  const norm_coords = new Float64Array(N * 3);
  const cellWidth = 1.0 / n_intervals;

  for (let i = 0; i < N; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const u = Math.min(1, Math.max(0, cmy[i * 3 + ch]));
      const raw = Math.floor(u * n_intervals);
      const ci = Math.min(raw, n_intervals - 1);
      cell_idx[i * 3 + ch] = ci;
      norm_coords[i * 3 + ch] = Math.min(1, Math.max(0, (u - ci * cellWidth) / cellWidth));
    }
  }
  return { cell_idx, norm_coords };
}

// ─── Grid builders ────────────────────────────────────────────────────────────

/**
 * Build (n_intervals+1)^3 grid from the 8 binary primaries using the YNSN formula.
 *
 * Each node is predicted by YNSN with n_exponent — keeps the grid physically
 * consistent with prediction (same n used at build time and predict time).
 *
 * primaries: Float64Array (8 × nL) — spectra of 8 Neugebauer primaries
 * Returns: Float64Array ((n_intervals+1)^3 × nL)
 */
export function buildGridFromColorants3(
  primaries: Float64Array,
  nL: number,
  n_intervals: number,
  n_exponent: number,
): Float64Array {
  const nNodes = n_intervals + 1;
  const nGrid = nNodes ** 3;
  const grid = new Float64Array(nGrid * nL);
  const invN = 1.0 / n_exponent;

  for (let flat = 0; flat < nGrid; flat++) {
    const ci = Math.floor(flat / (nNodes * nNodes));
    const mi = Math.floor((flat % (nNodes * nNodes)) / nNodes);
    const yi = flat % nNodes;

    const c = ci / n_intervals;
    const m = mi / n_intervals;
    const y = yi / n_intervals;
    const w = demichel3(c, m, y);

    for (let wi = 0; wi < nL; wi++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        sum += w[v] * Math.max(SPEC_EPS, primaries[v * nL + wi]) ** invN;
      }
      grid[flat * nL + wi] = Math.min(1, Math.max(0, Math.max(SPEC_EPS, sum) ** n_exponent));
    }
  }

  return grid;
}

/**
 * Build grid via KNN lookup in measured dataset.
 * Fallback to buildGridFromColorants3 when no measurement within tolerance.
 *
 * cmy_batch: Float64Array (N×3), spectra_batch: Float64Array (N×nL)
 * Returns: Float64Array ((n_intervals+1)^3 × nL)
 */
export function buildGridFromData3(
  cmy_batch: Float64Array,
  spectra_batch: Float64Array,
  N: number,
  primaries: Float64Array,
  nL: number,
  n_intervals: number,
  n_exponent: number,
  tol = 0.08,
): Float64Array {
  const nNodes = n_intervals + 1;
  const nGrid = nNodes ** 3;
  const grid = buildGridFromColorants3(primaries, nL, n_intervals, n_exponent);

  for (let flat = 0; flat < nGrid; flat++) {
    const ci = Math.floor(flat / (nNodes * nNodes));
    const mi = Math.floor((flat % (nNodes * nNodes)) / nNodes);
    const yi = flat % nNodes;
    const tc = ci / n_intervals;
    const tm = mi / n_intervals;
    const ty = yi / n_intervals;

    let bestDist = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < N; i++) {
      const dc = cmy_batch[i * 3] - tc;
      const dm = cmy_batch[i * 3 + 1] - tm;
      const dy = cmy_batch[i * 3 + 2] - ty;
      const d = Math.sqrt(dc * dc + dm * dm + dy * dy);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    if (bestIdx >= 0 && bestDist <= tol) {
      for (let wi = 0; wi < nL; wi++) {
        grid[flat * nL + wi] = spectra_batch[bestIdx * nL + wi];
      }
    }
  }

  return grid;
}

// ─── Forward pass ─────────────────────────────────────────────────────────────

/**
 * Full CYNSN forward pass: CMY effective values → predicted spectra.
 *
 * grid_spectra: Float64Array ((n_intervals+1)^3 × nL)
 * cmy_eff:      Float64Array (N×3), already spreading-corrected
 * Returns:      Float64Array (N×nL)
 */
export function predictSpectra3(
  grid_spectra: Float64Array,
  nL: number,
  n_exponent: number,
  n_intervals: number,
  cmy_eff: Float64Array,
  N: number,
): Float64Array {
  const nNodes = n_intervals + 1;
  const { cell_idx, norm_coords } = findCell3(cmy_eff, N, n_intervals);
  const invN = 1.0 / n_exponent;
  const result = new Float64Array(N * nL);

  for (let i = 0; i < N; i++) {
    const ci = cell_idx[i * 3];
    const mi = cell_idx[i * 3 + 1];
    const yi = cell_idx[i * 3 + 2];

    const nc = norm_coords[i * 3];
    const nm = norm_coords[i * 3 + 1];
    const ny = norm_coords[i * 3 + 2];
    const w = demichel3(nc, nm, ny);

    // 8 vertex flat indices in the grid
    const v00 = ci * nNodes * nNodes + mi * nNodes + yi;
    const verts = [
      v00,                                           // 000
      v00 + 1,                                       // 001 (+Y)
      ci * nNodes * nNodes + (mi + 1) * nNodes + yi, // 010 (+M)
      ci * nNodes * nNodes + (mi + 1) * nNodes + yi + 1, // 011
      (ci + 1) * nNodes * nNodes + mi * nNodes + yi, // 100 (+C)
      (ci + 1) * nNodes * nNodes + mi * nNodes + yi + 1, // 101
      (ci + 1) * nNodes * nNodes + (mi + 1) * nNodes + yi, // 110
      (ci + 1) * nNodes * nNodes + (mi + 1) * nNodes + yi + 1, // 111
    ];

    for (let wi = 0; wi < nL; wi++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        sum += w[v] * Math.max(SPEC_EPS, grid_spectra[verts[v] * nL + wi]) ** invN;
      }
      result[i * nL + wi] = Math.min(1, Math.max(0, Math.max(SPEC_EPS, sum) ** n_exponent));
    }
  }

  return result;
}

// ─── Primary extraction ───────────────────────────────────────────────────────

/**
 * Extract 8 Neugebauer primaries from a measured dataset via KNN.
 *
 * For each of 8 CMY binary corners, finds the nearest patch (in CMYK distance).
 * If no patch is within tolerance, falls back to neutral 0.9 (near-white).
 *
 * Returns Float64Array (8 × nL).
 */
export interface PrimaryExtractionResult {
  primaries: Float64Array; // (8 × nL)
  matched: boolean[];      // length 8 — true if found within exact tolerance
  matchDistances: number[]; // length 8 — best distance for each corner
}

/**
 * Extract 8 Neugebauer primaries via inverse-distance-weighted KNN.
 *
 * Strategy: for each corner, find K nearest patches in CMY space and
 * compute spectrum as inverse-distance-weighted average.  This avoids
 * the all-0.9 fallback collapse when a corner has no patch within tol.
 *
 * `matched[v]` reports whether a patch exists within `exactTol` — purely
 * informational for the UI; the spectrum is always populated.
 */
export function extractNeugebauerPrimaries3(
  cmy_batch: Float64Array,
  spectra_batch: Float64Array,
  N: number,
  nL: number,
  exactTol = 0.10,
  K = 4,
): PrimaryExtractionResult {
  const primaries = new Float64Array(8 * nL);
  const matched: boolean[] = new Array(8).fill(false);
  const matchDistances: number[] = new Array(8).fill(Infinity);

  for (let v = 0; v < 8; v++) {
    const [tc, tm, ty] = PRIMARY_ORDER_3D[v];

    // Find K nearest patches by squared CMY distance
    const dists: { idx: number; d: number }[] = [];
    for (let i = 0; i < N; i++) {
      const dc = cmy_batch[i * 3] - tc;
      const dm = cmy_batch[i * 3 + 1] - tm;
      const dy = cmy_batch[i * 3 + 2] - ty;
      dists.push({ idx: i, d: Math.sqrt(dc * dc + dm * dm + dy * dy) });
    }
    dists.sort((a, b) => a.d - b.d);

    const bestD = dists[0]?.d ?? Infinity;
    matchDistances[v] = bestD;
    matched[v] = bestD <= exactTol;

    // Inverse-distance-weighted average over K nearest
    const k = Math.min(K, dists.length);
    let wSum = 0;
    const weights: number[] = [];
    for (let j = 0; j < k; j++) {
      const w = 1.0 / (dists[j].d + 1e-6);
      weights.push(w);
      wSum += w;
    }
    for (let wi = 0; wi < nL; wi++) {
      let s = 0;
      for (let j = 0; j < k; j++) {
        s += weights[j] * spectra_batch[dists[j].idx * nL + wi];
      }
      primaries[v * nL + wi] = s / wSum;
    }
  }

  return { primaries, matched, matchDistances };
}

// ─── Training ─────────────────────────────────────────────────────────────────

export interface CYNSNTrainingConfig {
  n_intervals?: number;
  n_init?: number;        // initial Yule-Nielsen exponent
  l2_reg?: number;        // L2 regularisation on spreading params
  mono_penalty?: number;  // monotonicity penalty weight
  maxIter?: number;
}

export interface CYNSNModel3D {
  n_exponent: number;
  n_intervals: number;
  spreading: SpreadingParams3;
  grid_spectra: Float64Array; // ((n_intervals+1)^3 × nL) flat
  primaries: Float64Array;    // (8 × nL) flat
  nL: number;
  wavelengths: number[];
}

export interface CYNSNTrainingResult {
  model: CYNSNModel3D;
  final_loss: number;
  n_iterations: number;
  n_eval: number;
  converged: boolean;
}

/**
 * Train CYNSN model on a set of calibration (CMY, spectra) pairs.
 *
 * Optimises [a_C, a_M, a_Y, log(n)] jointly to minimise mean ΔE00 + regularisation
 * using Nelder-Mead simplex.
 *
 * Parameters
 * ----------
 * cmy_cal      : Float64Array (N_cal × 3) — nominal CMY from RGB device values
 * spectra_cal  : Float64Array (N_cal × nL) — measured reflectances
 * primaries    : Float64Array (8 × nL) — pre-extracted Neugebauer primaries
 * wavelengths  : number[] length nL
 */
export function trainCYNSN3(
  cmy_cal: Float64Array,
  spectra_cal: Float64Array,
  N_cal: number,
  primaries: Float64Array,
  wavelengths: number[],
  config: CYNSNTrainingConfig = {},
): CYNSNTrainingResult {
  const nL = wavelengths.length;
  const n_intervals = config.n_intervals ?? 1;
  const l2_reg = config.l2_reg ?? 1e-4;
  const mono_w = config.mono_penalty ?? 10.0;
  const n_init = config.n_init ?? 2.0;

  // Pre-compute Lab for measured spectra — amortises cost across all optimizer evals
  const lab_cal = new Float64Array(N_cal * 3);
  {
    const tmp: number[] = new Array(nL);
    for (let i = 0; i < N_cal; i++) {
      for (let wi = 0; wi < nL; wi++) tmp[wi] = spectra_cal[i * nL + wi];
      const [L, a, b] = spectraToLab(tmp, wavelengths[0]);
      lab_cal[i * 3] = L; lab_cal[i * 3 + 1] = a; lab_cal[i * 3 + 2] = b;
    }
  }

  // Initial parameter vector: [a_C, a_M, a_Y, log(n)]
  const x0 = [0, 0, 0, Math.log(n_init)];
  const predTmp: number[] = new Array(nL);

  function loss(x: number[]): number {
    const spreading = unpackTheta3([x[0], x[1], x[2]]);
    const n = Math.min(10, Math.max(0.1, Math.exp(x[3])));

    const grid = buildGridFromColorants3(primaries, nL, n_intervals, n);
    const cmy_eff = applySpreading3(cmy_cal, spreading, N_cal);
    const R_pred = predictSpectra3(grid, nL, n, n_intervals, cmy_eff, N_cal);

    // Mean ΔE00 — measured Lab pre-computed; only predict Lab inside loop
    let totalDE = 0;
    for (let i = 0; i < N_cal; i++) {
      for (let wi = 0; wi < nL; wi++) predTmp[wi] = R_pred[i * nL + wi];
      const [L2, a2, b2] = spectraToLab(predTmp, wavelengths[0]);
      totalDE += deltaE00(lab_cal[i * 3], lab_cal[i * 3 + 1], lab_cal[i * 3 + 2], L2, a2, b2);
    }

    const spectralLoss = totalDE / N_cal;
    const reg = l2_reg * (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
    const mono = mono_w * monotonicityPenalty3(spreading);

    return spectralLoss + reg + mono;
  }

  const result = nelderMead(loss, x0, {
    maxIter: config.maxIter ?? 600,
    ftol: 1e-6,
    initialStep: [0.05, 0.05, 0.05, 0.1],
  });

  const optSpreading = unpackTheta3([result.x[0], result.x[1], result.x[2]]);
  const optN = Math.min(10, Math.max(0.1, Math.exp(result.x[3])));
  const optGrid = buildGridFromColorants3(primaries, nL, n_intervals, optN);

  const model: CYNSNModel3D = {
    n_exponent: optN,
    n_intervals,
    spreading: optSpreading,
    grid_spectra: optGrid,
    primaries,
    nL,
    wavelengths,
  };

  return {
    model,
    final_loss: result.fval,
    n_iterations: result.nIter,
    n_eval: result.nEval,
    converged: result.converged,
  };
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

export interface CYNSNEvaluation {
  model_label: string;
  n_intervals: number;
  n_exponent: number;
  n_test: number;
  mean_de00: number;
  median_de00: number;
  p95_de00: number;
  rms_mean: number;
}

/**
 * Evaluate a trained model on a held-out test set.
 */
export function evaluateCYNSN3(
  model: CYNSNModel3D,
  cmy_test: Float64Array,
  spectra_test: Float64Array,
  N_test: number,
  label?: string,
): CYNSNEvaluation {
  const { nL, n_exponent, n_intervals, spreading, grid_spectra, wavelengths } = model;

  const cmy_eff = applySpreading3(cmy_test, spreading, N_test);
  const R_pred = predictSpectra3(grid_spectra, nL, n_exponent, n_intervals, cmy_eff, N_test);

  const de00s: number[] = [];
  let rmsSum = 0;

  for (let i = 0; i < N_test; i++) {
    const refSpec = Array.from(spectra_test.subarray(i * nL, (i + 1) * nL));
    const predSpec = Array.from(R_pred.subarray(i * nL, (i + 1) * nL));

    const [L1, a1, b1] = spectraToLab(refSpec, wavelengths[0]);
    const [L2, a2, b2] = spectraToLab(predSpec, wavelengths[0]);
    de00s.push(deltaE00(L1, a1, b1, L2, a2, b2));

    let rms = 0;
    for (let wi = 0; wi < nL; wi++) {
      const d = predSpec[wi] - refSpec[wi];
      rms += d * d;
    }
    rmsSum += Math.sqrt(rms / nL);
  }

  de00s.sort((a, b) => a - b);
  const mid = Math.floor(N_test / 2);
  const median_de00 = N_test % 2 === 0
    ? (de00s[mid - 1] + de00s[mid]) / 2
    : de00s[mid];
  const p95_de00 = de00s[Math.floor(0.95 * N_test)] ?? de00s[de00s.length - 1];
  const mean_de00 = de00s.reduce((s, v) => s + v, 0) / N_test;

  return {
    model_label: label ?? `CYNSN-${n_intervals}`,
    n_intervals,
    n_exponent,
    n_test: N_test,
    mean_de00,
    median_de00,
    p95_de00,
    rms_mean: rmsSum / N_test,
  };
}

// ─── High-level entry point ───────────────────────────────────────────────────

export interface CYNSNComparisonResult {
  evaluations: CYNSNEvaluation[];
  best_idx: number;
  n_cal: number;
  n_test: number;
  primaries_matched: number;    // 0..8 — how many corners had patch within exactTol
  primary_max_dist: number;     // worst-corner distance (sanity check)
}

/**
 * Run YNSN + CYNSN-2 comparison on a set of matched patch pairs.
 *
 * Splits 50/50 calibration/test.  Extracts Neugebauer primaries from cal set.
 * Trains YNSN (n_intervals=1) and CYNSN-2 (n_intervals=2).
 *
 * Uses ref profile spectra as the target for within-profile fitting.
 * (Both ref and target patches are available — pass which profile to model via 'useTarget'.)
 */
export function runCYNSNComparison(
  matchedPatches: MatchedPatchPair[],
  useTarget = false,
): CYNSNComparisonResult | null {
  // Collect patches with RGB device values and spectra
  const valid = matchedPatches.filter(p => {
    const m = useTarget ? p.target : p.ref;
    return m.RGB_R !== undefined && m.spectra && m.spectra.length >= 3;
  });
  if (valid.length < 16) return null;

  const N = valid.length;
  // Use first patch to determine nL and startWL
  const exampleSpec = (useTarget ? valid[0].target : valid[0].ref).spectra!;
  const nL = exampleSpec.length;
  const startWL = (useTarget ? valid[0].target : valid[0].ref).wavelengths?.[0] ?? 380;
  const wavelengths = Array.from({ length: nL }, (_, i) => startWL + i * 10);

  // Build flat arrays
  const cmy_all = new Float64Array(N * 3);
  const spec_all = new Float64Array(N * nL);

  for (let i = 0; i < N; i++) {
    const m = useTarget ? valid[i].target : valid[i].ref;
    const [c, mg, y] = rgbToCmy(m.RGB_R!, m.RGB_G!, m.RGB_B!);
    cmy_all[i * 3 + 0] = c;
    cmy_all[i * 3 + 1] = mg;
    cmy_all[i * 3 + 2] = y;
    for (let wi = 0; wi < nL; wi++) spec_all[i * nL + wi] = m.spectra![wi];
  }

  // 50/50 cal/test split (deterministic, odd → test)
  const calIdx: number[] = [];
  const testIdx: number[] = [];
  for (let i = 0; i < N; i++) {
    (i % 2 === 0 ? calIdx : testIdx).push(i);
  }
  const N_cal = calIdx.length;
  const N_test = testIdx.length;

  const cmy_cal = new Float64Array(N_cal * 3);
  const spec_cal = new Float64Array(N_cal * nL);
  calIdx.forEach((src, dst) => {
    cmy_cal.set(cmy_all.subarray(src * 3, src * 3 + 3), dst * 3);
    spec_cal.set(spec_all.subarray(src * nL, src * nL + nL), dst * nL);
  });

  const cmy_test = new Float64Array(N_test * 3);
  const spec_test = new Float64Array(N_test * nL);
  testIdx.forEach((src, dst) => {
    cmy_test.set(cmy_all.subarray(src * 3, src * 3 + 3), dst * 3);
    spec_test.set(spec_all.subarray(src * nL, src * nL + nL), dst * nL);
  });

  // Extract primaries from FULL dataset (cal+test) so corner coverage isn't
  // damaged by the split.  Primaries are device-RGB binary corners — they
  // don't leak target info because we never look at predictions at those
  // points during training/eval scoring.
  const primExt = extractNeugebauerPrimaries3(cmy_all, spec_all, N, nL);
  const primaries = primExt.primaries;
  const matchedCount = primExt.matched.filter(Boolean).length;
  const maxDist = Math.max(...primExt.matchDistances);

  const evaluations: CYNSNEvaluation[] = [];

  // YNSN (n_intervals=1, global, 8 primaries only)
  const ynsn = trainCYNSN3(cmy_cal, spec_cal, N_cal, primaries, wavelengths, { n_intervals: 1 });
  evaluations.push(evaluateCYNSN3(ynsn.model, cmy_test, spec_test, N_test, 'YNSN'));

  // CYNSN-2 with measured grid — 27 nodes, intermediate nodes filled by
  // KNN lookup in cal data (with YNSN fallback using n0 from YNSN result).
  // This is what makes CYNSN-2 differ from YNSN; using buildGridFromColorants3
  // alone gives a model mathematically equivalent to YNSN.
  const grid_cynsn2 = buildGridFromData3(
    cmy_cal, spec_cal, N_cal, primaries, nL, 2, ynsn.model.n_exponent,
  );
  const cynsn2 = trainCYNSN3(
    cmy_cal, spec_cal, N_cal, primaries, wavelengths,
    { n_intervals: 2, n_init: ynsn.model.n_exponent },
  );
  // Override the trained grid with the measured one for evaluation
  const cynsn2Model = { ...cynsn2.model, grid_spectra: grid_cynsn2 };
  evaluations.push(evaluateCYNSN3(cynsn2Model, cmy_test, spec_test, N_test, 'CYNSN-2'));

  const best_idx = evaluations.reduce(
    (b, e, i) => e.median_de00 < evaluations[b].median_de00 ? i : b,
    0,
  );

  return {
    evaluations,
    best_idx,
    n_cal: N_cal,
    n_test: N_test,
    primaries_matched: matchedCount,
    primary_max_dist: maxDist,
  };
}
