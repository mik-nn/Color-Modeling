// src/types/index.ts

export interface ProfileMetadata {
  full_name: string;
  brand: string;
  series: string;
  printer: string;
  ink: string;
  substrate: string;
  parsed_at: string;
}

// ─── DeviceSpace abstraction ────────────────────────────────────────────────
// All new analyser code should read `device` and branch on `device.space`.
// The legacy RGB_*/CMYK_* fields on Measurement remain populated for back-
// compat until every analyser is ported. See docs/ONTOLOGY.md §3.1.

export type DeviceSpace = 'rgb' | 'cmyk';

export interface DeviceValue {
  space: DeviceSpace;
  // RGB:  [r, g, b] in 0–255 (device addressing — 0 = max ink, 255 = no ink).
  // CMYK: [c, m, y, k] in 0–100 (nominal coverage percent).
  values: number[];
}

/** Project an RGB or CMYK device value into CMY [0–1] for cube-based models. */
export function toCMY(d: DeviceValue): [number, number, number] {
  if (d.space === 'rgb') {
    const [r, g, b] = d.values;
    return [(255 - r) / 255, (255 - g) / 255, (255 - b) / 255];
  }
  // CMYK → CMY with K composited multiplicatively onto each channel.
  const [c, m, y, k] = d.values;
  const kk = k / 100;
  return [
    Math.min(1, c / 100 + kk - (c / 100) * kk),
    Math.min(1, m / 100 + kk - (m / 100) * kk),
    Math.min(1, y / 100 + kk - (y / 100) * kk),
  ];
}

/** Project to CMYK [0–100]; pass-through for cmyk, K=0 for rgb. */
export function toCMYK(d: DeviceValue): [number, number, number, number] {
  if (d.space === 'cmyk') {
    return [d.values[0], d.values[1], d.values[2], d.values[3]];
  }
  const [c, m, y] = toCMY(d);
  return [c * 100, m * 100, y * 100, 0];
}

export interface Measurement {
  SAMPLE_ID: string;

  // ── primary measurement: spectral reflectance (when present) ──
  spectra?: number[];       // reflectance 0–1, length 36
  wavelengths?: number[];   // [380, 390, ..., 730]

  // ── device-addressing values, dual representation during migration ──
  /** New canonical field — populate from parsers going forward. */
  device?: DeviceValue;
  /** Legacy RGB fields (still populated by current parsers; prefer `device`). */
  RGB_R?: number;
  RGB_G?: number;
  RGB_B?: number;
  /** Legacy CMYK fields (RGB profiles set these to 0; CMYK parsers populate). */
  CMYK_C: number;
  CMYK_M: number;
  CMYK_Y: number;
  CMYK_K: number;

  // ── derived colorimetric (informational) ──
  LAB_L: number;
  LAB_A: number;
  LAB_B: number;

  // ── optional derived flags ──
  deltaE00?: number;
  is_outlier?: boolean;
}

/** Build the canonical `device` field from a Measurement that only has legacy fields. */
export function deriveDevice(m: Measurement): DeviceValue | undefined {
  if (m.device) return m.device;
  if (m.RGB_R !== undefined && m.RGB_G !== undefined && m.RGB_B !== undefined) {
    return { space: 'rgb', values: [m.RGB_R, m.RGB_G, m.RGB_B] };
  }
  if (m.CMYK_C !== 0 || m.CMYK_M !== 0 || m.CMYK_Y !== 0 || m.CMYK_K !== 0) {
    return { space: 'cmyk', values: [m.CMYK_C, m.CMYK_M, m.CMYK_Y, m.CMYK_K] };
  }
  return undefined;
}

export interface ProfileData {
  metadata: ProfileMetadata;
  raw: Measurement[];
  clean: Measurement[];
  has_spectral: boolean;
  patch_count: number;
  average_deltaE_raw_clean?: number;
  wavelengths?: number[];
}

// ─── Data-driven track types (Phase 1 shared infra) ────────────────────────────

/** Tristimulus white point on the Y=100 scale (matches spectraToXYZ output). */
export type WhitePointXYZ = readonly [number, number, number];

/** Per-channel saturation limits detected by the ink-limit pipeline. */
export interface SaturationLimits {
  /** Single-channel limits, 0–1 effective coverage. */
  perChannel: { C?: number; M?: number; Y?: number; K?: number };
  /** Optional 2-/3-/4-ink combo limits keyed by channel string ('CY', 'MY', 'CM', 'CMY'). */
  combos?: Record<string, number>;
  /** ISO 8601 timestamp of detection run. */
  detectedAt: string;
  /** Module identifier + semver so we can invalidate stale runs. */
  detectorVersion: string;
}

/** A chosen subset of sample IDs used as anchors / calibration patches. */
export interface AnchorSet {
  /** SAMPLE_IDs (e.g. "R3C12P1") of selected anchors. */
  sampleIds: string[];
  /** How the set was chosen — must match a strategy in lib/sampling. */
  strategy: 'forced' | 'random' | 'latinHypercube' | 'dOptimal' | 'greedyUncertainty' | 'fixed';
  /** Free-form metadata so the strategy can document what it did. */
  meta?: Record<string, unknown>;
}

/** Aggregated quality numbers from evaluating a prediction against ground truth. */
export interface PredictionReport {
  /** Identifier for the predictor variant (e.g. 'A3_perLambdaAffine'). */
  variant: string;
  /** Anchor count actually used (Task 2) or calibration patch count (Task 1). */
  k: number;
  /** Median CIEDE2000 across evaluated patches, paper-relative D50/2°. */
  medianDE00: number;
  /** 95th percentile CIEDE2000. */
  p95DE00: number;
  /** Mean per-patch spectral R² between predicted and measured reflectance. */
  meanSpectralR2: number;
  /** Mean per-patch RMS of (R_pred − R_meas), reflectance units 0–1. */
  meanRMS: number;
  /** Five worst patches by ΔE00 (sample IDs for inspection). */
  worstPatchSampleIds: string[];
  /** Paper-relative white point used for ΔE00. */
  paperWP: WhitePointXYZ;
  /** Task 2 only: reference profile filename. */
  refProfile?: string;
  /** Target profile filename. */
  targetProfile: string;
  /** Number of test patches the report aggregates over. */
  nTest: number;
}
