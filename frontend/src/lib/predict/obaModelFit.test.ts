import { describe, it, expect } from 'vitest'
import { fitObaScale, obaFactorH12, pickObaAnchors, ObaAnchor } from './obaModelFit'

// 36-band wavelengths 380..730 step 10
const L = 36
const WAVELENGTHS = Array.from({ length: L }, (_, i) => 380 + i * 10)

// Smooth substrate baseline (no OBA): a slow rising curve.
function smoothBase(): number[] {
  return WAVELENGTHS.map((wl) => 0.6 + 0.0004 * (wl - 380))
}

// Synthetic emission peaking at 440 nm.
function emissionShape(amp = 0.15): number[] {
  return WAVELENGTHS.map((wl) => {
    if (wl < 380 || wl > 450) return 0
    const dx = (wl - 440) / 25
    return amp * Math.exp(-dx * dx)
  })
}

// Build a paper spectrum = base + emission.
function paperSpec(amp = 0.15): number[] {
  const base = smoothBase()
  const em = emissionShape(amp)
  return base.map((v, i) => v + em[i])
}

// Build a synthetic ink-attenuated patch with UNIFORM ink transmittance `t` across
// all wavelengths (a simple model that keeps the per-anchor quadratic baseline
// recoverable). R_patch(λ) = t² · R_base(λ) + α_true · t · E(λ).
function syntheticPatch(
  rgb: [number, number, number],
  t: number,
  alphaTrue = 1,
): ObaAnchor {
  const base = smoothBase()
  const em = emissionShape()
  const spectrum = WAVELENGTHS.map((_, i) => {
    const v = t * t * base[i] + alphaTrue * t * em[i]
    return v < 0 ? 0 : v > 1 ? 1 : v
  })
  return { rgb, spectrum }
}

describe('fitObaScale', () => {
  it('is monotonic in the true OBA scale: higher α_true → higher fitted α', () => {
    const paper = paperSpec()
    function fitFor(alphaTrue: number): number {
      const anchors: ObaAnchor[] = [
        syntheticPatch([255, 255, 0], 0.7, alphaTrue),
        syntheticPatch([128, 128, 128], 0.5, alphaTrue),
        syntheticPatch([0, 0, 255], 0.6, alphaTrue),
      ]
      return fitObaScale(paper, anchors).alpha
    }
    const a1 = fitFor(1.0)
    const a15 = fitFor(1.5)
    const a05 = fitFor(0.5)
    expect(a15).toBeGreaterThan(a1)
    expect(a1).toBeGreaterThan(a05)
  })

  it('clamps α to the configured range', () => {
    const paper = paperSpec()
    const anchors: ObaAnchor[] = [
      syntheticPatch([255, 255, 0], 0.7, 10), // absurdly high
    ]
    const fit = fitObaScale(paper, anchors, { alphaRange: [0.3, 2.5] })
    expect(fit.alpha).toBeLessThanOrEqual(2.5)
    expect(fit.alpha).toBeGreaterThanOrEqual(0.3)
  })

  it('returns α=1 fallback when no anchors are usable', () => {
    const paper = paperSpec()
    const fit = fitObaScale(paper, [])
    expect(fit.alpha).toBe(1)
    expect(fit.anchorsUsed).toBe(0)
  })
})

describe('obaFactorH12', () => {
  it('matches the default factor when α = 1', () => {
    const paper = paperSpec()
    const patch = syntheticPatch([0, 0, 0], 0.5).spectrum
    const f = obaFactorH12(patch, paper, 1)
    const expected = patch[0] / paper[0]
    expect(f).toBeCloseTo(Math.min(1, Math.max(0, expected)), 6)
  })
  it('scales by α and clamps to [0, 1]', () => {
    const paper = paperSpec()
    const patch = syntheticPatch([0, 0, 0], 0.5).spectrum
    const f15 = obaFactorH12(patch, paper, 1.5)
    const f3 = obaFactorH12(patch, paper, 3)
    expect(f15).toBeGreaterThan(0)
    expect(f15).toBeLessThanOrEqual(1)
    expect(f3).toBeLessThanOrEqual(1)
  })
})

describe('pickObaAnchors', () => {
  it('picks closest RGB to each target', () => {
    const patches: ObaAnchor[] = [
      { rgb: [250, 250, 5], spectrum: [0] }, // ~yellow
      { rgb: [125, 125, 130], spectrum: [0] }, // ~gray
      { rgb: [10, 250, 245], spectrum: [0] }, // ~cyan
      { rgb: [5, 5, 240], spectrum: [0] }, // ~blue
      { rgb: [255, 0, 0], spectrum: [0] }, // red (not a target)
    ]
    const picked = pickObaAnchors(patches)
    expect(picked).toHaveLength(4)
    expect(picked[0].rgb).toEqual([250, 250, 5])
    expect(picked[1].rgb).toEqual([125, 125, 130])
    expect(picked[2].rgb).toEqual([10, 250, 245])
    expect(picked[3].rgb).toEqual([5, 5, 240])
  })
})
