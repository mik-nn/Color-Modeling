// src/lib/dataset/matrix.ts
//
// Build dense Float64 matrices from ProfileData for math-heavy code paths.
// Patches are ordered by SAMPLE_ID so the same patch indexes refer to the same
// device value across all profiles built from the identical target chart.

import type { Measurement, ProfileData } from '../../types';

export interface ProfileMatrices {
  /** N×L spectral reflectance, row-major; rows ordered by sortedSampleIds. */
  X: Float64Array;
  /** N×3 device addressing values (RGB 0–255 or CMYK 0–100 in [c,m,y,k] order). */
  D: Float64Array;
  /** Device channel count (3 for RGB, 4 for CMYK). */
  channels: 3 | 4;
  /** Patch count. */
  N: number;
  /** Wavelength count (typically 36). */
  L: number;
  /** [380, 390, ..., 730] (or whatever the source provides). */
  wavelengths: number[];
  /** SAMPLE_IDs in the order of matrix rows. */
  sampleIds: string[];
  /** Patches with spectra but missing required fields are dropped; this counts them. */
  droppedCount: number;
}

/** Stable SAMPLE_ID sort: row→col→page lex order. */
function compareSampleIds(a: string, b: string): number {
  // Common form: R{row}C{col}P{page}. Fall back to plain string compare otherwise.
  const re = /^R(\d+)C(\d+)P(\d+)$/;
  const ma = a.match(re);
  const mb = b.match(re);
  if (ma && mb) {
    const ra = +ma[1], rb = +mb[1];
    if (ra !== rb) return ra - rb;
    const ca = +ma[2], cb = +mb[2];
    if (ca !== cb) return ca - cb;
    return +ma[3] - +mb[3];
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function pickChannels(m: Measurement): { channels: 3 | 4; values: number[] } | null {
  if (m.device) {
    if (m.device.space === 'rgb' && m.device.values.length >= 3) {
      return { channels: 3, values: m.device.values.slice(0, 3) };
    }
    if (m.device.space === 'cmyk' && m.device.values.length >= 4) {
      return { channels: 4, values: m.device.values.slice(0, 4) };
    }
  }
  if (m.RGB_R !== undefined && m.RGB_G !== undefined && m.RGB_B !== undefined) {
    return { channels: 3, values: [m.RGB_R, m.RGB_G, m.RGB_B] };
  }
  const cmykNonZero = m.CMYK_C !== 0 || m.CMYK_M !== 0 || m.CMYK_Y !== 0 || m.CMYK_K !== 0;
  if (cmykNonZero) {
    return { channels: 4, values: [m.CMYK_C, m.CMYK_M, m.CMYK_Y, m.CMYK_K] };
  }
  return null;
}

/**
 * Build (X, D) matrices for one profile.
 *
 * Drops patches without spectra or without device values. Throws if the profile
 * is mixed CMYK + RGB (uncommon; would need a per-row channel descriptor).
 */
export function loadProfileMatrix(profile: ProfileData): ProfileMatrices {
  const candidates: { id: string; m: Measurement; dev: { channels: 3 | 4; values: number[] } }[] = [];
  let dropped = 0;

  for (const m of profile.raw) {
    if (!m.spectra || m.spectra.length === 0) { dropped++; continue; }
    const dev = pickChannels(m);
    if (!dev) { dropped++; continue; }
    candidates.push({ id: m.SAMPLE_ID, m, dev });
  }

  if (candidates.length === 0) {
    throw new Error(`loadProfileMatrix: no usable patches in profile ${profile.metadata.full_name}`);
  }

  const channels = candidates[0].dev.channels;
  for (const c of candidates) {
    if (c.dev.channels !== channels) {
      throw new Error(
        `loadProfileMatrix: mixed device channels in ${profile.metadata.full_name} ` +
          `(found ${c.dev.channels} alongside ${channels})`,
      );
    }
  }

  const L = candidates[0].m.spectra!.length;
  for (const c of candidates) {
    if (c.m.spectra!.length !== L) {
      throw new Error(
        `loadProfileMatrix: heterogeneous spectral length in ${profile.metadata.full_name} ` +
          `(found ${c.m.spectra!.length} alongside ${L})`,
      );
    }
  }

  candidates.sort((a, b) => compareSampleIds(a.id, b.id));

  const N = candidates.length;
  const X = new Float64Array(N * L);
  const D = new Float64Array(N * channels);
  const sampleIds: string[] = new Array(N);

  for (let i = 0; i < N; i++) {
    const c = candidates[i];
    sampleIds[i] = c.id;
    const spectra = c.m.spectra!;
    for (let l = 0; l < L; l++) X[i * L + l] = spectra[l];
    const vals = c.dev.values;
    for (let j = 0; j < channels; j++) D[i * channels + j] = vals[j];
  }

  const wavelengths = candidates[0].m.wavelengths
    ?? profile.wavelengths
    ?? Array.from({ length: L }, (_, j) => 380 + j * 10);

  return { X, D, channels, N, L, wavelengths, sampleIds, droppedCount: dropped };
}

/**
 * For two profiles built from the identical target chart, return the intersection
 * of their sample-ID sets in matrix order, plus the row indices in each profile
 * matrix that correspond to the shared IDs. Use this before any cross-profile math.
 */
export function alignByCommonSampleIds(
  a: ProfileMatrices,
  b: ProfileMatrices,
): { sampleIds: string[]; idxA: Int32Array; idxB: Int32Array } {
  const positionInA = new Map<string, number>();
  for (let i = 0; i < a.sampleIds.length; i++) positionInA.set(a.sampleIds[i], i);

  const shared: string[] = [];
  const idxA: number[] = [];
  const idxB: number[] = [];
  for (let j = 0; j < b.sampleIds.length; j++) {
    const id = b.sampleIds[j];
    const ai = positionInA.get(id);
    if (ai !== undefined) {
      shared.push(id);
      idxA.push(ai);
      idxB.push(j);
    }
  }

  return {
    sampleIds: shared,
    idxA: Int32Array.from(idxA),
    idxB: Int32Array.from(idxB),
  };
}
