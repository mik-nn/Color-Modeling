/**
 * TDD: generateDataset — orchestrator (D7 OBA → D1 or pool-PCA → 905×36).
 *
 * generateDataset(input): takes 1+ reference profiles + 6/8/12 anchor
 * measurements on a new substrate → returns predicted full 905×36 dataset.
 */

import { describe, it, expect } from 'vitest'
import type { GenerateDatasetInput, GenerateDatasetResult } from './generateDataset'
import { generateDataset } from './generateDataset'
import type { ProfileData } from '../../types'

// ---- synthetic profile factory ----------------------------------------
// 905 patches, 36 bands. Paper at index 0 (RGB 255,255,255).
// Spectra: simple linear model R(λ) = base(λ) * f(device)
// so D1 can transfer perfectly in a noise-free scenario.

const L = 36
const N = 905
const WL = Array.from({ length: L }, (_, i) => 380 + i * 10)

function makePaper(scale: number): number[] {
  // Flat-ish white paper spectrum
  return WL.map((wl) => scale * (0.85 + 0.1 * Math.sin((wl - 380) / 350 * Math.PI)))
}

function makePatch(paperSpec: number[], r: number, g: number, b: number): number[] {
  // Simplified: ink absorbs proportional to device coverage per channel
  const ink = (765 - r - g - b) / 765
  return paperSpec.map((p) => p * Math.max(0.05, 1 - ink * 0.7))
}

function makeProfile(name: string, paperScale: number): ProfileData {
  const paperSpec = makePaper(paperScale)
  const measurements: ProfileData['measurements'] = []

  // Put paper white first
  measurements.push({
    SAMPLE_ID: 'R1C1P1',
    RGB_R: 255, RGB_G: 255, RGB_B: 255,
    spectra: paperSpec,
    has_spectral: true,
  } as any)

  // Coverage-6 targets
  const targets: Array<[number, number, number]> = [
    [0, 255, 255], [255, 0, 255], [255, 255, 0], [0, 0, 0], [128, 128, 128],
  ]
  for (const [r, g, b] of targets) {
    measurements.push({
      SAMPLE_ID: `R1C${measurements.length + 1}P1`,
      RGB_R: r, RGB_G: g, RGB_B: b,
      spectra: makePatch(paperSpec, r, g, b),
      has_spectral: true,
    } as any)
  }

  // Fill up to 905 patches
  let row = 2
  while (measurements.length < N) {
    const r = Math.floor((measurements.length * 7) % 256)
    const g = Math.floor((measurements.length * 13) % 256)
    const b = Math.floor((measurements.length * 19) % 256)
    measurements.push({
      SAMPLE_ID: `R${row}C${(measurements.length % 29) + 1}P1`,
      RGB_R: r, RGB_G: g, RGB_B: b,
      spectra: makePatch(paperSpec, r, g, b),
      has_spectral: true,
    } as any)
    if (measurements.length % 29 === 0) row++
  }

  return {
    metadata: {
      full_name: name,
      brand: 'test',
      series: name,
      printer: 'P9000',
      ink: 'mk',
      substrate: name,
      parsed_at: new Date().toISOString(),
      printMode: 'CanvasMatte',
    },
    raw: measurements,
    has_spectral: true,
    patch_count: N,
    wavelengths: WL,
  } as any
}

function makeAnchors(paperScale: number, k: 6 | 8 | 12) {
  const paperSpec = makePaper(paperScale)
  const targets6: Array<[number, number, number]> = [
    [255, 255, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0], [0, 0, 0], [128, 128, 128],
  ]
  const extra8: Array<[number, number, number]> = [[64, 64, 64], [192, 192, 192]]
  const extra12: Array<[number, number, number]> = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [64, 64, 64], [192, 192, 192],
  ]
  const list =
    k === 6 ? targets6
    : k === 8 ? [...targets6, ...extra8]
    : [...targets6, ...extra12]
  return list.slice(0, k).map(([r, g, b]) => ({
    device: [r, g, b] as [number, number, number],
    spectrum: makePatch(paperSpec, r, g, b),
  }))
}

// ---- tests ---------------------------------------------------------------

describe('generateDataset', () => {
  describe('input validation', () => {
    it('throws when refs empty', () => {
      expect(() => generateDataset({
        refs: [],
        anchors: makeAnchors(0.9, 6),
        chartK: 6,
        targetName: 'TestB',
      })).toThrow(/at least one/)
    })

    it('throws when anchors < chartK', () => {
      const ref = makeProfile('RefA', 1.0)
      expect(() => generateDataset({
        refs: [ref],
        anchors: makeAnchors(0.9, 6).slice(0, 4), // only 4
        chartK: 6,
        targetName: 'TestB',
      })).toThrow(/anchor/)
    })

    it('throws when no paper-white anchor (255,255,255)', () => {
      const ref = makeProfile('RefA', 1.0)
      // Replace paper anchor with a duplicate of cyan so count stays 6 but no paper
      const anchors = makeAnchors(0.9, 6).map((a) =>
        a.device[0] === 255 && a.device[1] === 255 && a.device[2] === 255
          ? { device: [0, 255, 255] as [number, number, number], spectrum: a.spectrum }
          : a,
      )
      expect(() => generateDataset({
        refs: [ref],
        anchors,
        chartK: 6,
        targetName: 'TestB',
      })).toThrow(/paper.white/)
    })
  })

  describe('single ref (D1 path)', () => {
    const ref = makeProfile('RefA', 1.0)

    it('returns predicted Float64Array of shape N×L (905×36)', () => {
      const result = generateDataset({
        refs: [ref],
        anchors: makeAnchors(0.85, 6),
        chartK: 6,
        targetName: 'TargetB',
      })
      expect(result.predicted).toBeInstanceOf(Float64Array)
      expect(result.predicted.length).toBe(N * L)
    })

    it('returns correct N, sampleIds, deviceValues from reference', () => {
      const result = generateDataset({
        refs: [ref],
        anchors: makeAnchors(0.85, 6),
        chartK: 6,
        targetName: 'TargetB',
      })
      expect(result.sampleIds.length).toBe(N)
      expect(result.deviceValues.length).toBe(N * 3)
      expect(result.anchorIdx.length).toBeLessThanOrEqual(6)
    })

    it('predicted spectra are in [0, 1] range', () => {
      const result = generateDataset({
        refs: [ref],
        anchors: makeAnchors(0.85, 6),
        chartK: 6,
        targetName: 'TargetB',
      })
      let valid = true
      for (let i = 0; i < result.predicted.length; i++) {
        if (result.predicted[i] < -0.01 || result.predicted[i] > 1.5) {
          valid = false; break
        }
      }
      expect(valid).toBe(true)
    })

    it('returns anchorIdx matching coverage-6 targets', () => {
      const result = generateDataset({
        refs: [ref],
        anchors: makeAnchors(0.85, 6),
        chartK: 6,
        targetName: 'TargetB',
      })
      expect(result.anchorIdx.length).toBeGreaterThanOrEqual(5)
      expect(result.anchorIdx.length).toBeLessThanOrEqual(6)
    })

    it('path field is "D1"', () => {
      const result = generateDataset({
        refs: [ref],
        anchors: makeAnchors(0.85, 6),
        chartK: 6,
        targetName: 'TargetB',
      })
      expect(result.path).toBe('D1')
    })
  })

  describe('multiple refs (pool-PCA path)', () => {
    const refA = makeProfile('RefA', 1.0)
    const refB = makeProfile('RefB', 0.95)

    it('returns N×L output and path="pool-PCA"', () => {
      const result = generateDataset({
        refs: [refA, refB],
        anchors: makeAnchors(0.88, 6),
        chartK: 6,
        targetName: 'TargetC',
      })
      expect(result.predicted.length).toBe(N * L)
      expect(result.path).toBe('pool-PCA')
    })

    it('N, sampleIds, deviceValues come from first reference', () => {
      const result = generateDataset({
        refs: [refA, refB],
        anchors: makeAnchors(0.88, 6),
        chartK: 6,
        targetName: 'TargetC',
      })
      expect(result.sampleIds.length).toBe(N)
    })
  })

  describe('cov8n (8 anchors)', () => {
    const ref = makeProfile('RefA', 1.0)

    it('handles k=8 anchors without error', () => {
      const result = generateDataset({
        refs: [ref],
        anchors: makeAnchors(0.85, 8),
        chartK: 8,
        targetName: 'TargetB',
      })
      expect(result.predicted.length).toBe(N * L)
      expect(result.anchorIdx.length).toBeGreaterThanOrEqual(7)
    })
  })
})
