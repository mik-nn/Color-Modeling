// inkLimitChroma.test.ts
//
// Intrinsic ink-limit detection: along a colorant ramp the chroma C*ab rises
// then (on problematic substrates) falls; the limit is the chroma maximum.

import { describe, it, expect } from 'vitest'
import {
  chromaMaxT,
  buildCmyRamp,
  detectInkLimits,
  isOverLimit,
  type PatchSample,
  type RampPoint,
} from './inkLimitChroma'

// chroma = a (b held at 0) so chroma(t) is exactly the listed value.
const ramp = (ts: number[], chromas: number[]): RampPoint[] =>
  ts.map((t, i) => ({ t, lab: [50, chromas[i], 0] as [number, number, number] }))

describe('chromaMaxT', () => {
  it('flags a sign flip when chroma rises then falls', () => {
    const r = chromaMaxT(ramp([0, 0.25, 0.5, 0.75, 1], [0, 10, 20, 18, 12]))
    expect(r.tStar).toBeCloseTo(0.5, 6)
    expect(r.chromaMax).toBeCloseTo(20, 6)
    expect(r.chromaEnd).toBeCloseTo(12, 6)
    expect(r.chromaDrop).toBeCloseTo(8, 6)
    expect(r.signFlip).toBe(true)
  })

  it('reports no sign flip for a monotone ramp', () => {
    const r = chromaMaxT(ramp([0, 0.25, 0.5, 0.75, 1], [0, 5, 10, 15, 20]))
    expect(r.tStar).toBeCloseTo(1, 6)
    expect(r.chromaDrop).toBeCloseTo(0, 6)
    expect(r.signFlip).toBe(false)
  })

  it('measures hue rotation between the chroma peak and full coverage', () => {
    const r: RampPoint[] = [
      { t: 0, lab: [50, 0, 0] },
      { t: 0.5, lab: [50, 20, 0] }, // peak, hue 0°
      { t: 1, lab: [50, 10, 8] }, // hue atan2(8,10) ≈ 38.66°
    ]
    const out = chromaMaxT(r)
    expect(out.signFlip).toBe(true)
    expect(out.hueShiftDeg).toBeCloseTo(38.66, 1)
  })

  it('respects the minimum-drop threshold (noise guard)', () => {
    // 0.4 ΔC dip is below a 1.0 threshold → not a real flip.
    const r = chromaMaxT(ramp([0, 0.5, 1], [0, 20, 19.6]), { minChromaDrop: 1 })
    expect(r.signFlip).toBe(false)
  })
})

describe('buildCmyRamp', () => {
  it('extracts the cyan axis by nearest device coordinate', () => {
    const samples: PatchSample[] = [
      { cmy: [0, 0, 0], lab: [95, 0, 0] },
      { cmy: [0.5, 0, 0], lab: [60, -20, -10] },
      { cmy: [1, 0, 0], lab: [40, -30, -15] },
      { cmy: [0.5, 0.5, 0.5], lab: [50, 0, 0] }, // off-axis, must be ignored
    ]
    const r = buildCmyRamp(samples, 'C', [0, 0.5, 1])
    expect(r.map((p) => p.t)).toEqual([0, 0.5, 1])
    expect(r[2].lab[1]).toBeCloseTo(-30, 6)
  })
})

describe('detectInkLimits / isOverLimit', () => {
  // Cyan ramp peaks in chroma at t=0.5 then desaturates; others monotone.
  const samples: PatchSample[] = [
    { cmy: [0, 0, 0], lab: [95, 0, 0] },
    { cmy: [0.25, 0, 0], lab: [70, -18, -8] }, // C ≈ 19.7
    { cmy: [0.5, 0, 0], lab: [60, -28, -12] }, // C ≈ 30.5  (peak)
    { cmy: [0.75, 0, 0], lab: [52, -22, -10] }, // C ≈ 24.2
    { cmy: [1, 0, 0], lab: [45, -16, -8] }, // C ≈ 17.9  (folded back)
  ]

  it('detects the cyan chroma-max limit and scores the flip', () => {
    const limits = detectInkLimits(samples)
    expect(limits.perRamp.C?.signFlip).toBe(true)
    expect(limits.perRamp.C?.tStar).toBeCloseTo(0.5, 6)
    expect(limits.signFlipScore).toBeGreaterThan(0)
    expect(limits.flipCount).toBeGreaterThanOrEqual(1)
  })

  it('marks high-coverage cyan patches as over-limit', () => {
    const limits = detectInkLimits(samples)
    expect(isOverLimit([0.8, 0, 0], limits)).toBe(true)
    expect(isOverLimit([0.3, 0, 0], limits)).toBe(false)
  })
})
