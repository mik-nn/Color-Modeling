/**
 * coverage6Chart — fixed anchor-chart selection (target-agnostic).
 * Supports k ∈ {6, 8, 12} via cov6 / cov8n (neutral-heavy) / cov12.
 *
 * Maps device RGB targets to nearest patch indices in a given profile.
 * No target-spectral knowledge needed; deterministic per chart tier.
 *
 * @module lib/core/coverage6Chart
 */

import type { ProfileMatrices } from '../dataset/matrix'

/**
 * Validate k is in the deployable set.
 */
export function validateCoverageChart(k: number): void {
  if (![6, 8, 12].includes(k)) {
    throw new Error(`coverage6Chart: k must be 6, 8, or 12 (got ${k})`)
  }
}

/**
 * Device-RGB targets for each chart tier (H31/H31b/H42).
 */
const COV6_TARGETS: Array<[number, number, number]> = [
  [255, 255, 255], // paper white
  [0, 255, 255],   // cyan
  [255, 0, 255],   // magenta
  [255, 255, 0],   // yellow
  [0, 0, 0],       // black
  [128, 128, 128], // gray128 (mid-coverage, spreadCurv mid-point)
]

const COV8N_TARGETS: Array<[number, number, number]> = [
  ...COV6_TARGETS,
  [64, 64, 64],    // gray64 (light coverage, ink≈2.25)
  [192, 192, 192], // gray192 (light coverage, ink≈0.75)
]

// cov12: cov9 (cov6 + R+G+B) + gray64 + gray192 + green-mid
const COV12_TARGETS: Array<[number, number, number]> = [
  ...COV6_TARGETS,
  [255, 0, 0],     // red
  [0, 255, 0],     // green
  [0, 0, 255],     // blue
  [64, 64, 64],    // gray64
  [192, 192, 192], // gray192
]

function squaredDist(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

/**
 * Find nearest patch to a target RGB in device space.
 * Returns -1 if no patches exist.
 */
function nearestToTarget(
  D: Float64Array,
  N: number,
  target: [number, number, number],
): number {
  let bestIdx = -1
  let bestD = Infinity
  for (let i = 0; i < N; i++) {
    const d = squaredDist(
      [D[i * 3], D[i * 3 + 1], D[i * 3 + 2]],
      target,
    )
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  return bestIdx
}

export interface CoverageChartResult {
  /**
   * Row indices of the selected anchor patches (length k).
   * Deduplicated: each patch appears once even if multiple targets map to it.
   */
  anchorIdx: number[]
  /**
   * Metadata: target RGB, matched RGB (what was actually found), sample IDs.
   */
  metadata: {
    k: number
    targets: Array<[number, number, number]>
    matched: Array<[number, number, number]>
    sampleIds: string[]
  }
}

/**
 * Map a coverage-chart tier (6, 8, or 12) to anchor indices in a profile.
 * Returns the nearest patch for each target, deduped.
 *
 * @param profile ProfileMatrices with device RGB coordinates
 * @param k Chart tier (6, 8, or 12)
 * @returns Anchor indices + metadata
 */
export function mapDeviceToAnchorIdx(
  profile: ProfileMatrices,
  k: number,
): CoverageChartResult {
  validateCoverageChart(k)

  const targets =
    k === 6 ? COV6_TARGETS : k === 8 ? COV8N_TARGETS : COV12_TARGETS

  const chosen = new Set<number>()
  const matched: Array<[number, number, number]> = []
  const sampleIds: string[] = []

  for (const target of targets) {
    const idx = nearestToTarget(profile.D, profile.N, target)
    if (idx >= 0 && !chosen.has(idx)) {
      chosen.add(idx)
      matched.push([
        profile.D[idx * 3],
        profile.D[idx * 3 + 1],
        profile.D[idx * 3 + 2],
      ])
      sampleIds.push(profile.sampleIds[idx])
    }
  }

  return {
    anchorIdx: Array.from(chosen),
    metadata: {
      k,
      targets,
      matched,
      sampleIds,
    },
  }
}
