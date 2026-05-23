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

export interface MatchedPatchPair {
  sampleId: string;
  ref: Measurement;
  target: Measurement;
}

// Paper-normalized T(λ) = R_ink(λ) / R_paper(λ) — linear ink absorption test
export interface InkRatioResult {
  channel: string;
  n_100: number;
  n_50: number;
  // Pearson r of T_100(λ) curves ref vs target  (T = R_ink / R_paper)
  t_pearson_100?: number;
  // Pearson r of T_50(λ) curves ref vs target
  t_pearson_50?: number;
  // Mean absolute deviation of T_100 ref vs target across wavelengths
  t_mad_100?: number;
  // Pearson r of (T_100/T_50)(λ) ratio curves ref vs target
  t_ratio_pearson?: number;
  // CV of per-wavelength (T_100_target/T_100_ref) — low = uniform multiplicative substrate effect
  t_scale_cv?: number;
}

export interface PatchGroupResult {
  name: string;
  description: string;
  n_patches: number;
  // Spectral Pearson r (linear space, preferred)
  spectral_pearson?: number;
  // XYZ Pearson r
  xyz_pearson?: number;
  // Per-patch mean spectral R²
  mean_spectral_r2?: number;
  // Lab Pearson r across (L,a,b) concatenated (informational)
  pearson_r: number;
  // R² of L* linear regression (target vs ref)
  r_squared_L: number;
  // Slope and intercept of L* linear regression
  slope_L: number;
  intercept_L: number;
  // Lab delta (informational only, not for hypothesis testing)
  mean_delta_L: number;
  mean_delta_a: number;
  mean_delta_b: number;
}

export type PredictionModelType = 'multiplicative' | 'poly1' | 'poly2' | 'poly3' | 'yn' | 'xyz_affine' | 'xyz_poly2';

export interface SpectralPredictionModel {
  model_type: PredictionModelType;
  // poly_coeffs[wi] = [c0, c1, c2, ...] — pred = Σ cj * x^j (or in YN-transformed space)
  poly_coeffs: number[][];
  wavelengths: number[];
  yn_n?: number;             // Yule-Nielsen n factor
  n_calibration: number;
  calibration_ids: string[];
  calibration_label: string;
}

export interface PatchPredictionResult {
  sampleId: string;
  r2: number;
  spectral_mae: number;
}

export interface SpectralPredictionEvaluation {
  model: SpectralPredictionModel;
  n_test: number;
  mean_r2: number;
  min_r2: number;
  p5_r2: number;
  mean_spectral_mae: number;
  patch_results: PatchPredictionResult[];
}

export interface ModelComparisonRow {
  model_type: PredictionModelType;
  calibration_label: string;
  n_calibration: number;
  n_test: number;
  mean_r2: number;
  p5_r2: number;
  mean_spectral_mae: number;
  yn_n?: number;
  feasible: boolean;
}

export interface SpectralModelComparison {
  rows: ModelComparisonRow[];
  best_idx: number;
  best_evaluation: SpectralPredictionEvaluation;
}

// ─── CYNSN types live in lib/analyzers/cynsn.ts (re-exported below for convenience) ─
// CYNSNEvaluation, CYNSNComparisonResult — import directly from cynsn.ts

export interface LinearityResult {
  reference_substrate: string;
  target_substrate: string;
  // Primary: linear spaces
  spectral_pearson_corr?: number;      // Pearson r across all patch spectra
  xyz_pearson_corr?: number;           // Pearson r in XYZ (linear tristimulus)
  mean_spectral_r2?: number;           // mean per-patch spectral R² (how linear each patch is)
  spectral_slope_cv?: number;          // CV of per-wavelength slope a(λ) — substrate spectral uniformity
  // Secondary: perceptual (informational)
  pearson_corr_lab: number;
  pearson_corr_residuals?: number;
  r_squared: number;
  slope_stability_score: number;
  mean_deltaE_after_correction?: number;
  n_patches_used: number;
  linearity_confidence: 'high' | 'medium' | 'low';
  matched_patches?: MatchedPatchPair[];
}
