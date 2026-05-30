import { describe, it, expect } from 'vitest'
import { buildWlsInterpolator } from './wlsInterp'
import { InterpPoint } from './rgbInterp'

// Linear field: spectrum[b] = aB·r + bB·g + cB·b + offset (per band).
// WLS should recover it (almost) exactly within numerical tolerance.
function linearSpec(r: number, g: number, b: number): number[] {
  const rN = r / 255
  const gN = g / 255
  const bN = b / 255
  return [
    0.1 + 0.5 * rN + 0.1 * gN - 0.2 * bN, // band 0
    0.2 - 0.3 * rN + 0.4 * gN + 0.1 * bN, // band 1
    0.5 + 0.1 * rN + 0.1 * gN + 0.1 * bN, // band 2
  ]
}

const linearCube: InterpPoint[] = [
  { rgb: [0, 0, 0], spectrum: linearSpec(0, 0, 0) },
  { rgb: [255, 0, 0], spectrum: linearSpec(255, 0, 0) },
  { rgb: [0, 255, 0], spectrum: linearSpec(0, 255, 0) },
  { rgb: [0, 0, 255], spectrum: linearSpec(0, 0, 255) },
  { rgb: [255, 255, 0], spectrum: linearSpec(255, 255, 0) },
  { rgb: [255, 0, 255], spectrum: linearSpec(255, 0, 255) },
  { rgb: [0, 255, 255], spectrum: linearSpec(0, 255, 255) },
  { rgb: [255, 255, 255], spectrum: linearSpec(255, 255, 255) },
  { rgb: [128, 128, 128], spectrum: linearSpec(128, 128, 128) },
  { rgb: [64, 192, 128], spectrum: linearSpec(64, 192, 128) },
]

describe('buildWlsInterpolator', () => {
  it('throws on empty input', () => {
    expect(() => buildWlsInterpolator([])).toThrow()
  })

  it('reproduces sample spectra at zero distance', () => {
    const interp = buildWlsInterpolator(linearCube, { k: 8 })
    const out = interp.query([255, 0, 0])
    const truth = linearSpec(255, 0, 0)
    for (let b = 0; b < truth.length; b++) expect(out[b]).toBeCloseTo(truth[b], 6)
  })

  it('recovers a linear field at an interior point within tight tolerance', () => {
    const interp = buildWlsInterpolator(linearCube, { k: 8, ridge: 1e-9 })
    const q: [number, number, number] = [100, 150, 80]
    const out = interp.query(q)
    const truth = linearSpec(...q)
    // WLS on a linear field with all-corner neighbours should be (nearly) exact.
    for (let b = 0; b < truth.length; b++) expect(out[b]).toBeCloseTo(truth[b], 3)
  })

  it('beats IDW on a sloped field (sanity: lower error at an interior point)', async () => {
    const { buildInterpolator } = await import('./rgbInterp')
    const wls = buildWlsInterpolator(linearCube, { k: 8 })
    const idw = buildInterpolator(linearCube, { k: 8 })
    const q: [number, number, number] = [200, 50, 30]
    const truth = linearSpec(...q)
    const eWls = Math.max(...wls.query(q).map((v, i) => Math.abs(v - truth[i])))
    const eIdw = Math.max(...idw.query(q).map((v, i) => Math.abs(v - truth[i])))
    expect(eWls).toBeLessThan(eIdw)
  })

  it('falls back to IDW for collinear (degenerate) neighbour sets', () => {
    // All neighbours on the R-axis → AᵀWA is singular for the {g, b} columns.
    const collinear: InterpPoint[] = [
      { rgb: [0, 0, 0], spectrum: [0] },
      { rgb: [64, 0, 0], spectrum: [0.25] },
      { rgb: [128, 0, 0], spectrum: [0.5] },
      { rgb: [192, 0, 0], spectrum: [0.75] },
      { rgb: [255, 0, 0], spectrum: [1] },
    ]
    const interp = buildWlsInterpolator(collinear, { k: 4 })
    const out = interp.query([90, 0, 0])
    expect(out[0]).toBeGreaterThan(0)
    expect(out[0]).toBeLessThan(1)
    expect(Number.isFinite(out[0])).toBe(true)
  })
})
