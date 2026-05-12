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

  // Спектральные данные — нормализованный формат
  spectra?: number[];           // значения отражения
  wavelengths?: number[];       // [380, 390, ..., 730]

  // Вычисляемые
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

export interface LinearityResult {
  reference_substrate: string;
  target_substrate: string;
  pearson_corr_lab: number;
  pearson_corr_residuals?: number;
  r_squared: number;
  slope_stability_score: number;
  mean_deltaE_after_correction?: number;
  n_patches_used: number;
  linearity_confidence: 'high' | 'medium' | 'low';
}