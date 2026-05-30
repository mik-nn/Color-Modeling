// src/lib/predict/obaModelFit.ts
//
// H12 — One-parameter OBA emission-scaling correction fitted from a few
// diagnostic anchor patches per profile.
//
// Default D7 takes the per-patch OBA factor as `f(patch) = R_patch(380) /
// R_paper(380)` clamped to [0, 1] and the emission `E(λ)` from the paper. That
// ignores any vendor-specific scaling between the predicted and observed OBA
// contribution. H12 fits an `α` scaling factor per profile from k=2..4 anchors
// (paper + yellow + gray + cyan/blue), then `f_H12(patch) = clamp(α · f_default,
// 0, 1)`.
//
// Math (closed-form weighted LSQ on the OBA band):
//   For each anchor i, fit a degree-2 polynomial baseline on the OBA-free
//   region (460–730 nm) of the ANCHOR'S OWN spectrum, extrapolate it into the
//   OBA band (380–450 nm), and take the observed OBA contribution as
//   `obs_i(λ) = R_i(λ) − anchorBaseline_i(λ)` for λ ∈ [380, 450].
//   The model OBA contribution at α=1 is `mdl_i(λ) = f_default_i · E_paper(λ)`.
//   Then α = Σ_i,λ (mdl · obs) / Σ_i,λ (mdl²), clamped to a reasonable range.

import { extractOBAEmission, OBAExtraction } from './obaSeparator'

export interface ObaAnchor {
  rgb: [number, number, number]
  spectrum: number[]
}

export interface ObaScaleFit {
  /** Per-profile scale factor on the OBA contribution. 1 = default D7. */
  alpha: number
  /** Paper's analytic emission (from extractOBAEmission). */
  emission: OBAExtraction
  /** Number of anchors actually used (an anchor needs OBA-region data to count). */
  anchorsUsed: number
  /** Diagnostic: per-anchor observed and model OBA contributions over [380, 450]. */
  observed: number[][]
  modelAtAlphaOne: number[][]
}

export interface ObaScaleFitOptions {
  startWL?: number // default 380
  step?: number // default 10
  /** OBA band over which we fit. Default [380, 450]. */
  band?: readonly [number, number]
  /** OBA-free band for the per-anchor quadratic baseline. Default [460, 730]. */
  baseBand?: readonly [number, number]
  /** Allowed range for α. Default [0.3, 3.0]. */
  alphaRange?: readonly [number, number]
}

interface PolyFit {
  c0: number
  c1: number
  c2: number
  center: number
  scale: number
}

function fitQuadratic(xs: number[], ys: number[], center: number, scale = 100): PolyFit {
  const n = xs.length
  if (n < 3) throw new Error(`fitQuadratic: need ≥ 3 points, got ${n}`)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let s4 = 0
  let t0 = 0
  let t1 = 0
  let t2 = 0
  for (let i = 0; i < n; i++) {
    const x = (xs[i] - center) / scale
    const y = ys[i]
    const x2 = x * x
    s0 += 1
    s1 += x
    s2 += x2
    s3 += x2 * x
    s4 += x2 * x2
    t0 += y
    t1 += x * y
    t2 += x2 * y
  }
  const det =
    s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2)
  if (Math.abs(det) < 1e-18) throw new Error('fitQuadratic: singular matrix')
  const detC0 =
    t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2)
  const detC1 =
    s0 * (t1 * s4 - s3 * t2) - t0 * (s1 * s4 - s3 * s2) + s2 * (s1 * t2 - t1 * s2)
  const detC2 =
    s0 * (s2 * t2 - t1 * s3) - s1 * (s1 * t2 - t1 * s2) + t0 * (s1 * s3 - s2 * s2)
  return { c0: detC0 / det, c1: detC1 / det, c2: detC2 / det, center, scale }
}

function evalPoly(fit: PolyFit, lambda: number): number {
  const x = (lambda - fit.center) / fit.scale
  return fit.c0 + fit.c1 * x + fit.c2 * x * x
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Fit the OBA emission scaling α for one profile from anchor patches.
 *
 * `paperSpec` is the substrate's paper-white reflectance; `anchors` are the
 * diagnostic patches (yellow, gray, etc.). The paper itself does NOT need to be
 * included — it's the source of E(λ) and `α = 1` by construction on it.
 */
export function fitObaScale(
  paperSpec: number[],
  anchors: ObaAnchor[],
  options: ObaScaleFitOptions = {},
): ObaScaleFit {
  const startWL = options.startWL ?? 380
  const step = options.step ?? 10
  const [bLo, bHi] = options.band ?? [380, 450]
  const [baseLo, baseHi] = options.baseBand ?? [460, 730]
  const [aMin, aMax] = options.alphaRange ?? [0.3, 3.0]
  const L = paperSpec.length

  const extraction = extractOBAEmission(paperSpec, { startWL, step })
  const i380 = Math.round((380 - startWL) / step)
  const paper380 = paperSpec[i380]
  if (paper380 < 1e-6 || anchors.length === 0) {
    return { alpha: 1, emission: extraction, anchorsUsed: 0, observed: [], modelAtAlphaOne: [] }
  }

  let num = 0
  let den = 0
  const observed: number[][] = []
  const modelAtAlphaOne: number[][] = []
  let anchorsUsed = 0

  for (const anchor of anchors) {
    if (anchor.spectrum.length !== L) continue
    const fDefRaw = anchor.spectrum[i380] / paper380
    const fDef = clamp(fDefRaw, 0, 1)
    // Anchor's own poly2 baseline on the OBA-free band.
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < L; i++) {
      const lambda = startWL + i * step
      if (lambda >= baseLo && lambda <= baseHi) {
        xs.push(lambda)
        ys.push(anchor.spectrum[i])
      }
    }
    if (xs.length < 3) continue
    let fit: PolyFit
    try {
      fit = fitQuadratic(xs, ys, 600)
    } catch {
      continue
    }
    const obs = new Array<number>(L).fill(0)
    const mdl = new Array<number>(L).fill(0)
    for (let i = 0; i < L; i++) {
      const lambda = startWL + i * step
      if (lambda < bLo || lambda > bHi) continue
      const baseline = evalPoly(fit, lambda)
      const observedExcess = anchor.spectrum[i] - baseline
      const modelExcess = fDef * extraction.emission[i]
      obs[i] = observedExcess
      mdl[i] = modelExcess
      num += modelExcess * observedExcess
      den += modelExcess * modelExcess
    }
    observed.push(obs)
    modelAtAlphaOne.push(mdl)
    anchorsUsed++
  }

  const alphaRaw = den > 1e-10 ? num / den : 1
  const alpha = clamp(alphaRaw, aMin, aMax)
  return { alpha, emission: extraction, anchorsUsed, observed, modelAtAlphaOne }
}

/**
 * Per-patch OBA factor under H12: same default `R_patch(380)/R_paper(380)`
 * baseline, but multiplied by the fitted α and re-clamped.
 */
export function obaFactorH12(
  spectrum: number[],
  paperSpec: number[],
  alpha: number,
  options: { startWL?: number; step?: number } = {},
): number {
  const startWL = options.startWL ?? 380
  const step = options.step ?? 10
  const i380 = Math.round((380 - startWL) / step)
  const paper380 = paperSpec[i380]
  if (paper380 < 1e-6) return 0
  const raw = spectrum[i380] / paper380
  return clamp(alpha * raw, 0, 1)
}

/**
 * Pick the diagnostic anchor patches from a profile's full patch set: paper +
 * the patches nearest (in RGB Euclidean distance) to the targets `[255,255,0]`,
 * `[128,128,128]`, `[0,255,255]`, `[0,0,255]`. Used by the H12 test runner.
 */
export const OBA_DIAGNOSTIC_TARGETS: readonly [number, number, number][] = [
  [255, 255, 0],
  [128, 128, 128],
  [0, 255, 255],
  [0, 0, 255],
]

export function pickObaAnchors(
  patches: ObaAnchor[],
  targets: readonly [number, number, number][] = OBA_DIAGNOSTIC_TARGETS,
): ObaAnchor[] {
  const out: ObaAnchor[] = []
  for (const t of targets) {
    let bestIdx = -1
    let bestD = Infinity
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]
      const dr = p.rgb[0] - t[0]
      const dg = p.rgb[1] - t[1]
      const db = p.rgb[2] - t[2]
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        bestIdx = i
      }
    }
    if (bestIdx >= 0) out.push(patches[bestIdx])
  }
  return out
}
