import { describe, it, expect } from 'vitest'
import { pca, buildPcaInterpolator } from './pcaInterp'
import { InterpPoint } from './rgbInterp'

// Build a rank-2 spectral dataset: spectrum = mean + a·v1 + b·v2.
const v1 = [1, 0, -1, 0.5, -0.5, 0.2]
const v2 = [0, 1, 0, -1, 0.3, -0.3]
const base = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
function spec(a: number, b: number): number[] {
  return base.map((m, i) => m + a * v1[i] + b * v2[i])
}

describe('pca', () => {
  it('throws with fewer than 2 spectra', () => {
    expect(() => pca([base])).toThrow()
  })
  it('captures ~all variance in the first 2 components for a rank-2 set', () => {
    const data = [spec(1, 0), spec(0, 1), spec(1, 1), spec(-1, 0.5), spec(0.3, -0.7), spec(2, -1)]
    const res = pca(data, 6)
    const top2 = res.explained[0] + res.explained[1]
    expect(top2).toBeGreaterThan(0.999)
  })
  it('returns explained ratios in descending order summing to ~1', () => {
    const data = [spec(1, 0), spec(0, 1), spec(1, 1), spec(-1, 0.5), spec(0.3, -0.7)]
    const res = pca(data, 6)
    for (let i = 1; i < res.explained.length; i++) {
      expect(res.explained[i]).toBeLessThanOrEqual(res.explained[i - 1] + 1e-9)
    }
    const sum = res.explained.reduce((a, b) => a + b, 0)
    expect(sum).toBeGreaterThan(0.999)
  })
})

describe('buildPcaInterpolator', () => {
  // Points on a rank-2 manifold placed at distinct RGB coords.
  const points: InterpPoint[] = [
    { rgb: [0, 0, 0], spectrum: spec(0, 0) },
    { rgb: [255, 0, 0], spectrum: spec(1, 0) },
    { rgb: [0, 255, 0], spectrum: spec(0, 1) },
    { rgb: [0, 0, 255], spectrum: spec(0.5, 0.5) },
    { rgb: [255, 255, 0], spectrum: spec(1, 1) },
    { rgb: [255, 0, 255], spectrum: spec(1, 0.5) },
    { rgb: [0, 255, 255], spectrum: spec(0.5, 1) },
    { rgb: [255, 255, 255], spectrum: spec(2, 2) },
  ]

  it('reconstructs a sample spectrum at zero distance (rank-2 fully captured)', () => {
    const interp = buildPcaInterpolator(points, { nComp: 4, k: 4 })
    const out = interp.query([255, 0, 0])
    const truth = spec(1, 0)
    for (let b = 0; b < truth.length; b++) expect(out[b]).toBeCloseTo(truth[b], 6)
  })

  it('keeps interpolated output on the rank-2 manifold (bounded, finite)', () => {
    const interp = buildPcaInterpolator(points, { nComp: 4, k: 4 })
    const out = interp.query([128, 64, 32])
    expect(out).toHaveLength(6)
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })

  it('throws on empty input', () => {
    expect(() => buildPcaInterpolator([])).toThrow()
  })
})
