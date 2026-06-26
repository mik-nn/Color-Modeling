// forwardRampModel.test.ts
//
// Within-profile forward predictor (H45b): a single-ink Yule-Nielsen model fit
// on a colorant ramp. Clean ramps fit tightly; a holdout-corrupted endpoint
// (ink folds back) blows up the residual — the signal the ink limit removes.

import { describe, it, expect } from 'vitest'
import { fitForwardRamp, type SpectralRampPoint } from './forwardRampModel'

const R0 = new Array(36).fill(0.85) // paper
const R1 = new Array(36).fill(0.1) // full ink

// Yule-Nielsen single-ink mix at coverage t with exponent n.
const yn = (a: number[], b: number[], t: number, n: number): number[] =>
  a.map((r0, i) => Math.pow((1 - t) * Math.pow(r0, 1 / n) + t * Math.pow(b[i], 1 / n), n))

const TS = [0, 0.25, 0.5, 0.75, 1]

describe('fitForwardRamp', () => {
  it('recovers n≈2 with near-zero residual on clean YN data', () => {
    const ramp: SpectralRampPoint[] = TS.map((t) => ({ t, spectrum: yn(R0, R1, t, 2) }))
    const fit = fitForwardRamp(ramp)
    expect(fit.n).toBeCloseTo(2, 1)
    expect(fit.medianDE).toBeLessThan(0.5)
    expect(fit.perPatchDE.length).toBe(5)
  })

  it('blows up the residual when the top endpoint is ink-holdout corrupted', () => {
    const clean: SpectralRampPoint[] = TS.map((t) => ({ t, spectrum: yn(R0, R1, t, 2) }))
    const cleanFit = fitForwardRamp(clean)
    // Full-ink patch folds back to paper-like reflectance (holdout).
    const kinked = clean.map((p, i) => (i === 4 ? { t: 1, spectrum: R0.slice() } : p))
    const kinkedFit = fitForwardRamp(kinked)
    expect(kinkedFit.medianDE).toBeGreaterThan(cleanFit.medianDE + 2)
  })

  it('returns a zero result for a ramp too short to fit', () => {
    const fit = fitForwardRamp([{ t: 0, spectrum: R0 }, { t: 1, spectrum: R1 }])
    expect(fit.medianDE).toBe(0)
    expect(fit.perPatchDE.length).toBe(0)
  })
})
