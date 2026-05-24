// src/lib/sampling/channelRamp.ts
//
// S3 — Single-channel ramp anchor selection.
//
// Picks paper + a ramp of patches along one channel (C, M, Y, or neutral
// gray). Goal: test the hypothesis that substrate transform is shared
// across inks, so anchors from one channel suffice to fit the per-λ
// substrate function for all channels.
//
// Channel mapping for RGB device addressing (where (255-X)/255 → ink):
//   - 'C' (cyan): R varies 255 → 0, G = 255, B = 255.
//   - 'M' (magenta): G varies 255 → 0, R = 255, B = 255.
//   - 'Y' (yellow): B varies 255 → 0, R = 255, G = 255.
//   - 'neutral': R = G = B varying 255 → 0.
//
// In practice the chart's patches are at discrete RGB values. We pick the
// nearest patch to each target ramp level. Paper (255, 255, 255) is
// always the first anchor; the requested `levels` (e.g. [192, 128, 64, 0]
// in the variable channel) are picked next.

import type { AnchorSet } from '../../types';
import type { ProfileMatrices } from '../dataset/matrix';

export type RampChannel = 'C' | 'M' | 'Y' | 'neutral';

export interface ChannelRampOptions {
  channel: RampChannel;
  /**
   * Target values in the *variable* channel(s), in the same 0–255 RGB
   * device-addressing range. Order is preserved as the anchor pick order.
   * Default: `[192, 128, 64, 0]` (4 ramp levels above paper).
   */
  levels?: number[];
}

interface RGB { r: number; g: number; b: number }

function targetRGBForLevel(channel: RampChannel, level: number): RGB {
  // The 'level' is the value in the VARIABLE axis (255 = no ink, 0 = max ink).
  switch (channel) {
    case 'C':       return { r: level, g: 255, b: 255 };
    case 'M':       return { r: 255, g: level, b: 255 };
    case 'Y':       return { r: 255, g: 255, b: level };
    case 'neutral': return { r: level, g: level, b: level };
  }
}

function squaredDist(a: RGB, b: RGB): number {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function nearestRgbIdx(D: Float64Array, N: number, target: RGB, taken: Set<number>): number {
  let bestIdx = -1;
  let bestD = Infinity;
  for (let i = 0; i < N; i++) {
    if (taken.has(i)) continue;
    const d = squaredDist({ r: D[i * 3], g: D[i * 3 + 1], b: D[i * 3 + 2] }, target);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Build an anchor set consisting of paper + the requested channel ramp
 * levels (each level → nearest measured patch in RGB space).
 */
export function pickChannelRampAnchors(
  profile: ProfileMatrices,
  options: ChannelRampOptions,
): AnchorSet {
  if (profile.channels !== 3) {
    throw new Error(`pickChannelRampAnchors: RGB-only for now (got ${profile.channels} channels)`);
  }
  const levels = options.levels ?? [192, 128, 64, 0];
  if (levels.length < 1) {
    throw new Error(`pickChannelRampAnchors: levels must be non-empty`);
  }
  const N = profile.N;
  const taken = new Set<number>();
  const pickedIdx: number[] = [];
  const pickedLabels: string[] = [];

  // 1. Paper anchor.
  const paperIdx = nearestRgbIdx(profile.D, N, { r: 255, g: 255, b: 255 }, taken);
  if (paperIdx < 0) throw new Error(`pickChannelRampAnchors: no patches in profile`);
  taken.add(paperIdx);
  pickedIdx.push(paperIdx);
  pickedLabels.push('paper');

  // 2. Ramp anchors in user-provided order.
  for (const level of levels) {
    const tgt = targetRGBForLevel(options.channel, level);
    const idx = nearestRgbIdx(profile.D, N, tgt, taken);
    if (idx < 0) continue;
    taken.add(idx);
    pickedIdx.push(idx);
    pickedLabels.push(`${options.channel}_${level}`);
  }

  return {
    sampleIds: pickedIdx.map(i => profile.sampleIds[i]),
    strategy: 'forced',
    meta: {
      channel: options.channel,
      levels,
      chosenIdx: pickedIdx,
      labels: pickedLabels,
    },
  };
}
