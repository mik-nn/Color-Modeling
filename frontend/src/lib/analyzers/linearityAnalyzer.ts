// src/lib/analyzers/linearityAnalyzer.ts
import { ProfileData, Measurement, LinearityResult, MatchedPatchPair } from '../../types';
import { spectraToXYZ } from '../colormath';

export interface LinearityAnalysisOptions {
  minPatches?: number;
}

const DEFAULT_OPTIONS: LinearityAnalysisOptions = {
  minPatches: 50,
};

export function analyzeLinearity(
  referenceProfile: ProfileData,
  targetProfile: ProfileData,
  options: LinearityAnalysisOptions = {}
): LinearityResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const matchedPatches = matchPatchesBySampleId(referenceProfile.raw, targetProfile.raw);

  if (matchedPatches.length < opts.minPatches!) {
    throw new Error(`Insufficient matching patches: ${matchedPatches.length} < ${opts.minPatches}`);
  }

  const labCorrelation = calculatePearsonCorrelation(
    matchedPatches.flatMap(p => [p.ref.LAB_L, p.ref.LAB_A, p.ref.LAB_B]),
    matchedPatches.flatMap(p => [p.target.LAB_L, p.target.LAB_A, p.target.LAB_B])
  );

  const spectralCorrelation = calculateSpectralCorrelation(matchedPatches);
  const xyzCorrelation = calculateXYZCorrelation(matchedPatches);
  const meanSpectralR2 = calculateMeanPerPatchSpectralR2(matchedPatches);
  const spectralSlopeCV = calculateSpectralSlopeCV(matchedPatches);

  const residuals = matchedPatches.map(p => ({
    L: p.target.LAB_L - p.ref.LAB_L,
    a: p.target.LAB_A - p.ref.LAB_A,
    b: p.target.LAB_B - p.ref.LAB_B,
  }));
  const residualCorrelation = calculateResidualCorrelation(residuals);

  const rSquared = calculateRSquared(matchedPatches);
  const slopeStabilityScore = calculateSlopeStability(matchedPatches);
  const meanDeltaEAfterCorrection = calculateMeanDeltaEAfterCorrection(matchedPatches);
  const linearityConfidence = determineConfidenceLevel(
    spectralCorrelation > 0 ? spectralCorrelation : labCorrelation,
    rSquared,
    slopeStabilityScore
  );

  const matched_patches: MatchedPatchPair[] = matchedPatches.map(p => ({
    sampleId: p.sampleId,
    ref: p.ref,
    target: p.target,
  }));

  return {
    reference_substrate: referenceProfile.metadata.substrate,
    target_substrate: targetProfile.metadata.substrate,
    pearson_corr_lab: labCorrelation,
    pearson_corr_residuals: residualCorrelation,
    spectral_pearson_corr: spectralCorrelation > 0 ? spectralCorrelation : undefined,
    xyz_pearson_corr: xyzCorrelation > 0 ? xyzCorrelation : undefined,
    mean_spectral_r2: meanSpectralR2,
    spectral_slope_cv: spectralSlopeCV,
    r_squared: rSquared,
    slope_stability_score: slopeStabilityScore,
    mean_deltaE_after_correction: meanDeltaEAfterCorrection,
    n_patches_used: matchedPatches.length,
    linearity_confidence: linearityConfidence,
    matched_patches,
  };
}

interface MatchedPatch {
  ref: Measurement;
  target: Measurement;
  sampleId: string;
}

function matchPatchesBySampleId(refPatches: Measurement[], targetPatches: Measurement[]): MatchedPatch[] {
  const targetMap = new Map<string, Measurement>();
  targetPatches.forEach(patch => targetMap.set(patch.SAMPLE_ID, patch));

  const matched: MatchedPatch[] = [];
  refPatches.forEach(refPatch => {
    const targetPatch = targetMap.get(refPatch.SAMPLE_ID);
    if (targetPatch) {
      matched.push({ ref: refPatch, target: targetPatch, sampleId: refPatch.SAMPLE_ID });
    }
  });
  return matched;
}

function calculatePearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

function calculateSpectralCorrelation(matchedPatches: MatchedPatch[]): number {
  const refValues: number[] = [];
  const targetValues: number[] = [];

  for (const p of matchedPatches) {
    if (p.ref.spectra && p.target.spectra && p.ref.spectra.length === p.target.spectra.length) {
      refValues.push(...p.ref.spectra);
      targetValues.push(...p.target.spectra);
    }
  }

  if (refValues.length === 0) return 0;
  return calculatePearsonCorrelation(refValues, targetValues);
}

// XYZ correlation — linear tristimulus, correct space for affine hypothesis
function calculateXYZCorrelation(matchedPatches: MatchedPatch[]): number {
  const refXYZ: number[] = [];
  const tgtXYZ: number[] = [];

  for (const p of matchedPatches) {
    if (!p.ref.spectra || !p.target.spectra) continue;
    const [rx, ry, rz] = spectraToXYZ(p.ref.spectra);
    const [tx, ty, tz] = spectraToXYZ(p.target.spectra);
    refXYZ.push(rx, ry, rz);
    tgtXYZ.push(tx, ty, tz);
  }

  if (refXYZ.length === 0) return 0;
  return calculatePearsonCorrelation(refXYZ, tgtXYZ);
}

// Per-patch spectral Pearson r² — how linearly related are ref/target spectra for each patch
function calculateMeanPerPatchSpectralR2(matchedPatches: MatchedPatch[]): number | undefined {
  const r2s: number[] = [];

  for (const p of matchedPatches) {
    if (!p.ref.spectra || !p.target.spectra || p.ref.spectra.length !== p.target.spectra.length) continue;
    const r = calculatePearsonCorrelation(p.ref.spectra, p.target.spectra);
    r2s.push(r * r);
  }

  if (r2s.length === 0) return undefined;
  return r2s.reduce((a, b) => a + b, 0) / r2s.length;
}

// CV of per-wavelength slope a(λ): fit R_target(λ) = a(λ)*R_ref(λ) across all patches
// Low CV → substrate effect is spectrally flat (simple scalar per λ consistent across inks)
function calculateSpectralSlopeCV(matchedPatches: MatchedPatch[]): number | undefined {
  const withSpec = matchedPatches.filter(
    p => p.ref.spectra && p.target.spectra && p.ref.spectra.length === p.target.spectra.length
  );
  if (withSpec.length < 5) return undefined;

  const nWL = withSpec[0].ref.spectra!.length;
  const slopes: number[] = [];

  for (let wi = 0; wi < nWL; wi++) {
    const xs = withSpec.map(p => p.ref.spectra![wi]);
    const ys = withSpec.map(p => p.target.spectra![wi]);
    // OLS slope through origin: a = Σ(x·y) / Σ(x²)
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
    const sumX2 = xs.reduce((s, x) => s + x * x, 0);
    if (sumX2 > 0) slopes.push(sumXY / sumX2);
  }

  if (slopes.length < 2) return undefined;
  const mean = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const std = Math.sqrt(slopes.reduce((s, v) => s + (v - mean) ** 2, 0) / slopes.length);
  return mean > 0 ? std / mean : undefined;
}

function calculateResidualCorrelation(residuals: Array<{ L: number; a: number; b: number }>): number {
  const flat = residuals.flatMap(r => [r.L, r.a, r.b]);
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  const variance = flat.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / flat.length;
  const stdDev = Math.sqrt(variance);
  return Math.max(0, 1 - stdDev / 10);
}

// R² as mean of per-channel Pearson r² (correct for simple linear regression)
function calculateRSquared(matchedPatches: MatchedPatch[]): number {
  if (matchedPatches.length < 2) return 0;

  const channels = [
    [matchedPatches.map(p => p.ref.LAB_L), matchedPatches.map(p => p.target.LAB_L)],
    [matchedPatches.map(p => p.ref.LAB_A), matchedPatches.map(p => p.target.LAB_A)],
    [matchedPatches.map(p => p.ref.LAB_B), matchedPatches.map(p => p.target.LAB_B)],
  ];

  const r2s = channels.map(([ref, tgt]) => {
    const r = calculatePearsonCorrelation(ref, tgt);
    return r * r;
  });

  return r2s.reduce((a, b) => a + b, 0) / r2s.length;
}

function getDominantChannel(measurement: Measurement): string {
  if (measurement.RGB_R !== undefined) {
    const r = measurement.RGB_R ?? 0;
    const g = measurement.RGB_G ?? 0;
    const b = measurement.RGB_B ?? 0;
    if (r >= g && r >= b) return 'R';
    if (g >= r && g >= b) return 'G';
    return 'B';
  }
  const vals = [measurement.CMYK_C, measurement.CMYK_M, measurement.CMYK_Y, measurement.CMYK_K];
  const labels = ['C', 'M', 'Y', 'K'];
  return labels[vals.indexOf(Math.max(...vals))];
}

function calculateSlopeStability(matchedPatches: MatchedPatch[]): number {
  if (matchedPatches.length < 2) return 0;

  const groups: Record<string, Array<{ ref: number; target: number }>> = {};

  matchedPatches.forEach(p => {
    const ch = getDominantChannel(p.ref);
    if (!groups[ch]) groups[ch] = [];
    groups[ch].push({ ref: p.ref.LAB_L, target: p.target.LAB_L });
  });

  const slopes: number[] = [];
  Object.values(groups).forEach(group => {
    if (group.length >= 2) {
      const slope = calculateLinearSlope(group.map(g => g.ref), group.map(g => g.target));
      if (isFinite(slope)) slopes.push(slope);
    }
  });

  if (slopes.length === 0) return 0;

  const meanSlope = slopes.reduce((a, b) => a + b, 0) / slopes.length;
  const variance = slopes.reduce((sum, s) => sum + Math.pow(s - meanSlope, 2), 0) / slopes.length;
  const stdDev = Math.sqrt(variance);
  const cv = meanSlope !== 0 ? stdDev / Math.abs(meanSlope) : stdDev;
  return Math.max(0, 1 - cv);
}

function calculateLinearSlope(x: number[], y: number[]): number {
  if (x.length < 2) return 0;
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

function calculateMeanDeltaEAfterCorrection(matchedPatches: MatchedPatch[]): number {
  if (matchedPatches.length === 0) return Infinity;

  const corrections = {
    L: matchedPatches.reduce((sum, p) => sum + (p.target.LAB_L - p.ref.LAB_L), 0) / matchedPatches.length,
    a: matchedPatches.reduce((sum, p) => sum + (p.target.LAB_A - p.ref.LAB_A), 0) / matchedPatches.length,
    b: matchedPatches.reduce((sum, p) => sum + (p.target.LAB_B - p.ref.LAB_B), 0) / matchedPatches.length,
  };

  const deltaEs = matchedPatches.map(p => {
    const cL = p.target.LAB_L - corrections.L;
    const ca = p.target.LAB_A - corrections.a;
    const cb = p.target.LAB_B - corrections.b;
    return calculateDeltaE(p.ref.LAB_L, p.ref.LAB_A, p.ref.LAB_B, cL, ca, cb);
  });

  return deltaEs.reduce((sum, de) => sum + de, 0) / deltaEs.length;
}

function calculateDeltaE(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cm = (C1 + C2) / 2;
  const dL = L2 - L1;
  const dC = C2 - C1;
  const dH = Math.sqrt(Math.max(0, (a2 - a1) ** 2 + (b2 - b1) ** 2 - dC * dC));
  return Math.sqrt((dL / 1) ** 2 + (dC / (1 + 0.045 * Cm)) ** 2 + (dH / (1 + 0.015 * Cm)) ** 2);
}

function determineConfidenceLevel(
  pearsonCorr: number,
  rSquared: number,
  slopeStability: number
): 'high' | 'medium' | 'low' {
  const avgScore = (pearsonCorr + rSquared + slopeStability) / 3;
  if (avgScore >= 0.85) return 'high';
  if (avgScore >= 0.65) return 'medium';
  return 'low';
}
