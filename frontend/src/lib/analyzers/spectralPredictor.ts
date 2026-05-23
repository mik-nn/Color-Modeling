// src/lib/analyzers/spectralPredictor.ts
//
// Spectral prediction: per-wavelength polynomial model R_B(λ) = f(R_A(λ))
// Models: multiplicative, affine (poly1), quadratic (poly2), cubic (poly3),
//         Yule-Nielsen (affine in R^(1/n) space, n found by grid search).
//
// Physical basis: Neugebauer-Yule — substrate and ink are separable in spectral
// domain. Small calibration set (Neugebauer primaries) suffices to reconstruct
// the full gamut on a new substrate.

import {
  MatchedPatchPair,
  SpectralPredictionModel,
  SpectralPredictionEvaluation,
  PatchPredictionResult,
  ModelComparisonRow,
  SpectralModelComparison,
} from '../../types';
import { spectraToXYZ, labToXYZ } from '../colormath';

// ─── Calibration scenarios ──────────────────────────────────────────────────

export interface CalibrationGroup {
  id: string;
  test: (r: number, g: number, b: number) => boolean;
}

interface CalibrationScenario {
  id: string;
  label: string;
  groups: CalibrationGroup[];
}

const SCENARIOS: CalibrationScenario[] = [
  {
    id: 'minimal',
    label: 'Minimal (paper+GB50+GB100)',
    groups: [
      { id: 'paper',  test: (r, g, b) => r <= 15 && g <= 15 && b <= 15 },
      { id: 'GB50',   test: (r, g, b) => r <= 40 && g >= 100 && g <= 160 && b >= 100 && b <= 160 },
      { id: 'GB100',  test: (r, g, b) => r <= 25 && g >= 230 && b >= 230 },
    ],
  },
  {
    id: 'primaries',
    label: 'Neugebauer primaries (8)',
    groups: [
      { id: 'paper',  test: (r, g, b) => r <= 15 && g <= 15 && b <= 15 },
      { id: 'R100',   test: (r, g, b) => r >= 230 && g <= 25 && b <= 25 },
      { id: 'G100',   test: (r, g, b) => r <= 25 && g >= 230 && b <= 25 },
      { id: 'B100',   test: (r, g, b) => r <= 25 && g <= 25 && b >= 230 },
      { id: 'RG100',  test: (r, g, b) => r >= 230 && g >= 230 && b <= 25 },
      { id: 'RB100',  test: (r, g, b) => r >= 230 && g <= 25 && b >= 230 },
      { id: 'GB100',  test: (r, g, b) => r <= 25 && g >= 230 && b >= 230 },
      { id: 'RGB100', test: (r, g, b) => r >= 230 && g >= 230 && b >= 230 },
    ],
  },
  {
    id: 'extended',
    label: 'Extended (primaries + 50% halftones)',
    groups: [
      { id: 'paper',  test: (r, g, b) => r <= 15 && g <= 15 && b <= 15 },
      { id: 'R100',   test: (r, g, b) => r >= 230 && g <= 25 && b <= 25 },
      { id: 'G100',   test: (r, g, b) => r <= 25 && g >= 230 && b <= 25 },
      { id: 'B100',   test: (r, g, b) => r <= 25 && g <= 25 && b >= 230 },
      { id: 'RG100',  test: (r, g, b) => r >= 230 && g >= 230 && b <= 25 },
      { id: 'RB100',  test: (r, g, b) => r >= 230 && g <= 25 && b >= 230 },
      { id: 'GB100',  test: (r, g, b) => r <= 25 && g >= 230 && b >= 230 },
      { id: 'RGB100', test: (r, g, b) => r >= 230 && g >= 230 && b >= 230 },
      { id: 'R50',    test: (r, g, b) => r >= 100 && r <= 160 && g <= 40 && b <= 40 },
      { id: 'G50',    test: (r, g, b) => r <= 40 && g >= 100 && g <= 160 && b <= 40 },
      { id: 'B50',    test: (r, g, b) => r <= 40 && g <= 40 && b >= 100 && b <= 160 },
      { id: 'RG50',   test: (r, g, b) => r >= 100 && r <= 160 && g >= 100 && g <= 160 && b <= 40 },
      { id: 'RB50',   test: (r, g, b) => r >= 100 && r <= 160 && g <= 40 && b >= 100 && b <= 160 },
      { id: 'GB50',   test: (r, g, b) => r <= 40 && g >= 100 && g <= 160 && b >= 100 && b <= 160 },
    ],
  },
];

// ─── Calibration pair extraction ────────────────────────────────────────────

interface CalPair {
  id: string;
  refSpec: number[];
  tgtSpec: number[];
}

function extractCalPairs(
  matchedPatches: MatchedPatchPair[],
  groups: CalibrationGroup[]
): { calPairs: CalPair[]; calIds: Set<string> } {
  const calIds = new Set<string>();
  const calPairs: CalPair[] = [];

  for (const group of groups) {
    const members = matchedPatches.filter(p =>
      group.test(p.ref.RGB_R ?? 0, p.ref.RGB_G ?? 0, p.ref.RGB_B ?? 0) &&
      p.ref.spectra && p.target.spectra &&
      p.ref.spectra.length === p.target.spectra.length
    );
    if (members.length === 0) continue;

    const nWL = members[0].ref.spectra!.length;
    const avgRef = new Float64Array(nWL);
    const avgTgt = new Float64Array(nWL);
    members.forEach(p => {
      p.ref.spectra!.forEach((v, i) => { avgRef[i] += v; });
      p.target.spectra!.forEach((v, i) => { avgTgt[i] += v; });
    });
    const n = members.length;

    calPairs.push({
      id: group.id,
      refSpec: Array.from(avgRef, v => v / n),
      tgtSpec: Array.from(avgTgt, v => v / n),
    });
    members.forEach(p => calIds.add(p.sampleId));
  }

  return { calPairs, calIds };
}

// ─── Linear algebra ──────────────────────────────────────────────────────────

// Solve A·x = b via Gaussian elimination with partial pivoting
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    }
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    if (Math.abs(M[i][i]) < 1e-14) continue;
    for (let k = i + 1; k < n; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    if (Math.abs(M[i][i]) > 1e-14) x[i] /= M[i][i];
  }
  return x;
}

// OLS polynomial fit for one wavelength: y ≈ c0 + c1·x + c2·x² + ...
// Returns coefficients [c0, c1, ..., cd]
function polyOLS(xs: number[], ys: number[], degree: number): number[] {
  const d = degree + 1;

  // Normal equations: (X^T X) c = X^T y
  const XtX = Array.from({ length: d }, (_, r) =>
    Array.from({ length: d }, (_, c) =>
      xs.reduce((s, x) => s + x ** (r + c), 0)
    )
  );
  const Xty = Array.from({ length: d }, (_, r) =>
    xs.reduce((s, x, i) => s + x ** r * ys[i], 0)
  );

  // Regularise diagonal slightly to avoid singular matrix when xs cluster
  const lambda = 1e-10;
  for (let r = 0; r < d; r++) XtX[r][r] += lambda;

  return solveLinear(XtX, Xty);
}

// ─── Model fitting ───────────────────────────────────────────────────────────

// Fit polynomial of given degree, per wavelength.
// For multiplicative: degree = 0 in terms of a free intercept (c0 forced = 0).
function fitPolynomial(
  calPairs: CalPair[],
  degree: number,
  forceNoIntercept = false
): number[][] {
  const nWL = calPairs[0].refSpec.length;

  return Array.from({ length: nWL }, (_, wi) => {
    const xs = calPairs.map(p => p.refSpec[wi]);
    const ys = calPairs.map(p => p.tgtSpec[wi]);

    if (forceNoIntercept) {
      // multiplicative: a = Σ(x·y) / Σ(x²)
      const num = xs.reduce((s, x, i) => s + x * ys[i], 0);
      const den = xs.reduce((s, x) => s + x * x, 0);
      return [0, den > 1e-12 ? num / den : 1]; // [c0=0, c1=a]
    }

    if (xs.length < degree + 1) {
      // Underdetermined: fall back to max feasible degree
      return polyOLS(xs, ys, Math.max(1, xs.length - 1));
    }

    return polyOLS(xs, ys, degree);
  });
}

// Yule-Nielsen: affine in R^(1/n) space. Grid search over n.
const YN_N_GRID = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0];

function fitYuleNielsen(
  calPairs: CalPair[],
  testPatches: MatchedPatchPair[]
): { poly_coeffs: number[][]; yn_n: number } {
  let bestN = 1.0;
  let bestR2 = -Infinity;

  for (const n of YN_N_GRID) {
    const transformed = calPairs.map(p => ({
      id: p.id,
      refSpec: p.refSpec.map(v => Math.max(0, v) ** (1 / n)),
      tgtSpec: p.tgtSpec.map(v => Math.max(0, v) ** (1 / n)),
    }));
    const coeffs = fitPolynomial(transformed, 1);

    const r2s = testPatches
      .filter(p => p.ref.spectra && p.target.spectra && p.ref.spectra.length === p.target.spectra.length)
      .map(p => {
        const pred = predictYN(p.ref.spectra!, coeffs, n);
        return pearsonR2(pred, p.target.spectra!);
      });

    if (r2s.length === 0) continue;
    const meanR2 = r2s.reduce((s, v) => s + v, 0) / r2s.length;
    if (meanR2 > bestR2) { bestR2 = meanR2; bestN = n; }
  }

  // Refit with best n
  const transformed = calPairs.map(p => ({
    id: p.id,
    refSpec: p.refSpec.map(v => Math.max(0, v) ** (1 / bestN)),
    tgtSpec: p.tgtSpec.map(v => Math.max(0, v) ** (1 / bestN)),
  }));

  return { poly_coeffs: fitPolynomial(transformed, 1), yn_n: bestN };
}

// ─── Prediction ──────────────────────────────────────────────────────────────

function predictPoly(refSpec: number[], coeffs: number[][]): number[] {
  return refSpec.map((r, wi) => {
    const c = coeffs[wi];
    let v = 0;
    for (let j = 0; j < c.length; j++) v += c[j] * r ** j;
    return Math.max(0, Math.min(1, v));
  });
}

function predictYN(refSpec: number[], coeffs: number[][], n: number): number[] {
  return refSpec.map((r, wi) => {
    const rT = Math.max(0, r) ** (1 / n);
    const c = coeffs[wi];
    const predT = c[0] + (c[1] ?? 1) * rT;
    return Math.max(0, Math.min(1, predT ** n));
  });
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

function pearsonR2(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  const r = sx === 0 || sy === 0 ? 0 : cov / (sx * sy);
  return r * r;
}

function meanAbsError(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
}

function evaluateModel(
  model: SpectralPredictionModel,
  testPatches: MatchedPatchPair[]
): SpectralPredictionEvaluation {
  const valid = testPatches.filter(
    p => p.ref.spectra && p.target.spectra && p.ref.spectra.length === p.target.spectra.length
  );

  const patchResults: PatchPredictionResult[] = valid.map(p => {
    const predicted = model.model_type === 'yn'
      ? predictYN(p.ref.spectra!, model.poly_coeffs, model.yn_n!)
      : predictPoly(p.ref.spectra!, model.poly_coeffs);

    return {
      sampleId: p.sampleId,
      r2: pearsonR2(predicted, p.target.spectra!),
      spectral_mae: meanAbsError(predicted, p.target.spectra!),
    };
  });

  const r2s = patchResults.map(r => r.r2).sort((a, b) => a - b);
  const p5idx = Math.max(0, Math.floor(0.05 * r2s.length));

  return {
    model,
    n_test: valid.length,
    mean_r2: r2s.reduce((s, v) => s + v, 0) / r2s.length,
    min_r2: r2s[0] ?? 0,
    p5_r2: r2s[p5idx] ?? 0,
    mean_spectral_mae: patchResults.reduce((s, r) => s + r.spectral_mae, 0) / patchResults.length,
    patch_results: patchResults,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function runModelComparison(
  matchedPatches: MatchedPatchPair[]
): SpectralModelComparison | null {

  const evaluations: SpectralPredictionEvaluation[] = [];

  for (const scenario of SCENARIOS) {
    const { calPairs, calIds } = extractCalPairs(matchedPatches, scenario.groups);
    if (calPairs.length === 0) continue;

    const testPatches = matchedPatches.filter(
      p => !calIds.has(p.sampleId) && p.ref.spectra && p.target.spectra &&
           p.ref.spectra.length === p.target.spectra.length
    );
    if (testPatches.length === 0) continue;

    const wavelengths = calPairs[0].refSpec.length > 0
      ? Array.from({ length: calPairs[0].refSpec.length }, (_, i) => 380 + i * 10)
      : [];

    // Multiplicative (1 parameter per λ)
    {
      const coeffs = fitPolynomial(calPairs, 1, true);
      const model: SpectralPredictionModel = {
        model_type: 'multiplicative',
        poly_coeffs: coeffs,
        wavelengths,
        n_calibration: calPairs.length,
        calibration_ids: calPairs.map(c => c.id),
        calibration_label: scenario.label,
      };
      evaluations.push(evaluateModel(model, testPatches));
    }

    // Polynomial degree 1 (affine)
    if (calPairs.length >= 2) {
      const coeffs = fitPolynomial(calPairs, 1);
      const model: SpectralPredictionModel = {
        model_type: 'poly1',
        poly_coeffs: coeffs,
        wavelengths,
        n_calibration: calPairs.length,
        calibration_ids: calPairs.map(c => c.id),
        calibration_label: scenario.label,
      };
      evaluations.push(evaluateModel(model, testPatches));
    }

    // Polynomial degree 2 (quadratic)
    if (calPairs.length >= 3) {
      const coeffs = fitPolynomial(calPairs, 2);
      const model: SpectralPredictionModel = {
        model_type: 'poly2',
        poly_coeffs: coeffs,
        wavelengths,
        n_calibration: calPairs.length,
        calibration_ids: calPairs.map(c => c.id),
        calibration_label: scenario.label,
      };
      evaluations.push(evaluateModel(model, testPatches));
    }

    // Polynomial degree 3 (cubic)
    if (calPairs.length >= 4) {
      const coeffs = fitPolynomial(calPairs, 3);
      const model: SpectralPredictionModel = {
        model_type: 'poly3',
        poly_coeffs: coeffs,
        wavelengths,
        n_calibration: calPairs.length,
        calibration_ids: calPairs.map(c => c.id),
        calibration_label: scenario.label,
      };
      evaluations.push(evaluateModel(model, testPatches));
    }

    // Yule-Nielsen (affine in R^(1/n) space, n by grid search)
    if (calPairs.length >= 2) {
      const { poly_coeffs, yn_n } = fitYuleNielsen(calPairs, testPatches);
      const model: SpectralPredictionModel = {
        model_type: 'yn',
        poly_coeffs,
        yn_n,
        wavelengths,
        n_calibration: calPairs.length,
        calibration_ids: calPairs.map(c => c.id),
        calibration_label: scenario.label,
      };
      evaluations.push(evaluateModel(model, testPatches));
    }
  }

  if (evaluations.length === 0) return null;

  const rows: ModelComparisonRow[] = evaluations.map(e => ({
    model_type: e.model.model_type,
    calibration_label: e.model.calibration_label,
    n_calibration: e.model.n_calibration,
    n_test: e.n_test,
    mean_r2: e.mean_r2,
    p5_r2: e.p5_r2,
    mean_spectral_mae: e.mean_spectral_mae,
    yn_n: e.model.yn_n,
    feasible: true,
  }));

  const best_idx = rows.reduce(
    (bestI, row, i) => row.mean_r2 > rows[bestI].mean_r2 ? i : bestI,
    0
  );

  return { rows, best_idx, best_evaluation: evaluations[best_idx] };
}

// Legacy: single-scenario run (for backward compat with existing ComparisonView usage)
export function runSpectralPrediction(
  matchedPatches: MatchedPatchPair[]
): SpectralPredictionEvaluation | null {
  const comp = runModelComparison(matchedPatches);
  return comp?.best_evaluation ?? null;
}

// ─── XYZ-space predictor ─────────────────────────────────────────────────────
//
// Predict XYZ(target) = f(XYZ(ref)) per channel using OLS polynomial.
// XYZ computed from spectra when available, else from Lab.
// "wavelengths" field repurposed as channel indices [0,1,2] = X,Y,Z.

const XYZ_SCENARIOS: CalibrationScenario[] = [
  {
    id: 'xyz_2ink',
    label: 'XYZ: paper + 100RG + 100RB + 100GB + 50RG',
    groups: [
      { id: 'paper',  test: (r, g, b) => r <= 15 && g <= 15 && b <= 15 },
      { id: 'RG100',  test: (r, g, b) => r >= 230 && g >= 230 && b <= 25 },
      { id: 'RB100',  test: (r, g, b) => r >= 230 && g <= 25 && b >= 230 },
      { id: 'GB100',  test: (r, g, b) => r <= 25 && g >= 230 && b >= 230 },
      { id: 'RG50',   test: (r, g, b) => r >= 100 && r <= 160 && g >= 100 && g <= 160 && b <= 40 },
    ],
  },
  {
    id: 'xyz_primaries',
    label: 'XYZ: Neugebauer primaries (8)',
    groups: [
      { id: 'paper',  test: (r, g, b) => r <= 15 && g <= 15 && b <= 15 },
      { id: 'R100',   test: (r, g, b) => r >= 230 && g <= 25 && b <= 25 },
      { id: 'G100',   test: (r, g, b) => r <= 25 && g >= 230 && b <= 25 },
      { id: 'B100',   test: (r, g, b) => r <= 25 && g <= 25 && b >= 230 },
      { id: 'RG100',  test: (r, g, b) => r >= 230 && g >= 230 && b <= 25 },
      { id: 'RB100',  test: (r, g, b) => r >= 230 && g <= 25 && b >= 230 },
      { id: 'GB100',  test: (r, g, b) => r <= 25 && g >= 230 && b >= 230 },
      { id: 'RGB100', test: (r, g, b) => r >= 230 && g >= 230 && b >= 230 },
    ],
  },
];

function measurementToXYZ(m: { LAB_L: number; LAB_A: number; LAB_B: number; spectra?: number[]; wavelengths?: number[] }): [number, number, number] {
  if (m.spectra && m.spectra.length >= 3) {
    return spectraToXYZ(m.spectra, m.wavelengths?.[0] ?? 380);
  }
  return labToXYZ(m.LAB_L, m.LAB_A, m.LAB_B);
}

function extractXYZCalPairs(
  matchedPatches: MatchedPatchPair[],
  groups: CalibrationGroup[]
): { calPairs: CalPair[]; calIds: Set<string> } {
  const calIds = new Set<string>();
  const calPairs: CalPair[] = [];

  for (const group of groups) {
    const members = matchedPatches.filter(p =>
      group.test(p.ref.RGB_R ?? 0, p.ref.RGB_G ?? 0, p.ref.RGB_B ?? 0)
    );
    if (members.length === 0) continue;

    const avgRef = [0, 0, 0];
    const avgTgt = [0, 0, 0];
    members.forEach(p => {
      const rx = measurementToXYZ(p.ref);
      const tx = measurementToXYZ(p.target);
      rx.forEach((v, i) => { avgRef[i] += v; });
      tx.forEach((v, i) => { avgTgt[i] += v; });
    });
    const n = members.length;

    calPairs.push({
      id: group.id,
      refSpec: avgRef.map(v => v / n),
      tgtSpec: avgTgt.map(v => v / n),
    });
    members.forEach(p => calIds.add(p.sampleId));
  }

  return { calPairs, calIds };
}

function evaluateXYZModel(
  model: SpectralPredictionModel,
  testPatches: MatchedPatchPair[]
): SpectralPredictionEvaluation {
  const patchResults: PatchPredictionResult[] = testPatches.map(p => {
    const refXYZ = measurementToXYZ(p.ref);
    const tgtXYZ = measurementToXYZ(p.target);
    const predicted = predictPoly(refXYZ, model.poly_coeffs);
    return {
      sampleId: p.sampleId,
      r2: pearsonR2(predicted, tgtXYZ),
      spectral_mae: meanAbsError(predicted, tgtXYZ),
    };
  });

  const r2s = patchResults.map(r => r.r2).sort((a, b) => a - b);
  const p5idx = Math.max(0, Math.floor(0.05 * r2s.length));

  return {
    model,
    n_test: testPatches.length,
    mean_r2: r2s.length > 0 ? r2s.reduce((s, v) => s + v, 0) / r2s.length : 0,
    min_r2: r2s[0] ?? 0,
    p5_r2: r2s[p5idx] ?? 0,
    mean_spectral_mae: patchResults.reduce((s, r) => s + r.spectral_mae, 0) / (patchResults.length || 1),
    patch_results: patchResults,
  };
}

export function runXYZModelComparison(
  matchedPatches: MatchedPatchPair[]
): SpectralModelComparison | null {
  const XYZ_CHANNELS = [0, 1, 2]; // repurposed "wavelengths" — index 0=X, 1=Y, 2=Z

  const evaluations: SpectralPredictionEvaluation[] = [];

  for (const scenario of XYZ_SCENARIOS) {
    const { calPairs, calIds } = extractXYZCalPairs(matchedPatches, scenario.groups);
    if (calPairs.length < 2) continue;

    const testPatches = matchedPatches.filter(p => !calIds.has(p.sampleId));
    if (testPatches.length === 0) continue;

    // xyz_affine: per-channel linear (poly1)
    {
      const coeffs = fitPolynomial(calPairs, 1);
      const model: SpectralPredictionModel = {
        model_type: 'xyz_affine',
        poly_coeffs: coeffs,
        wavelengths: XYZ_CHANNELS,
        n_calibration: calPairs.length,
        calibration_ids: calPairs.map(c => c.id),
        calibration_label: scenario.label,
      };
      evaluations.push(evaluateXYZModel(model, testPatches));
    }

    // xyz_poly2: per-channel quadratic
    if (calPairs.length >= 3) {
      const coeffs = fitPolynomial(calPairs, 2);
      const model: SpectralPredictionModel = {
        model_type: 'xyz_poly2',
        poly_coeffs: coeffs,
        wavelengths: XYZ_CHANNELS,
        n_calibration: calPairs.length,
        calibration_ids: calPairs.map(c => c.id),
        calibration_label: scenario.label,
      };
      evaluations.push(evaluateXYZModel(model, testPatches));
    }
  }

  if (evaluations.length === 0) return null;

  const rows: ModelComparisonRow[] = evaluations.map(e => ({
    model_type: e.model.model_type,
    calibration_label: e.model.calibration_label,
    n_calibration: e.model.n_calibration,
    n_test: e.n_test,
    mean_r2: e.mean_r2,
    p5_r2: e.p5_r2,
    mean_spectral_mae: e.mean_spectral_mae,
    feasible: true,
  }));

  const best_idx = rows.reduce(
    (bestI, row, i) => row.mean_r2 > rows[bestI].mean_r2 ? i : bestI,
    0
  );

  return { rows, best_idx, best_evaluation: evaluations[best_idx] };
}
