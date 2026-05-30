// src/lib/interp/wlsInterp.ts
//
// Local-linear weighted-least-squares (WLS) interpolation of RGB → reflectance.
// At each query point, fit a hyperplane R(λ) ≈ β₀ + β₁·r + β₂·g + β₃·b per band
// from the k nearest neighbours weighted by w = 1/d^power, then evaluate the
// plane at the query. Unlike IDW (which is a bounded weighted average → always
// biased toward the local mean), WLS captures the local gradient → unbiased on
// smooth fields and noticeably tighter on irregular charts like BC's 905-patch
// layout. Same Interpolator interface as rgbInterp.buildInterpolator.

import { Interpolator, InterpPoint } from './rgbInterp'

export interface WlsInterpOptions {
  /** Neighbours used for the local fit. Default 16 (≥ 4 required for a 3-D plane). */
  k?: number
  /** IDW-style distance exponent for the weights. Default 2 (w = 1/d²). */
  power?: number
  /** Ridge regularisation added to the diagonal of AᵀWA to handle collinear neighbours. Default 1e-6. */
  ridge?: number
}

interface Norm {
  c: [number, number, number] // normalised coords 0..1
  s: number[]
}

/**
 * Solve a 4×4 symmetric positive-definite system A·x = b via Cholesky.
 * Returns null if A is not strictly positive-definite (caller falls back).
 */
function chol4Solve(A: number[][], b: number[]): number[] | null {
  // Copy to avoid mutating caller's matrix.
  const a = A.map((row) => row.slice())
  const L: number[][] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j]
      for (let kk = 0; kk < j; kk++) sum -= L[i][kk] * L[j][kk]
      if (i === j) {
        if (sum <= 0) return null
        L[i][i] = Math.sqrt(sum)
      } else {
        L[i][j] = sum / L[j][j]
      }
    }
  }
  // Forward solve L·y = b
  const y = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    let sum = b[i]
    for (let j = 0; j < i; j++) sum -= L[i][j] * y[j]
    y[i] = sum / L[i][i]
  }
  // Back solve Lᵀ·x = y
  const x = [0, 0, 0, 0]
  for (let i = 3; i >= 0; i--) {
    let sum = y[i]
    for (let j = i + 1; j < 4; j++) sum -= L[j][i] * x[j]
    x[i] = sum / L[i][i]
  }
  return x
}

export function buildWlsInterpolator(
  points: InterpPoint[],
  opts: WlsInterpOptions = {},
): Interpolator {
  if (points.length === 0) throw new Error('buildWlsInterpolator: no points')
  const bands = points[0].spectrum.length
  for (const p of points) {
    if (p.spectrum.length !== bands) {
      throw new Error('buildWlsInterpolator: inconsistent spectrum length')
    }
  }
  const k = Math.max(4, Math.min(opts.k ?? 16, points.length))
  const power = opts.power ?? 2
  const ridge = opts.ridge ?? 1e-6
  const pts: Norm[] = points.map((p) => ({
    c: [p.rgb[0] / 255, p.rgb[1] / 255, p.rgb[2] / 255],
    s: p.spectrum,
  }))

  return {
    bands,
    size: pts.length,
    query(rgb: [number, number, number]): number[] {
      const q: [number, number, number] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]
      const ds = pts.map((p, i) => {
        const dr = p.c[0] - q[0]
        const dg = p.c[1] - q[1]
        const db = p.c[2] - q[2]
        return { i, d2: dr * dr + dg * dg + db * db }
      })
      // Exact hit → return the sample's spectrum unchanged.
      for (const x of ds) if (x.d2 === 0) return pts[x.i].s.slice()

      ds.sort((a, b) => a.d2 - b.d2)
      const kk = Math.min(k, ds.length)

      // Build weighted normal equations AᵀWA (4×4 sym) and AᵀW·Y (4×bands).
      // x_i = [1, r_i, g_i, b_i] in normalised coords; w_i = 1 / d_i^power; y_i = spectrum_i.
      const AtWA: number[][] = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]
      const AtWy: number[][] = Array.from({ length: 4 }, () => new Array<number>(bands).fill(0))

      for (let j = 0; j < kk; j++) {
        const { i, d2 } = ds[j]
        const w = Math.pow(d2, -power / 2)
        const c = pts[i].c
        const x0 = 1
        const x1 = c[0]
        const x2 = c[1]
        const x3 = c[2]
        // Symmetric outer product accumulation.
        AtWA[0][0] += w * x0 * x0
        AtWA[0][1] += w * x0 * x1
        AtWA[0][2] += w * x0 * x2
        AtWA[0][3] += w * x0 * x3
        AtWA[1][1] += w * x1 * x1
        AtWA[1][2] += w * x1 * x2
        AtWA[1][3] += w * x1 * x3
        AtWA[2][2] += w * x2 * x2
        AtWA[2][3] += w * x2 * x3
        AtWA[3][3] += w * x3 * x3
        const s = pts[i].s
        for (let b = 0; b < bands; b++) {
          const wy = w * s[b]
          AtWy[0][b] += wy * x0
          AtWy[1][b] += wy * x1
          AtWy[2][b] += wy * x2
          AtWy[3][b] += wy * x3
        }
      }
      // Mirror upper triangle + ridge regularisation.
      for (let i = 0; i < 4; i++) {
        AtWA[i][i] += ridge
        for (let j = i + 1; j < 4; j++) AtWA[j][i] = AtWA[i][j]
      }

      const out = new Array<number>(bands).fill(0)
      // Solve per-band via Cholesky (one factorisation, bands back-substitutions).
      let solved = true
      for (let b = 0; b < bands; b++) {
        const beta = chol4Solve(AtWA, [AtWy[0][b], AtWy[1][b], AtWy[2][b], AtWy[3][b]])
        if (!beta) {
          solved = false
          break
        }
        out[b] = beta[0] + beta[1] * q[0] + beta[2] * q[1] + beta[3] * q[2]
      }
      if (solved) return out

      // Cholesky failed (collinear neighbours) → IDW fallback.
      const fb = new Array<number>(bands).fill(0)
      let wsum = 0
      for (let j = 0; j < kk; j++) {
        const { i, d2 } = ds[j]
        const w = Math.pow(d2, -power / 2)
        wsum += w
        const s = pts[i].s
        for (let b = 0; b < bands; b++) fb[b] += w * s[b]
      }
      for (let b = 0; b < bands; b++) fb[b] /= wsum
      return fb
    },
  }
}
