import { describe, it, expect } from 'vitest'
import { colorantChart } from './colorantChart'

describe('colorantChart', () => {
  it('k=5 returns exactly 5 patches', () => {
    expect(colorantChart(5)).toHaveLength(5)
  })

  it('k=6 returns exactly 6 patches', () => {
    expect(colorantChart(6)).toHaveLength(6)
  })

  it('k=8 returns exactly 8 patches', () => {
    expect(colorantChart(8)).toHaveLength(8)
  })

  it('k=12 returns exactly 12 patches', () => {
    expect(colorantChart(12)).toHaveLength(12)
  })

  it('k=16 returns exactly 16 patches', () => {
    expect(colorantChart(16)).toHaveLength(16)
  })

  it('k=5 includes white (paper) patch', () => {
    const chart = colorantChart(5)
    expect(chart).toContainEqual([255, 255, 255])
  })

  it('k=5 includes CMY primaries', () => {
    const chart = colorantChart(5)
    expect(chart).toContainEqual([0, 255, 255])   // cyan
    expect(chart).toContainEqual([255, 0, 255])   // magenta
    expect(chart).toContainEqual([255, 255, 0])   // yellow
  })

  it('k=8 includes RGB secondaries', () => {
    const chart = colorantChart(8)
    expect(chart).toContainEqual([255, 0, 0])   // red
    expect(chart).toContainEqual([0, 255, 0])   // green
    expect(chart).toContainEqual([0, 0, 255])   // blue
  })

  it('k=8 includes white, black, CMY primaries, RGB secondaries', () => {
    const k8 = colorantChart(8)
    // 8-colorant geometry: the 3 CMY primaries + 3 RGB secondaries + white + black
    for (const pt of [[255,255,255],[0,0,0],[0,255,255],[255,0,255],[255,255,0],[255,0,0],[0,255,0],[0,0,255]] as [number,number,number][]) {
      expect(k8).toContainEqual(pt)
    }
  })

  it('k=12 is superset of k=8', () => {
    const k8 = colorantChart(8)
    const k12 = colorantChart(12)
    for (const pt of k8) expect(k12).toContainEqual(pt)
  })

  it('k=16 is superset of k=12', () => {
    const k12 = colorantChart(12)
    const k16 = colorantChart(16)
    for (const pt of k12) expect(k16).toContainEqual(pt)
  })

  it('all RGB values are in [0, 255]', () => {
    for (const k of [5, 6, 8, 12, 16] as const) {
      for (const [r, g, b] of colorantChart(k)) {
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThanOrEqual(255)
        expect(g).toBeGreaterThanOrEqual(0)
        expect(g).toBeLessThanOrEqual(255)
        expect(b).toBeGreaterThanOrEqual(0)
        expect(b).toBeLessThanOrEqual(255)
      }
    }
  })

  it('no duplicate patches within a chart', () => {
    for (const k of [5, 6, 8, 12, 16] as const) {
      const chart = colorantChart(k)
      const seen = new Set(chart.map(p => p.join(',')))
      expect(seen.size).toBe(k)
    }
  })
})
