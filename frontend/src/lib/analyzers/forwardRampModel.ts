// src/lib/analyzers/forwardRampModel.ts
//
// Within-profile forward predictor (H45b). A single-ink Yule-Nielsen model maps
// coverage t → reflectance from the ramp endpoints (paper at min-t, full ink at
// max-t) with one fitted exponent n. The residual (ΔE00 of model vs measured on
// the interior patches) measures how predictable the colorant behaviour is.
//
// On a clean ramp the residual is small. When the high-coverage end is corrupted
// by ink holdout/overflow (H35), the endpoint anchor is wrong and the whole fit
// degrades — exactly the signal an ink limit is meant to remove. Replaces the
// retired `spectralPredictor.ts`; deliberately minimal (single-ink + neutral).

import { spectraToXYZ, spectraToLab, deltaE00 } from '../colormath'
import type { WhitePointXYZ } from '../../types'

export interface SpectralRampPoint {
  t: number
  spectrum: number[]
}

export interface ForwardFitResult {
  /** Fitted Yule-Nielsen exponent. */
  n: number
  /** Median ΔE00 of the model on interior (non-endpoint) patches. */
  medianDE: number
  /** P95 ΔE00 on interior patches. */
  p95DE: number
  /** Per-patch ΔE00 for every patch (endpoints included, ≈0 by construction). */
  perPatchDE: { t: number; de: number }[]
}

const R_EPS = 1e-4

/** YN single-ink reflectance at normalised coverage tn ∈ [0,1]. */
function ynMix(r0: number[], r1: number[], tn: number, n: number): number[] {
  const inv = 1 / n
  const out = new Array<number>(r0.length)
  for (let i = 0; i < r0.length; i++) {
    const a = Math.pow(Math.max(R_EPS, r0[i]), inv)
    const b = Math.pow(Math.max(R_EPS, r1[i]), inv)
    out[i] = Math.pow((1 - tn) * a + tn * b, n)
  }
  return out
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))
  return sorted[idx]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function fitForwardRamp(
  ramp: SpectralRampPoint[],
  opts: { startWL?: number } = {},
): ForwardFitResult {
  const startWL = opts.startWL ?? 380
  const sorted = [...ramp].sort((p, q) => p.t - q.t)
  if (sorted.length < 3) {
    return { n: 1, medianDE: 0, p95DE: 0, perPatchDE: [] }
  }

  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const r0 = first.spectrum
  const r1 = last.spectrum
  const span = last.t - first.t || 1

  // Paper-relative Lab: white point from the paper (min-t) endpoint.
  const paperWP: WhitePointXYZ = spectraToXYZ(r0, startWL)
  const measLab = sorted.map((p) => spectraToLab(p.spectrum, startWL, paperWP))

  // Interior patches drive the fit (endpoints are pinned anchors).
  const interior: number[] = []
  for (let i = 1; i < sorted.length - 1; i++) interior.push(i)

  const residualFor = (n: number): number[] =>
    sorted.map((p, i) => {
      const tn = (p.t - first.t) / span
      const pred = ynMix(r0, r1, tn, n)
      const [L, a, b] = spectraToLab(pred, startWL, paperWP)
      return deltaE00(measLab[i][0], measLab[i][1], measLab[i][2], L, a, b)
    })

  // Fit n on a coarse grid by minimising median interior residual.
  let bestN = 1
  let bestScore = Infinity
  for (let n = 1; n <= 12.0001; n += 0.1) {
    const de = residualFor(n)
    const score = median(interior.map((i) => de[i]))
    if (score < bestScore) {
      bestScore = score
      bestN = n
    }
  }

  const finalDE = residualFor(bestN)
  const interiorDE = interior.map((i) => finalDE[i]).sort((a, b) => a - b)

  return {
    n: Math.round(bestN * 100) / 100,
    medianDE: median(interiorDE),
    p95DE: percentile(interiorDE, 0.95),
    perPatchDE: sorted.map((p, i) => ({ t: p.t, de: finalDE[i] })),
  }
}
