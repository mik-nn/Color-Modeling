// src/lib/predict/oba.ts
//
// Optical Brightening Agent (OBA) detection from a paper-white spectrum.
//
// OBA = fluorescent dye in modern papers. Absorbs UV (≤ 400 nm), re-emits
// in blue (~ 440 nm). Under D50 illuminant (which contains UV), the
// measured paper-white reflectance shows:
//
//   - Depressed R(380–410 nm) — absorbed UV.
//   - Peak at R(440 nm) often > 1.0 — fluorescent re-emission added to
//     the baseline reflectance.
//
// On the same printer, two substrates with different OBA loadings produce
// dramatically different per-λ paper ratios in the 380–440 nm region.
// D1's `r(λ) = B_paper / A_paper` can hit 5–7× there. A3's per-λ affine
// slope explodes similarly. Both are then non-linearly distorted by ink
// coverage because ink absorbs UV and kills the fluorescence locally.
//
// We surface a single OBA score per profile and a mismatch score per
// pair. Predictors use these to clamp ratios; the UI surfaces them so the
// user can interpret head-to-head numbers.
//
// Score definition:
//   oba_score = R_paper(440 nm) / R_paper(550 nm)
// Rationale: 550 nm is a stable midband not affected by OBA fluorescence.
//   - No OBA:         R(440) ≈ R(550) → score ≈ 1.0.
//   - Moderate OBA:   R(440) > R(550) by 5–10 % → score 1.05–1.10.
//   - Heavy OBA:      R(440) > R(550) by 15–25 % → score 1.15–1.25.

export interface OBAInfo {
  /** R(440 nm) / R(550 nm) — see header for interpretation. */
  score: number;
  /** R(380 nm), the canonical "OBA bands are this dark" value. */
  r380: number;
  /** R(440 nm), the fluorescence peak band. */
  r440: number;
  /** R(550 nm), the stable reference band. */
  r550: number;
  /** True when score deviates from 1.0 by more than `obaThreshold`. */
  hasOBA: boolean;
}

export interface OBAOptions {
  /** Wavelength of the first spectral band; default 380 nm. */
  startWL?: number;
  /** Step between spectral bands; default 10 nm. */
  step?: number;
  /** Score deviation from 1.0 beyond which `hasOBA` is true. Default 0.04. */
  obaThreshold?: number;
}

/** Resolve a spectral index for a given wavelength, with bounds check. */
function indexFor(wl: number, startWL: number, step: number, length: number): number {
  const idx = Math.round((wl - startWL) / step);
  if (idx < 0 || idx >= length) {
    throw new Error(`OBA: wavelength ${wl} nm out of range [${startWL}, ${startWL + (length - 1) * step}]`);
  }
  return idx;
}

/**
 * Compute the OBA score and accompanying diagnostic values from one
 * paper-white reflectance spectrum.
 */
export function detectOBA(spectrum: ArrayLike<number>, options: OBAOptions = {}): OBAInfo {
  const startWL = options.startWL ?? 380;
  const step = options.step ?? 10;
  const threshold = options.obaThreshold ?? 0.04;
  if (spectrum.length < 4) {
    throw new Error(`detectOBA: spectrum too short (${spectrum.length} bands)`);
  }
  const i380 = indexFor(380, startWL, step, spectrum.length);
  const i440 = indexFor(440, startWL, step, spectrum.length);
  const i550 = indexFor(550, startWL, step, spectrum.length);

  const r380 = spectrum[i380];
  const r440 = spectrum[i440];
  const r550 = spectrum[i550];

  const score = r550 > 1e-6 ? r440 / r550 : 1;
  return {
    score,
    r380,
    r440,
    r550,
    hasOBA: Math.abs(score - 1) > threshold,
  };
}

/**
 * Mismatch between two profiles' OBA loadings — used to flag pairs where
 * D1's paper-ratio is expected to perform poorly. Symmetric, non-negative.
 */
export function obaMismatch(a: OBAInfo, b: OBAInfo): number {
  return Math.abs(a.score - b.score);
}

/** Coarse severity bucket for UI colouring. */
export type OBASeverity = 'low' | 'moderate' | 'high';

export function obaMismatchSeverity(mismatch: number): OBASeverity {
  if (mismatch <= 0.05) return 'low';
  if (mismatch <= 0.15) return 'moderate';
  return 'high';
}
