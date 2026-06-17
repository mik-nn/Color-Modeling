/**
 * TDD: coverage6Chart — map 6/8/12 device RGB targets to anchor indices.
 * Support: cov6, cov8n, cov12 (fixed grids, target-agnostic).
 */

import { describe, it, expect } from 'vitest'
import type { ProfileMatrices } from '../dataset/matrix'
import { validateCoverageChart, mapDeviceToAnchorIdx } from './coverage6Chart'

/**
 * Mock profile: 905 patches (aligned 2x profile), RGB device.
 * Include patches near cov6/8/12 targets; some duplicates to test dedup.
 */
function mockProfile(): ProfileMatrices {
  const N = 905
  const D = new Float64Array(N * 3)
  const samples: string[] = []

  // Add cov6 targets + nearby
  const targets6: Array<[number, number, number, string]> = [
    [255, 255, 255, 'paper'],
    [0, 255, 255, 'cyan'],
    [255, 0, 255, 'magenta'],
    [255, 255, 0, 'yellow'],
    [0, 0, 0, 'black'],
    [128, 128, 128, 'gray128'],
  ]

  let idx = 0
  for (const [r, g, b, label] of targets6) {
    D[idx * 3] = r; D[idx * 3 + 1] = g; D[idx * 3 + 2] = b
    samples.push(`${label}(${idx})`)
    idx++
  }
  // Add gray64, gray192 for cov8n
  D[idx * 3] = 64; D[idx * 3 + 1] = 64; D[idx * 3 + 2] = 64; samples.push('gray64(6)'); idx++
  D[idx * 3] = 192; D[idx * 3 + 1] = 192; D[idx * 3 + 2] = 192; samples.push('gray192(7)'); idx++

  // Fill rest with noise
  while (idx < N) {
    D[idx * 3] = Math.random() * 255
    D[idx * 3 + 1] = Math.random() * 255
    D[idx * 3 + 2] = Math.random() * 255
    samples.push(`noise(${idx})`)
    idx++
  }

  return { N, D, channels: 3, X: new Float64Array(N * 36), L: 36, wavelengths: Array.from({ length: 36 }, (_, i) => 380 + i * 10), sampleIds: samples, droppedCount: 0 }
}

describe('coverage6Chart', () => {
  describe('validateCoverageChart', () => {
    it('accepts k ∈ {6, 8, 12}', () => {
      expect(() => validateCoverageChart(6)).not.toThrow()
      expect(() => validateCoverageChart(8)).not.toThrow()
      expect(() => validateCoverageChart(12)).not.toThrow()
    })

    it('rejects k outside {6, 8, 12}', () => {
      expect(() => validateCoverageChart(5)).toThrow(/k must be.*6.*8.*12/)
      expect(() => validateCoverageChart(9)).toThrow(/k must be.*6.*8.*12/)
    })
  })

  describe('mapDeviceToAnchorIdx', () => {
    const prof = mockProfile()

    it('maps cov6 targets to correct indices', () => {
      const result = mapDeviceToAnchorIdx(prof, 6)
      expect(result.anchorIdx.length).toBe(6)
      expect(result.anchorIdx).toContain(0) // paper
      expect(result.anchorIdx).toContain(4) // black
    })

    it('maps cov8n (cov6 + gray64/192) to 8 indices', () => {
      const result = mapDeviceToAnchorIdx(prof, 8)
      expect(result.anchorIdx.length).toBe(8)
      expect(result.anchorIdx).toContain(6) // gray64
      expect(result.anchorIdx).toContain(7) // gray192
    })

    it('deduplicates when target lands on same patch twice', () => {
      // If gray128 and another target both map to same row, deduplicate
      const result = mapDeviceToAnchorIdx(prof, 6)
      const unique = new Set(result.anchorIdx)
      expect(unique.size).toBe(result.anchorIdx.length)
    })

    it('includes paper white, black, and mid-gray for cov6', () => {
      const result = mapDeviceToAnchorIdx(prof, 6)
      const labels = result.anchorIdx.map(i => prof.sampleIds[i])
      expect(labels.some(l => l.includes('paper'))).toBe(true)
      expect(labels.some(l => l.includes('black'))).toBe(true)
      expect(labels.some(l => l.includes('gray128'))).toBe(true)
    })

    it('returns metadata with target RGB and matched RGB', () => {
      const result = mapDeviceToAnchorIdx(prof, 6)
      expect(result.metadata).toBeDefined()
      expect(result.metadata.targets).toHaveLength(6)
      expect(result.metadata.matched).toHaveLength(6)
      // Each matched should be close to its target (Euclidean distance small)
      for (let i = 0; i < result.metadata.targets.length; i++) {
        const [tr, tg, tb] = result.metadata.targets[i]
        const [mr, mg, mb] = result.metadata.matched[i]
        const dist = Math.hypot(mr - tr, mg - tg, mb - tb)
        expect(dist).toBeLessThan(10) // within 10 levels (relaxed for noise)
      }
    })

    it('cov8n includes all cov6 + 2 neutrals', () => {
      const res6 = mapDeviceToAnchorIdx(prof, 6)
      const res8n = mapDeviceToAnchorIdx(prof, 8)
      expect(res8n.anchorIdx).toEqual(expect.arrayContaining(res6.anchorIdx.slice(0, 6)))
    })
  })
})
