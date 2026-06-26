// gamutVolume.test.ts
//
// Convex-hull volume of a 3D point cloud (used on Lab gamut bodies), verified
// against shapes with analytic volumes.

import { describe, it, expect } from 'vitest'
import { gamutHullVolume, maxChromaPerHueBin } from './gamutVolume'

const CUBE: number[][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
]

// Regular tetrahedron inscribed in the cube; analytic volume = 8/3.
const TETRA: number[][] = [
  [1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1],
]

// Cross-polytope (octahedron) ±e_i; analytic volume = 2^3 / 3! = 4/3.
const OCTA: number[][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

describe('gamutHullVolume', () => {
  it('unit cube → volume 1', () => {
    expect(gamutHullVolume(CUBE)).toBeCloseTo(1, 6)
  })

  it('regular tetrahedron → volume 8/3', () => {
    expect(gamutHullVolume(TETRA)).toBeCloseTo(8 / 3, 6)
  })

  it('octahedron → volume 4/3', () => {
    expect(gamutHullVolume(OCTA)).toBeCloseTo(4 / 3, 6)
  })

  it('interior points do not change the volume', () => {
    const withInterior = [...CUBE, [0.5, 0.5, 0.5], [0.3, 0.7, 0.2]]
    expect(gamutHullVolume(withInterior)).toBeCloseTo(1, 6)
  })

  it('scales with the cube of edge length', () => {
    const big = CUBE.map(([x, y, z]) => [2 * x, 2 * y, 2 * z])
    expect(gamutHullVolume(big)).toBeCloseTo(8, 6)
  })

  it('degenerate (coplanar) set → volume 0', () => {
    const plane = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0.5, 0.5, 0]]
    expect(gamutHullVolume(plane)).toBeCloseTo(0, 9)
  })

  it('fewer than 4 points → volume 0', () => {
    expect(gamutHullVolume([[0, 0, 0], [1, 0, 0], [0, 1, 0]])).toBe(0)
  })
})

describe('maxChromaPerHueBin', () => {
  it('keeps the largest chroma per hue bin', () => {
    // [L, a, b]; hue 0° (b=0, a>0), two chromas → bin 0 keeps 20.
    const bins = maxChromaPerHueBin([[50, 10, 0], [50, 20, 0]], 10)
    expect(bins.length).toBe(36)
    expect(bins[0]).toBeCloseTo(20, 6)
  })

  it('routes hue 90° into its own bin', () => {
    const bins = maxChromaPerHueBin([[50, 0, 15]], 10)
    expect(bins[9]).toBeCloseTo(15, 6) // hue 90° / 10° = bin 9
    expect(bins[0]).toBe(0)
  })
})
