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

export interface Measurement {
  SAMPLE_ID: string;
  CMYK_C: number;
  CMYK_M: number;
  CMYK_Y: number;
  CMYK_K: number;

  LAB_L: number;
  LAB_A: number;
  LAB_B: number;

  RGB_R?: number;
  RGB_G?: number;
  RGB_B?: number;

  spectra?: number[];       // reflectance 0–1, 10nm step
  wavelengths?: number[];   // [380, 390, ..., 730]

  deltaE00?: number;
  is_outlier?: boolean;
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
