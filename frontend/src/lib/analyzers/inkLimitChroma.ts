// src/lib/analyzers/inkLimitChroma.ts
//
// Intrinsic ink-limit detection (H45). Along a colorant ramp the chroma C*ab
// normally grows with ink; on a "problematic" substrate it rises then FALLS as
// the ink overflows / sits on the surface (ink holdout, H35) and the hue rotates
// (H40). The ink limit for that colorant is the coverage at the chroma maximum
// t* = argmax C*ab(t). Beyond t* the extra ink subtracts chroma and twists hue —
// it is the unpredictable region.
//
// Pure functions. Ramps live in CMY [0,1] space (via `toCMY`), so the detector
// is DeviceSpace-agnostic — RGB and CMYK profiles both reduce to CMY here.

export type RampName = 'C' | 'M' | 'Y' | 'R' | 'G' | 'B' | 'N'

/** Active CMY channel indices for each ramp direction. */
const RAMP_CHANNELS: Record<RampName, number[]> = {
  C: [0],
  M: [1],
  Y: [2],
  R: [1, 2], // magenta + yellow
  G: [0, 2], // cyan + yellow
  B: [0, 1], // cyan + magenta
  N: [0, 1, 2], // neutral
}

export interface RampPoint {
  /** Coverage along the ramp, 0–1. */
  t: number
  lab: readonly [number, number, number]
}

export interface PatchSample {
  cmy: readonly [number, number, number]
  lab: readonly [number, number, number]
}

export interface ChromaMaxResult {
  tStar: number
  chromaMax: number
  chromaEnd: number
  /** chromaMax − chromaEnd: how much chroma is lost past the peak. */
  chromaDrop: number
  /** Hue rotation (deg) between the chroma peak and full coverage. */
  hueShiftDeg: number
  /** True when the chroma peak is interior and the drop clears the noise guard. */
  signFlip: boolean
}

export interface InkLimits {
  perRamp: Partial<Record<RampName, ChromaMaxResult>>
  /** Σ chromaDrop over ramps that flipped — overall "problematic" strength. */
  signFlipScore: number
  flipCount: number
}

const chromaOf = (lab: readonly [number, number, number]): number =>
  Math.hypot(lab[1], lab[2])

function hueDeg(lab: readonly [number, number, number]): number {
  const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI
  return h < 0 ? h + 360 : h
}

function angularDistanceDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

export function chromaMaxT(
  ramp: RampPoint[],
  opts: { minChromaDrop?: number } = {},
): ChromaMaxResult {
  const minChromaDrop = opts.minChromaDrop ?? 1.0
  if (ramp.length === 0) {
    return { tStar: 0, chromaMax: 0, chromaEnd: 0, chromaDrop: 0, hueShiftDeg: 0, signFlip: false }
  }
  const sorted = [...ramp].sort((p, q) => p.t - q.t)
  const last = sorted[sorted.length - 1]

  let idxMax = 0
  let chromaMax = -Infinity
  for (let i = 0; i < sorted.length; i++) {
    const c = chromaOf(sorted[i].lab)
    if (c > chromaMax) {
      chromaMax = c
      idxMax = i
    }
  }
  const peak = sorted[idxMax]
  const chromaEnd = chromaOf(last.lab)
  const chromaDrop = chromaMax - chromaEnd
  const hueShiftDeg = angularDistanceDeg(hueDeg(peak.lab), hueDeg(last.lab))
  const signFlip = idxMax < sorted.length - 1 && chromaDrop >= minChromaDrop

  return { tStar: peak.t, chromaMax, chromaEnd, chromaDrop, hueShiftDeg, signFlip }
}

/** Mean coverage of a sample over a ramp's active channels (the ramp's t). */
function rampT(cmy: readonly [number, number, number], channels: number[]): number {
  let s = 0
  for (const c of channels) s += cmy[c]
  return s / channels.length
}

/**
 * Extract a colorant ramp from a chart by nearest device coordinate. For each
 * requested level the nearest patch (in CMY space) to `level · direction` is
 * picked; duplicates are removed and the result is sorted by coverage.
 */
export function buildCmyRamp(
  samples: PatchSample[],
  ramp: RampName,
  levels: number[] = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1.0],
): RampPoint[] {
  const channels = RAMP_CHANNELS[ramp]
  const chosen = new Map<number, RampPoint>()
  for (const level of levels) {
    let bestIdx = -1
    let bestD = Infinity
    for (let i = 0; i < samples.length; i++) {
      const cmy = samples[i].cmy
      let d = 0
      for (let c = 0; c < 3; c++) {
        const target = channels.includes(c) ? level : 0
        const diff = cmy[c] - target
        d += diff * diff
      }
      if (d < bestD) {
        bestD = d
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && !chosen.has(bestIdx)) {
      chosen.set(bestIdx, { t: rampT(samples[bestIdx].cmy, channels), lab: samples[bestIdx].lab })
    }
  }
  return [...chosen.values()].sort((p, q) => p.t - q.t)
}

export function detectInkLimits(
  samples: PatchSample[],
  opts: { minChromaDrop?: number; levels?: number[] } = {},
): InkLimits {
  const ramps: RampName[] = ['C', 'M', 'Y', 'R', 'G', 'B', 'N']
  const perRamp: Partial<Record<RampName, ChromaMaxResult>> = {}
  let signFlipScore = 0
  let flipCount = 0
  for (const name of ramps) {
    const ramp = buildCmyRamp(samples, name, opts.levels)
    if (ramp.length < 3) continue
    const res = chromaMaxT(ramp, { minChromaDrop: opts.minChromaDrop })
    perRamp[name] = res
    if (res.signFlip) {
      signFlipScore += res.chromaDrop
      flipCount++
    }
  }
  return { perRamp, signFlipScore, flipCount }
}

/**
 * A patch is over-limit if, for any ramp that flipped, its coverage on that
 * ramp's active channels exceeds the ramp's t*. Coverage = min over active
 * channels (the amount that fully participates in that ramp direction).
 */
export function isOverLimit(
  cmy: readonly [number, number, number],
  limits: InkLimits,
): boolean {
  for (const name of Object.keys(limits.perRamp) as RampName[]) {
    const res = limits.perRamp[name]
    if (!res || !res.signFlip) continue
    const channels = RAMP_CHANNELS[name]
    let coverage = Infinity
    for (const c of channels) coverage = Math.min(coverage, cmy[c])
    if (coverage > res.tStar + 1e-9) return true
  }
  return false
}
