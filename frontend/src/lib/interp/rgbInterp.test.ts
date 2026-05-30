import { describe, it, expect } from 'vitest'
import {
  buildInterpolator,
  regularGrid,
  boundingBox,
  intersectBox,
  inBox,
  looRms,
  InterpPoint,
} from './rgbInterp'

const cube: InterpPoint[] = [
  { rgb: [0, 0, 0], spectrum: [0, 0] },
  { rgb: [255, 0, 0], spectrum: [1, 0] },
  { rgb: [0, 255, 0], spectrum: [0, 1] },
  { rgb: [0, 0, 255], spectrum: [0.5, 0.5] },
  { rgb: [255, 255, 0], spectrum: [1, 1] },
  { rgb: [255, 0, 255], spectrum: [1, 0.5] },
  { rgb: [0, 255, 255], spectrum: [0.5, 1] },
  { rgb: [255, 255, 255], spectrum: [1, 1] },
]

describe('buildInterpolator', () => {
  it('throws on empty input', () => {
    expect(() => buildInterpolator([])).toThrow()
  })
  it('throws on inconsistent spectrum length', () => {
    expect(() =>
      buildInterpolator([
        { rgb: [0, 0, 0], spectrum: [0] },
        { rgb: [1, 1, 1], spectrum: [0, 0] },
      ]),
    ).toThrow()
  })
  it('reproduces a sample spectrum exactly at zero distance', () => {
    const interp = buildInterpolator(cube)
    expect(interp.query([255, 0, 0])).toEqual([1, 0])
    expect(interp.query([0, 255, 255])).toEqual([0.5, 1])
  })
  it('bounds each band within the neighbour min/max (IDW is a weighted average)', () => {
    const interp = buildInterpolator(cube, { k: 4 })
    const out = interp.query([200, 50, 50])
    for (let b = 0; b < 2; b++) {
      expect(out[b]).toBeGreaterThanOrEqual(0)
      expect(out[b]).toBeLessThanOrEqual(1)
    }
  })
  it('returns the average at the centroid of two symmetric points', () => {
    const pts: InterpPoint[] = [
      { rgb: [0, 0, 0], spectrum: [0, 10] },
      { rgb: [255, 0, 0], spectrum: [2, 20] },
    ]
    const interp = buildInterpolator(pts, { k: 2 })
    const out = interp.query([127.5, 0, 0]) // equidistant
    expect(out[0]).toBeCloseTo(1, 6)
    expect(out[1]).toBeCloseTo(15, 6)
  })
  it('lets the nearer point dominate', () => {
    const pts: InterpPoint[] = [
      { rgb: [0, 0, 0], spectrum: [0] },
      { rgb: [255, 0, 0], spectrum: [1] },
    ]
    const interp = buildInterpolator(pts, { k: 2, power: 2 })
    const near0 = interp.query([25, 0, 0])[0]
    expect(near0).toBeLessThan(0.5) // closer to the [0] sample
  })
})

describe('regularGrid', () => {
  it('throws below 2 levels', () => {
    expect(() => regularGrid(1)).toThrow()
  })
  it('produces levels^3 points spanning the full cube', () => {
    const g = regularGrid(3)
    expect(g).toHaveLength(27)
    expect(g).toContainEqual([0, 0, 0])
    expect(g).toContainEqual([255, 255, 255])
    expect(g).toContainEqual([127.5, 127.5, 127.5])
  })
})

describe('boxes', () => {
  it('computes a bounding box', () => {
    const box = boundingBox([
      { rgb: [10, 20, 30], spectrum: [0] },
      { rgb: [200, 5, 90], spectrum: [0] },
    ])
    expect(box.min).toEqual([10, 5, 30])
    expect(box.max).toEqual([200, 20, 90])
  })
  it('intersects overlapping boxes and rejects disjoint ones', () => {
    const a = { min: [0, 0, 0] as [number, number, number], max: [100, 100, 100] as [number, number, number] }
    const b = { min: [50, 50, 50] as [number, number, number], max: [200, 200, 200] as [number, number, number] }
    expect(intersectBox(a, b)).toEqual({ min: [50, 50, 50], max: [100, 100, 100] })
    const c = { min: [150, 0, 0] as [number, number, number], max: [200, 50, 50] as [number, number, number] }
    expect(intersectBox(a, c)).toBeNull()
  })
  it('inBox respects bounds', () => {
    const box = { min: [0, 0, 0] as [number, number, number], max: [100, 100, 100] as [number, number, number] }
    expect(inBox([50, 50, 50], box)).toBe(true)
    expect(inBox([101, 0, 0], box)).toBe(false)
  })
})

describe('looRms', () => {
  it('is small for a smooth field on a dense grid', () => {
    // reflectance = linear ramp in R; dense sampling → low LOO error
    const pts: InterpPoint[] = []
    for (let r = 0; r <= 255; r += 15) pts.push({ rgb: [r, 0, 0], spectrum: [r / 255] })
    const rms = looRms(pts, { k: 2, power: 2 })
    expect(rms).toBeLessThan(0.05)
  })
  it('throws with fewer than 2 points', () => {
    expect(() => looRms([{ rgb: [0, 0, 0], spectrum: [0] }])).toThrow()
  })
})
