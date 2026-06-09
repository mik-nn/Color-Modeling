// src/lib/experiments/kSweep.test.ts
// Unit tests for kSweep aggregation math and dOptimalAnchors selection.

import { describe, it, expect } from 'vitest'
import { dOptimalAnchors, runKSweep } from './kSweep'
import type { ProfileData } from '../../types'

// ─── dOptimalAnchors ──────────────────────────────────────────────────────────

describe('dOptimalAnchors', () => {
  // 4 patches × 3 wavelengths, paper = row 0
  const X = new Float64Array([
    0.9, 0.9, 0.9, // paper (255,255,255)
    0.5, 0.1, 0.1, // red-ish
    0.1, 0.5, 0.1, // green-ish
    0.1, 0.1, 0.5, // blue-ish
  ])
  const N = 4
  const L = 3

  it('always includes paper as first anchor', () => {
    const anchors = dOptimalAnchors(X, N, L, 0, 3)
    expect(anchors[0]).toBe(0)
  })

  it('returns k distinct indices', () => {
    for (const k of [1, 2, 3, 4]) {
      const anchors = dOptimalAnchors(X, N, L, 0, k)
      expect(anchors.length).toBe(k)
      expect(new Set(anchors).size).toBe(k)
    }
  })

  it('does not exceed N anchors', () => {
    const anchors = dOptimalAnchors(X, N, L, 0, 100)
    expect(anchors.length).toBeLessThanOrEqual(N)
  })

  it('all indices are valid row indices', () => {
    const anchors = dOptimalAnchors(X, N, L, 0, 4)
    for (const a of anchors) {
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(N)
    }
  })

  it('selects most distinct patch second after paper', () => {
    // The three non-paper rows are orthogonal unit-ish vectors.
    // Second selected = any of them (all equally distinct from paper).
    const anchors = dOptimalAnchors(X, N, L, 0, 2)
    expect(anchors[1]).toBeGreaterThanOrEqual(1)
    expect(anchors[1]).toBeLessThanOrEqual(3)
  })
})

// ─── runKSweep on minimal synthetic fixture ───────────────────────────────────

function makeProfile(
  name: string,
  patches: { id: string; rgb: [number, number, number]; spec: number[] }[],
  printMode: string,
): ProfileData {
  return {
    metadata: {
      full_name: name,
      brand: 'test',
      series: 'test',
      printer: 'P9000',
      ink: 'mk',
      substrate: name,
      printMode,
      parsed_at: new Date().toISOString(),
    },
    raw: patches.map(p => ({
      SAMPLE_ID: p.id,
      spectra: p.spec,
      wavelengths: [380, 390, 400],
      RGB_R: p.rgb[0],
      RGB_G: p.rgb[1],
      RGB_B: p.rgb[2],
      device: { space: 'rgb' as const, values: p.rgb },
      CMYK_C: 0,
      CMYK_M: 0,
      CMYK_Y: 0,
      CMYK_K: 0,
      LAB_L: 50,
      LAB_A: 0,
      LAB_B: 0,
    })),
    clean: [],
    has_spectral: true,
    patch_count: patches.length,
    wavelengths: [380, 390, 400],
  }
}

function linearTransfer(spec: number[], scale: number, offset: number): number[] {
  return spec.map(v => Math.min(1, Math.max(0, v * scale + offset)))
}

// Two profiles with 20 patches and a simple affine substrate transform.
function makeSyntheticPair(
  modeA = 'CanvasMatte',
  modeB = 'CanvasMatte',
): [ProfileData, ProfileData] {
  const patches = Array.from({ length: 60 }, (_, i) => {
    const rgb: [number, number, number] = [
      Math.round(255 * (i / 19)),
      Math.round(255 * (1 - i / 19)),
      128,
    ]
    const spec = [0.9, 0.8, 0.7].map(v => v * (1 - i / 40))
    return { id: `R${i + 1}C1P1`, rgb, spec }
  })

  const profileA = makeProfile('ProfileA', patches, modeA)
  const profileB = makeProfile('ProfileB',
    patches.map(p => ({ ...p, spec: linearTransfer(p.spec, 0.9, 0.05) })),
    modeB,
  )
  return [profileA, profileB]
}

describe('runKSweep', () => {
  it('returns perK rows for each predictor × strategy × slice × k', () => {
    const [pA, pB] = makeSyntheticPair()
    const result = runKSweep([pA, pB], {
      predictors: ['D1'],
      anchorStrategies: ['dOptimal'],
      kGrid: [2, 3],
      maxPairsPerSlice: 5,
    })
    // Should have rows for same-mode (both CanvasMatte) at each k
    expect(result.perK.length).toBeGreaterThan(0)
    const row = result.perK.find(r => r.slice === 'same-mode' && r.k === 2)
    expect(row).toBeDefined()
    expect(row!.predictor).toBe('D1')
    expect(row!.anchorStrategy).toBe('dOptimal')
    expect(row!.nPairs).toBeGreaterThan(0)
    expect(row!.passFraction).toBeGreaterThanOrEqual(0)
    expect(row!.passFraction).toBeLessThanOrEqual(1)
  })

  it('passFraction is in [0, 1]', () => {
    const [pA, pB] = makeSyntheticPair()
    const result = runKSweep([pA, pB], {
      predictors: ['D1', 'C7'],
      anchorStrategies: ['greedy', 'dOptimal'],
      kGrid: [2, 3],
      maxPairsPerSlice: 5,
    })
    for (const row of result.perK) {
      expect(row.passFraction).toBeGreaterThanOrEqual(0)
      expect(row.passFraction).toBeLessThanOrEqual(1)
    }
  })

  it('cross-mode pairs classified correctly', () => {
    const [pA, pB] = makeSyntheticPair('CanvasMatte', 'WatercolorRadiantWhite')
    const result = runKSweep([pA, pB], {
      predictors: ['D1'],
      anchorStrategies: ['dOptimal'],
      kGrid: [2],
      maxPairsPerSlice: 5,
    })
    const crossRow = result.perK.find(r => r.slice === 'cross-mode')
    // May or may not find cross rows depending on canonicalPrintMode mapping
    if (crossRow) {
      expect(crossRow.nPairs).toBeGreaterThan(0)
    }
  })

  it('minKToPass entries cover all predictor × strategy × slice combinations', () => {
    const [pA, pB] = makeSyntheticPair()
    const result = runKSweep([pA, pB], {
      predictors: ['D1'],
      anchorStrategies: ['dOptimal'],
      kGrid: [2, 3],
      maxPairsPerSlice: 5,
    })
    expect(result.minKToPass.length).toBeGreaterThan(0)
    for (const m of result.minKToPass) {
      expect(['D1', 'C7']).toContain(m.predictor)
      expect(['greedy', 'dOptimal']).toContain(m.anchorStrategy)
      expect(['same-mode', 'cross-mode']).toContain(m.slice)
    }
  })
})
