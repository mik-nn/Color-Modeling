// src/lib/analyzers/limitsAnalyzer.ts
//
// Auto-detect per-ramp ink limits based on Neugebauer linear prediction error.
//
// Model: for a primary ramp (one ink varies, other two = 0), Lab is predicted
// by linear XYZ mixing between paper-white and the maximum-ink endpoint:
//
//   XYZ(t) = (1 − t) · XYZ_paper + t · XYZ_primary
//
// where t = ink_level / max_ink_level ∈ [0, 1].
// Lab is then converted from the predicted XYZ.
//
// ΔE76 is computed between measured and predicted Lab for each patch.
// Limit = maximum ink where ALL preceding patches have ΔE < threshold.
// (First scan for the highest-ink overflow patch; limit = ink of patch before it.)
//
// After filtering to within-limit, rescale ink so limit → 255 (= 100%),
// enabling fair cross-profile comparison at equivalent relative ink levels.

import { Measurement, ProfileData } from '../../types';
import { spectraToXYZ, labToXYZ } from '../colormath';
import { InkLimits } from '../../components/InkLimitSection';

// ─── ΔE76 ────────────────────────────────────────────────────────────────────

function de76(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  return Math.sqrt((L1-L2)**2 + (a1-a2)**2 + (b1-b2)**2);
}

// ─── XYZ → Lab (D50, Y=100 scale) ───────────────────────────────────────────

function xyzToLabD50(X: number, Y: number, Z: number): [number, number, number] {
  // D50 white point XYZ (Y=100): X=96.422, Y=100, Z=82.521
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [
    116 * f(Y / 100)     - 16,
    500 * (f(X / 96.422) - f(Y / 100)),
    200 * (f(Y / 100)    - f(Z / 82.521)),
  ];
}

// ─── XYZ from a measurement (spectral preferred, Lab fallback) ────────────────

function measurementXYZ(ms: Measurement): [number, number, number] {
  if (ms.spectra && ms.spectra.length > 0) {
    const startWL = ms.wavelengths?.[0] ?? 380;
    return spectraToXYZ(ms.spectra, startWL);  // Y=100 scale
  }
  return labToXYZ(ms.LAB_L, ms.LAB_A, ms.LAB_B);
}

// ─── Per-ramp error computation ───────────────────────────────────────────────

export interface RampPoint {
  ink: number;          // CMY ink level 0–255 (= 255 − channel_value)
  inkFrac: number;      // normalised [0, 1] (ink / max_ink)
  measuredLab:  [number, number, number];
  predictedLab: [number, number, number];
  de: number;           // ΔE76
}

/**
 * Compute Neugebauer linear prediction errors for a primary ramp.
 * @param patches  All measurements that belong to this ramp (unsorted).
 * @param inkOf    Extracts ink level (0–255) from a measurement.
 */
export function computeRampErrors(
  patches: Measurement[],
  inkOf: (ms: Measurement) => number,
): RampPoint[] {
  if (patches.length < 2) return [];

  const sorted = [...patches].sort((a, b) => inkOf(a) - inkOf(b));
  const paper   = sorted[0];
  const primary = sorted[sorted.length - 1];
  const maxInk  = inkOf(primary);
  if (maxInk === 0) return [];

  const [pX, pY, pZ] = measurementXYZ(paper);
  const [rX, rY, rZ] = measurementXYZ(primary);

  return sorted.map(ms => {
    const ink = inkOf(ms);
    const t = ink / maxInk;

    const predX = (1 - t) * pX + t * rX;
    const predY = (1 - t) * pY + t * rY;
    const predZ = (1 - t) * pZ + t * rZ;
    const predicted = xyzToLabD50(predX, predY, predZ);

    return {
      ink,
      inkFrac: t,
      measuredLab:  [ms.LAB_L, ms.LAB_A, ms.LAB_B],
      predictedLab: predicted,
      de: de76(ms.LAB_L, ms.LAB_A, ms.LAB_B, ...predicted),
    };
  });
}

// ─── Limit detection ──────────────────────────────────────────────────────────

/**
 * Returns the highest ink level (0–255) where all patches at or below it
 * have ΔE < threshold.  Returns 255 if no overflow detected.
 */
export function findRampLimit(points: RampPoint[], threshold: number): number {
  // Work from highest ink down; find the first patch that overflows.
  // Limit = ink level of the patch just before that point.
  for (let i = points.length - 1; i >= 1; i--) {
    if (points[i].de > threshold) {
      return points[i - 1].ink;
    }
  }
  return 255; // all within threshold
}

// ─── Full auto-detect for one profile ────────────────────────────────────────

export interface RampErrors {
  C: RampPoint[]; M: RampPoint[]; Y: RampPoint[];
}

export interface AutoLimitResult {
  limits: Pick<InkLimits, 'C' | 'M' | 'Y'>;
  errors: RampErrors;
}

export function autoDetectLimits(
  profile: ProfileData,
  deThreshold = 2.0,
): AutoLimitResult {
  const src = profile.clean;

  const C_patches = src.filter(ms =>
    ms.RGB_G === 255 && ms.RGB_B === 255 && ms.RGB_R !== undefined);
  const M_patches = src.filter(ms =>
    ms.RGB_R === 255 && ms.RGB_B === 255 && ms.RGB_G !== undefined);
  const Y_patches = src.filter(ms =>
    ms.RGB_R === 255 && ms.RGB_G === 255 && ms.RGB_B !== undefined);

  const errC = computeRampErrors(C_patches, ms => 255 - (ms.RGB_R ?? 255));
  const errM = computeRampErrors(M_patches, ms => 255 - (ms.RGB_G ?? 255));
  const errY = computeRampErrors(Y_patches, ms => 255 - (ms.RGB_B ?? 255));

  return {
    limits: {
      C: findRampLimit(errC, deThreshold),
      M: findRampLimit(errM, deThreshold),
      Y: findRampLimit(errY, deThreshold),
    },
    errors: { C: errC, M: errM, Y: errY },
  };
}

// ─── Ink rescaling ────────────────────────────────────────────────────────────

/**
 * Rescale a single Measurement so that the ink limit → 255 (= 100%).
 * ink_raw / limit → ink_normalised → new_channel = 255 − ink_normalised * 255
 *
 * Only primary C/M/Y limits are rescaled; overprint limits (CM/CY/MY) are
 * derived limits and do not need independent rescaling.
 *
 * Patches with ink > limit are clamped to limit before rescaling.
 */
export function rescaleMeasurement(ms: Measurement, limits: Pick<InkLimits, 'C' | 'M' | 'Y'>): Measurement {
  const r = ms.RGB_R, g = ms.RGB_G, b = ms.RGB_B;
  if (r === undefined || g === undefined || b === undefined) return ms;

  const scale = (channel: number, limit: number): number => {
    if (limit <= 0) return 255;
    const ink = Math.min(255 - channel, limit);  // clamp to limit
    return Math.round(255 - ink * 255 / limit);
  };

  return {
    ...ms,
    RGB_R: scale(r, limits.C),
    RGB_G: scale(g, limits.M),
    RGB_B: scale(b, limits.Y),
  };
}

/**
 * Rescale all matched patches so both ref and target ink axes are normalised
 * to their respective limits. Use this before running the cross-profile model.
 */
export function rescaleMatchedPatches(
  pairs: import('../../types').MatchedPatchPair[],
  refLimits:    Pick<InkLimits, 'C' | 'M' | 'Y'>,
  targetLimits: Pick<InkLimits, 'C' | 'M' | 'Y'>,
): import('../../types').MatchedPatchPair[] {
  const needsScale = (l: Pick<InkLimits, 'C' | 'M' | 'Y'>) =>
    l.C < 255 || l.M < 255 || l.Y < 255;

  if (!needsScale(refLimits) && !needsScale(targetLimits)) return pairs;

  return pairs.map(p => ({
    ...p,
    ref:    needsScale(refLimits)    ? rescaleMeasurement(p.ref,    refLimits)    : p.ref,
    target: needsScale(targetLimits) ? rescaleMeasurement(p.target, targetLimits) : p.target,
  }));
}
