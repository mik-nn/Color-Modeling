// src/lib/interp/pcaInterp.ts
//
// PCA-score interpolation. Instead of interpolating 36 reflectance bands
// independently (per-band IDW, see rgbInterp.ts), reduce each profile's spectra
// to a few principal-component scores, interpolate the scores in RGB space, and
// reconstruct the spectrum. This couples the bands (the PCA basis already encodes
// how reflectance co-varies across wavelength) and drops the low-variance PCs,
// which are mostly measurement noise — so it both regularises the interpolation
// and denoises. Drop-in alternative to buildInterpolator with the same
// Interpolator interface.

import { buildInterpolator, Interpolator, InterpPoint } from './rgbInterp'

export interface PCAResult {
  mean: number[] // length bands
  components: number[][] // sorted by descending variance; components[i] has length bands
  explained: number[] // explained-variance ratio per component (sums ~1)
}

export interface PcaInterpOptions {
  /** Max principal components to keep (default 8). */
  nComp?: number
  /** Keep the fewest components reaching this cumulative variance (default 0.995). */
  varThreshold?: number
  /** Neighbours for the score-space IDW (default 8). */
  k?: number
  /** IDW distance exponent (default 2). */
  power?: number
}

// Symmetric-matrix eigendecomposition via classical (max-element) Jacobi rotation.
// Returns eigenvalues + eigenvectors (vectors[i] is the i-th eigenvector), unsorted.
export function jacobiEigen(input: number[][]): { values: number[]; vectors: number[][] } {
  const n = input.length
  const A = input.map((r) => r.slice())
  // V holds eigenvectors as columns.
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  )
  const maxSweeps = 100 * n * n
  for (let iter = 0; iter < maxSweeps; iter++) {
    // Largest off-diagonal magnitude.
    let p = 0
    let q = 1
    let off = 0
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(A[i][j]) > off) {
          off = Math.abs(A[i][j])
          p = i
          q = j
        }
      }
    }
    if (off < 1e-12) break

    const apq = A[p][q]
    const theta = (A[q][q] - A[p][p]) / (2 * apq)
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
    const c = 1 / Math.sqrt(t * t + 1)
    const s = t * c

    for (let i = 0; i < n; i++) {
      const aip = A[i][p]
      const aiq = A[i][q]
      A[i][p] = c * aip - s * aiq
      A[i][q] = s * aip + c * aiq
    }
    for (let i = 0; i < n; i++) {
      const api = A[p][i]
      const aqi = A[q][i]
      A[p][i] = c * api - s * aqi
      A[q][i] = s * api + c * aqi
    }
    for (let i = 0; i < n; i++) {
      const vip = V[i][p]
      const viq = V[i][q]
      V[i][p] = c * vip - s * viq
      V[i][q] = s * vip + c * viq
    }
  }

  const values = A.map((_, i) => A[i][i])
  const vectors: number[][] = []
  for (let j = 0; j < n; j++) vectors.push(V.map((row) => row[j]))
  return { values, vectors }
}

export function pca(spectra: number[][], maxK = 8): PCAResult {
  const n = spectra.length
  if (n < 2) throw new Error('pca: need ≥ 2 spectra')
  const bands = spectra[0].length
  for (const s of spectra) if (s.length !== bands) throw new Error('pca: inconsistent length')

  const mean = new Array<number>(bands).fill(0)
  for (const s of spectra) for (let b = 0; b < bands; b++) mean[b] += s[b]
  for (let b = 0; b < bands; b++) mean[b] /= n

  // Covariance (bands × bands).
  const cov: number[][] = Array.from({ length: bands }, () => new Array<number>(bands).fill(0))
  for (const s of spectra) {
    const c = s.map((v, b) => v - mean[b])
    for (let i = 0; i < bands; i++) for (let j = i; j < bands; j++) cov[i][j] += c[i] * c[j]
  }
  const denom = n - 1
  for (let i = 0; i < bands; i++) {
    for (let j = i; j < bands; j++) {
      cov[i][j] /= denom
      cov[j][i] = cov[i][j]
    }
  }

  const { values, vectors } = jacobiEigen(cov)
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a])
  const totalVar = values.reduce((acc, v) => acc + Math.max(0, v), 0) || 1
  const k = Math.min(maxK, bands, n - 1)

  const components: number[][] = []
  const explained: number[] = []
  for (let r = 0; r < k; r++) {
    const idx = order[r]
    components.push(vectors[idx])
    explained.push(Math.max(0, values[idx]) / totalVar)
  }
  return { mean, components, explained }
}

/** PCA-score interpolator with the same interface as buildInterpolator. */
export function buildPcaInterpolator(
  points: InterpPoint[],
  opts: PcaInterpOptions = {},
): Interpolator {
  if (points.length === 0) throw new Error('buildPcaInterpolator: no points')
  const bands = points[0].spectrum.length
  const maxK = opts.nComp ?? 8
  const varThreshold = opts.varThreshold ?? 0.995

  const res = pca(
    points.map((p) => p.spectrum),
    maxK,
  )

  // Pick the fewest components reaching the variance threshold.
  let cum = 0
  let k = 0
  for (; k < res.components.length; k++) {
    cum += res.explained[k]
    if (cum >= varThreshold) {
      k++
      break
    }
  }
  k = Math.max(1, Math.min(k, res.components.length))
  const comps = res.components.slice(0, k)
  const mean = res.mean

  const project = (spectrum: number[]): number[] =>
    comps.map((comp) => {
      let acc = 0
      for (let b = 0; b < bands; b++) acc += comp[b] * (spectrum[b] - mean[b])
      return acc
    })

  // Interpolate scores in RGB space using the existing IDW machinery.
  const scorePoints: InterpPoint[] = points.map((p) => ({ rgb: p.rgb, spectrum: project(p.spectrum) }))
  const inner = buildInterpolator(scorePoints, { k: opts.k ?? 8, power: opts.power ?? 2 })

  return {
    bands,
    size: points.length,
    query(rgb: [number, number, number]): number[] {
      const scores = inner.query(rgb)
      const out = mean.slice()
      for (let j = 0; j < comps.length; j++) {
        const sj = scores[j]
        const comp = comps[j]
        for (let b = 0; b < bands; b++) out[b] += sj * comp[b]
      }
      return out
    },
  }
}
