// src/lib/dataset/matrix.ts
//
// Build dense Float64 matrices from ProfileData for math-heavy code paths.
// Patches are ordered by SAMPLE_ID so the same patch indexes refer to the same
// device value across all profiles built from the identical target chart.

import type { Measurement, ProfileData } from '../../types';
import {
  buildInterpolator,
  regularGrid,
  boundingBox,
  intersectBox,
  inBox,
  looRms,
  type InterpPoint,
} from '../interp/rgbInterp';

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

export interface AlignedGrid {
  /** Synthetic IDs of the form `G:r-g-b` for each grid point. */
  sampleIds: string[];
  /** N×L reflectance for profile A, resampled onto the common grid. */
  X_A: Float64Array;
  /** N×L reflectance for profile B, resampled onto the common grid. */
  X_B: Float64Array;
  /** N×3 grid device values (RGB 0–255). */
  D: Float64Array;
  channels: 3;
  N: number;
  L: number;
}

/**
 * Align two RGB profiles that were measured on DIFFERENT charts (no shared
 * SAMPLE_IDs — e.g. a 905-patch BC chart vs a ~2033-patch MOAB lattice with
 * fractional RGB steps). Both profiles are resampled onto a common regular RGB
 * lattice via per-band k-NN IDW interpolation, producing aligned (X_A, X_B, D)
 * matrices with the same row meaning. Drop-in source for the same downstream
 * predictor pipeline that `alignByCommonSampleIds` feeds.
 *
 * The grid is restricted to the intersection of both profiles' device bounding
 * boxes to avoid extrapolating outside either chart's sampled gamut.
 */
export function alignByDeviceGrid(
  a: ProfileMatrices,
  b: ProfileMatrices,
  levels = 9,
): AlignedGrid {
  if (a.channels !== 3 || b.channels !== 3) {
    throw new Error('alignByDeviceGrid: both profiles must be RGB (3-channel)');
  }
  if (a.L !== b.L) {
    throw new Error(`alignByDeviceGrid: wavelength count mismatch (${a.L} vs ${b.L})`);
  }
  const L = a.L;

  const toPoints = (m: ProfileMatrices): InterpPoint[] => {
    const pts: InterpPoint[] = new Array(m.N);
    for (let i = 0; i < m.N; i++) {
      pts[i] = {
        rgb: [m.D[i * 3], m.D[i * 3 + 1], m.D[i * 3 + 2]],
        spectrum: Array.from(m.X.subarray(i * L, i * L + L)),
      };
    }
    return pts;
  };

  const ptsA = toPoints(a);
  const ptsB = toPoints(b);
  const box = intersectBox(boundingBox(ptsA), boundingBox(ptsB));
  if (!box) {
    return { sampleIds: [], X_A: new Float64Array(0), X_B: new Float64Array(0), D: new Float64Array(0), channels: 3, N: 0, L };
  }

  const interpA = buildInterpolator(ptsA);
  const interpB = buildInterpolator(ptsB);
  const grid = regularGrid(levels).filter((p) => inBox(p, box));
  const N = grid.length;

  const X_A = new Float64Array(N * L);
  const X_B = new Float64Array(N * L);
  const D = new Float64Array(N * 3);
  const sampleIds: string[] = new Array(N);

  for (let i = 0; i < N; i++) {
    const g = grid[i];
    const sa = interpA.query(g);
    const sb = interpB.query(g);
    for (let l = 0; l < L; l++) {
      X_A[i * L + l] = sa[l];
      X_B[i * L + l] = sb[l];
    }
    D[i * 3] = g[0];
    D[i * 3 + 1] = g[1];
    D[i * 3 + 2] = g[2];
    sampleIds[i] = `G:${Math.round(g[0])}-${Math.round(g[1])}-${Math.round(g[2])}`;
  }

  return { sampleIds, X_A, X_B, D, channels: 3, N, L };
}

export interface AlignedProfiles {
  /** Display labels (device-encoded) in row order. */
  sampleIds: string[];
  /** N×L reflectance for reference A — always real measured spectra. */
  X_A: Float64Array;
  /** N×L reflectance for target B — exact where B has the point, else interpolated. */
  X_B: Float64Array;
  /** N×channels device coordinates (A's actual sampled points). */
  D: Float64Array;
  channels: 3 | 4;
  N: number;
  L: number;
  /** B patches matched exactly by device coordinate. */
  exactCount: number;
  /** B patches reconstructed by k-NN IDW interpolation. */
  interpCount: number;
  /** A points dropped because they fall outside B's device bounding box. */
  droppedOutOfGamut: number;
  /** Interpolation noise floor (LOO RMS reflectance over B); null when interpCount === 0. */
  looRms: number | null;
}

/** Quantized device key for exact matching: RGB → integer, CMYK → 2-decimal. */
function deviceKey(d: Float64Array, row: number, channels: 3 | 4): string {
  if (channels === 3) {
    return `${Math.round(d[row * 3])}_${Math.round(d[row * 3 + 1])}_${Math.round(d[row * 3 + 2])}`;
  }
  let s = '';
  for (let c = 0; c < 4; c++) s += (c ? '_' : '') + d[row * 4 + c].toFixed(2);
  return s;
}

/**
 * Align two profiles by DEVICE COORDINATE (the invariant across files), not by
 * position or string ID. Query grid is A's actual device points: A keeps its real
 * measured spectra; for each A point, B's spectrum is taken exactly when B has that
 * device coordinate, otherwise reconstructed by k-NN IDW interpolation from B's
 * neighbours. A points outside B's device bounding box are dropped (no extrapolation).
 *
 * Unifies the former exact-match (`alignByCommonSampleIds`) and grid-resample
 * (`alignByDeviceGrid`) paths into one. RGB only for interpolation; CMYK exact-match
 * works but interpolation throws (needs 4D IDW — see spec §2.3).
 */
export function alignProfiles(
  a: ProfileMatrices,
  b: ProfileMatrices,
  opts: { k?: number; power?: number } = {},
): AlignedProfiles {
  if (a.channels !== b.channels) {
    throw new Error(`alignProfiles: device channel mismatch (A=${a.channels}, B=${b.channels})`);
  }
  if (a.L !== b.L) {
    throw new Error(`alignProfiles: wavelength count mismatch (${a.L} vs ${b.L})`);
  }
  const channels = a.channels;
  const L = a.L;

  // B exact-match lookup by quantized device key.
  const bByKey = new Map<string, number>();
  for (let j = 0; j < b.N; j++) bByKey.set(deviceKey(b.D, j, channels), j);

  // Resolve each A row: exact B row index, or -1 meaning "needs interpolation".
  const exactRow = new Int32Array(a.N);
  let anyInterp = false;
  for (let i = 0; i < a.N; i++) {
    const j = bByKey.get(deviceKey(a.D, i, channels));
    if (j !== undefined) {
      exactRow[i] = j;
    } else {
      exactRow[i] = -1;
      anyInterp = true;
    }
  }

  // Build interpolation machinery only if some A point misses an exact B match.
  let interp: ReturnType<typeof buildInterpolator> | null = null;
  let bbox: ReturnType<typeof boundingBox> | null = null;
  let looRmsVal: number | null = null;
  if (anyInterp) {
    if (channels !== 3) {
      throw new Error('alignProfiles: CMYK interpolation not yet implemented; need 4D IDW');
    }
    const bPoints: InterpPoint[] = new Array(b.N);
    for (let j = 0; j < b.N; j++) {
      bPoints[j] = {
        rgb: [b.D[j * 3], b.D[j * 3 + 1], b.D[j * 3 + 2]],
        spectrum: Array.from(b.X.subarray(j * L, j * L + L)),
      };
    }
    interp = buildInterpolator(bPoints, opts);
    bbox = boundingBox(bPoints);
    looRmsVal = b.N >= 2 ? looRms(bPoints, opts) : null;
  }

  // Decide which A rows survive (exact, or interpolatable inside B's bbox).
  const keptA: number[] = [];
  let exactCount = 0;
  let interpCount = 0;
  let droppedOutOfGamut = 0;
  for (let i = 0; i < a.N; i++) {
    if (exactRow[i] >= 0) {
      keptA.push(i);
      exactCount++;
      continue;
    }
    const rgb: [number, number, number] = [a.D[i * 3], a.D[i * 3 + 1], a.D[i * 3 + 2]];
    if (bbox && inBox(rgb, bbox)) {
      keptA.push(i);
      interpCount++;
    } else {
      droppedOutOfGamut++;
    }
  }

  const N = keptA.length;
  const X_A = new Float64Array(N * L);
  const X_B = new Float64Array(N * L);
  const D = new Float64Array(N * channels);
  const sampleIds: string[] = new Array(N);

  for (let r = 0; r < N; r++) {
    const i = keptA[r];
    for (let l = 0; l < L; l++) X_A[r * L + l] = a.X[i * L + l];
    for (let c = 0; c < channels; c++) D[r * channels + c] = a.D[i * channels + c];

    const bj = exactRow[i];
    if (bj >= 0) {
      for (let l = 0; l < L; l++) X_B[r * L + l] = b.X[bj * L + l];
    } else {
      const s = interp!.query([a.D[i * 3], a.D[i * 3 + 1], a.D[i * 3 + 2]]);
      for (let l = 0; l < L; l++) X_B[r * L + l] = s[l];
    }

    if (channels === 3) {
      sampleIds[r] = `RGB_${Math.round(D[r * 3])}_${Math.round(D[r * 3 + 1])}_${Math.round(D[r * 3 + 2])}`;
    } else {
      sampleIds[r] = `CMYK_${deviceKey(D, r, channels)}`;
    }
  }

  return {
    sampleIds,
    X_A,
    X_B,
    D,
    channels,
    N,
    L,
    exactCount,
    interpCount,
    droppedOutOfGamut,
    looRms: interpCount > 0 ? looRmsVal : null,
  };
}
