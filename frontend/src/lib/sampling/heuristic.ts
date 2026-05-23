// src/lib/sampling/heuristic.ts
//
// S1 — Heuristic forced anchor set for cross-substrate transfer.
//
// Picks "obvious" patches that any reasonable transfer model needs to see:
//   - paper white (RGB = 255,255,255)            1
//   - 6 RGB primaries  (binary corners ≠ paper)  6
//   - black (RGB = 0,0,0)                        1
//   - 5 neutrals along the diagonal              5
// = 13 anchors (default). Tunable via NeutralCount option.
//
// Deterministic: same dataset → same anchors. No randomness.

import type { AnchorSet } from '../../types';
import type { ProfileMatrices } from '../dataset/matrix';

interface CornerTarget {
  name: string;
  rgb: readonly [number, number, number];
}

const RGB_CORNERS: CornerTarget[] = [
  { name: 'paper',   rgb: [255, 255, 255] },
  { name: 'red',     rgb: [255,   0,   0] },
  { name: 'green',   rgb: [  0, 255,   0] },
  { name: 'blue',    rgb: [  0,   0, 255] },
  { name: 'cyan',    rgb: [  0, 255, 255] },
  { name: 'magenta', rgb: [255,   0, 255] },
  { name: 'yellow',  rgb: [255, 255,   0] },
  { name: 'black',   rgb: [  0,   0,   0] },
];

export interface HeuristicAnchorOptions {
  /** How many neutrals (R=G=B) to include on top of corners. Default 5. */
  neutralCount?: number;
  /** Override the corner set (test only). */
  corners?: CornerTarget[];
}

function squaredDist(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Find the nearest patch in `D` (N×3 row-major RGB 0–255) to a target RGB.
 * Returns its row index, or -1 if N === 0.
 */
function nearestRgbIdx(D: Float64Array, N: number, target: readonly [number, number, number]): number {
  let bestIdx = -1;
  let bestD = Infinity;
  for (let i = 0; i < N; i++) {
    const d = squaredDist([D[i * 3], D[i * 3 + 1], D[i * 3 + 2]], target);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Pick the N most evenly spaced neutrals (R=G=B) from the profile. The dataset
 * may not contain exact R=G=B patches, so we pick the patches whose RGB triple
 * is closest to a target gray level for each of `neutralCount` evenly spaced
 * levels in [16, 240] (excluding the endpoints to avoid double-counting paper
 * and black).
 */
function pickNeutrals(D: Float64Array, N: number, neutralCount: number, takenIdx: Set<number>): number[] {
  if (neutralCount <= 0) return [];
  const out: number[] = [];
  const lo = 16;
  const hi = 240;
  const step = neutralCount === 1 ? 0 : (hi - lo) / (neutralCount - 1);
  for (let s = 0; s < neutralCount; s++) {
    const level = neutralCount === 1 ? 128 : lo + step * s;
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = 0; i < N; i++) {
      if (takenIdx.has(i)) continue;
      const r = D[i * 3], g = D[i * 3 + 1], b = D[i * 3 + 2];
      // Penalise non-neutrality, then closeness to the target level.
      const neutral = Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
      const levelMiss = Math.abs((r + g + b) / 3 - level);
      const d = neutral * 4 + levelMiss; // weight neutrality heavily
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      out.push(bestIdx);
      takenIdx.add(bestIdx);
    }
  }
  return out;
}

/**
 * Build the heuristic anchor set (S1) for a given profile.
 *
 * Returns the chosen patches as an `AnchorSet` (sample IDs in the order they
 * were picked: corners first, then neutrals). The corresponding row indices
 * into the profile's matrix are available via `chosenIdx` in the meta.
 */
export function pickHeuristicAnchors(
  profile: ProfileMatrices,
  options: HeuristicAnchorOptions = {},
): AnchorSet {
  if (profile.channels !== 3) {
    throw new Error(`pickHeuristicAnchors: RGB-only for now (got ${profile.channels} channels)`);
  }
  const neutralCount = options.neutralCount ?? 5;
  const corners = options.corners ?? RGB_CORNERS;
  const N = profile.N;

  const taken = new Set<number>();
  const pickedIdx: number[] = [];
  const pickedLabels: string[] = [];

  for (const corner of corners) {
    const idx = nearestRgbIdx(profile.D, N, corner.rgb);
    if (idx < 0 || taken.has(idx)) continue;
    taken.add(idx);
    pickedIdx.push(idx);
    pickedLabels.push(corner.name);
  }

  const neutralIdx = pickNeutrals(profile.D, N, neutralCount, taken);
  for (let i = 0; i < neutralIdx.length; i++) {
    pickedIdx.push(neutralIdx[i]);
    pickedLabels.push(`neutral_${i}`);
  }

  const sampleIds = pickedIdx.map(i => profile.sampleIds[i]);

  return {
    sampleIds,
    strategy: 'forced',
    meta: {
      labels: pickedLabels,
      chosenIdx: pickedIdx,
      neutralCount,
      cornerCount: corners.length,
    },
  };
}
