import { describe, expect, it } from 'vitest'
import { spectraToXYZ } from '../colormath'
import type { ProfileMatrices } from '../dataset/matrix'
import {
  angularDistanceDeg,
  hueDegrees,
  labChroma,
  labFromMatrixRow,
  pickLabSaturationAnchors,
} from './labSaturation'

function flatSpectrum(v: number, L = 36): Float64Array {
  const out = new Float64Array(L)
  out.fill(v)
  return out
}

function mkProfile(
  rows: Array<{ id: string; rgb: [number, number, number]; spectrum: Float64Array }>,
): ProfileMatrices {
  const L = rows[0].spectrum.length
  const X = new Float64Array(rows.length * L)
  const D = new Float64Array(rows.length * 3)
  for (let i = 0; i < rows.length; i++) {
    X.set(rows[i].spectrum, i * L)
    D.set(rows[i].rgb, i * 3)
  }
  return {
    X,
    D,
    channels: 3,
    N: rows.length,
    L,
    wavelengths: Array.from({ length: L }, (_, i) => 380 + i * 10),
    sampleIds: rows.map((r) => r.id),
    droppedCount: 0,
  }
}

describe('labSaturation helpers', () => {
  it('computes Lab chroma from a/b', () => {
    expect(labChroma([50, 3, 4])).toBe(5)
  })

  it('computes hue in [0, 360)', () => {
    expect(hueDegrees([50, 1, 0])).toBeCloseTo(0, 6)
    expect(hueDegrees([50, 0, 1])).toBeCloseTo(90, 6)
    expect(hueDegrees([50, -1, -1])).toBeCloseTo(225, 6)
  })

  it('computes shortest angular distance', () => {
    expect(angularDistanceDeg(10, 350)).toBe(20)
    expect(angularDistanceDeg(30, 150)).toBe(120)
    expect(angularDistanceDeg(0, 180)).toBe(180)
  })

  it('converts a matrix row spectrum to paper-relative Lab', () => {
    const profile = mkProfile([
      { id: 'paper', rgb: [255, 255, 255], spectrum: flatSpectrum(1) },
      { id: 'gray', rgb: [128, 128, 128], spectrum: flatSpectrum(0.5) },
    ])

    const lab = labFromMatrixRow(profile, 0, spectraToXYZ(Array.from(flatSpectrum(1))))

    expect(lab[0]).toBeCloseTo(100, 1)
    expect(Math.abs(lab[1])).toBeLessThan(0.2)
    expect(Math.abs(lab[2])).toBeLessThan(0.2)
  })

  it('throws for out-of-range row conversion', () => {
    const profile = mkProfile([{ id: 'paper', rgb: [255, 255, 255], spectrum: flatSpectrum(1) }])

    expect(() => labFromMatrixRow(profile, 1, spectraToXYZ(Array.from(flatSpectrum(1))))).toThrow(
      /out of range/,
    )
  })
})

describe('pickLabSaturationAnchors', () => {
  it('picks paper first and then high-chroma separated anchors', () => {
    const red = flatSpectrum(0.2)
    red[20] = 0.9
    const green = flatSpectrum(0.2)
    green[14] = 0.9
    const gray = flatSpectrum(0.45)

    const profile = mkProfile([
      { id: 'paper', rgb: [255, 255, 255], spectrum: flatSpectrum(1) },
      { id: 'gray', rgb: [128, 128, 128], spectrum: gray },
      { id: 'redish', rgb: [255, 0, 0], spectrum: red },
      { id: 'greenish', rgb: [0, 255, 0], spectrum: green },
    ])

    const anchors = pickLabSaturationAnchors(profile, { count: 2, minHueSeparationDeg: 60 })

    expect(anchors.sampleIds[0]).toBe('paper')
    expect(anchors.sampleIds).toContain('redish')
    expect(anchors.sampleIds).toContain('greenish')
    expect(anchors.meta?.labels).toEqual(['paper', 'sat_1', 'sat_2'])
  })

  it('falls back to next-highest chroma when hue separation cannot be met', () => {
    const profile = mkProfile([
      { id: 'paper', rgb: [255, 255, 255], spectrum: flatSpectrum(1) },
      { id: 'a', rgb: [255, 0, 0], spectrum: flatSpectrum(0.2) },
      { id: 'b', rgb: [240, 0, 0], spectrum: flatSpectrum(0.25) },
    ])

    const anchors = pickLabSaturationAnchors(profile, { count: 2, minHueSeparationDeg: 180 })

    expect(anchors.sampleIds).toHaveLength(3)
    expect(new Set(anchors.sampleIds).size).toBe(3)
  })

  it('throws on invalid count and non-RGB profiles', () => {
    const profile = mkProfile([{ id: 'paper', rgb: [255, 255, 255], spectrum: flatSpectrum(1) }])
    expect(() => pickLabSaturationAnchors(profile, { count: 0 })).toThrow(/count/)

    const cmykProfile = { ...profile, channels: 4 as const }
    expect(() => pickLabSaturationAnchors(cmykProfile)).toThrow(/RGB-only/)
  })
})
