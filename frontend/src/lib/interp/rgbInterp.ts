// src/lib/interp/rgbInterp.ts
//
// Scattered-data interpolation of RGB → reflectance spectrum, used to put two
// profiles measured on different RGB charts (BC 905-patch vs MOAB ~2033-patch
// 12-level lattice) onto a common RGB query grid so their device response can be
// compared.
//
// Method: per-query k-nearest-neighbour inverse-distance weighting (IDW) in
// normalised RGB ∈ [0,1]³, applied independently to each wavelength band. IDW is
// chosen over RBF/spline because a per-band RBF over ~2000 points needs an N×N
// solve; IDW is O(N) per query, deterministic, and trivially testable. It is an
// approximation — callers should report the leave-one-out RMS (`looRms`) as the
// interpolation noise floor so cross-profile ΔE is not read below it.

export interface InterpPoint {
  rgb: [number, number, number] // device RGB, 0..255
  spectrum: number[] // reflectance, one value per band
}

export interface Interpolator {
  query(rgb: [number, number, number]): number[]
  readonly bands: number
  readonly size: number
}

export interface InterpOptions {
  k?: number // neighbours (default 8)
  power?: number // IDW exponent on distance (default 2)
}

interface Norm {
  c: [number, number, number] // normalised coords 0..1
  s: number[]
}

export function buildInterpolator(points: InterpPoint[], opts: InterpOptions = {}): Interpolator {
  if (points.length === 0) throw new Error('buildInterpolator: no points')
  const bands = points[0].spectrum.length
  for (const p of points) {
    if (p.spectrum.length !== bands) {
      throw new Error('buildInterpolator: inconsistent spectrum length')
    }
  }
  const k = Math.max(1, Math.min(opts.k ?? 8, points.length))
  const power = opts.power ?? 2
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
      // Exact hit → return that sample's spectrum unchanged.
      for (const x of ds) if (x.d2 === 0) return pts[x.i].s.slice()
      ds.sort((a, b) => a.d2 - b.d2)
      const out = new Array<number>(bands).fill(0)
      let wsum = 0
      const kk = Math.min(k, ds.length)
      for (let j = 0; j < kk; j++) {
        const { i, d2 } = ds[j]
        const w = Math.pow(d2, -power / 2) // = 1 / distance^power
        wsum += w
        const s = pts[i].s
        for (let b = 0; b < bands; b++) out[b] += w * s[b]
      }
      for (let b = 0; b < bands; b++) out[b] /= wsum
      return out
    },
  }
}

/** Regular RGB lattice with `levels` evenly-spaced values per channel over 0..255. */
export function regularGrid(levels: number): [number, number, number][] {
  if (levels < 2) throw new Error('regularGrid: levels must be ≥ 2')
  const vals = Array.from({ length: levels }, (_, i) => (i / (levels - 1)) * 255)
  const out: [number, number, number][] = []
  for (const r of vals) for (const g of vals) for (const b of vals) out.push([r, g, b])
  return out
}

export interface Box {
  min: [number, number, number]
  max: [number, number, number]
}

/** Per-channel bounding box (0..255) of a point set's RGB coordinates. */
export function boundingBox(points: InterpPoint[]): Box {
  if (points.length === 0) throw new Error('boundingBox: no points')
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p.rgb[i] < min[i]) min[i] = p.rgb[i]
      if (p.rgb[i] > max[i]) max[i] = p.rgb[i]
    }
  }
  return { min, max }
}

/** Intersection of two boxes; null if they do not overlap on every axis. */
export function intersectBox(a: Box, b: Box): Box | null {
  const min: [number, number, number] = [0, 0, 0]
  const max: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    min[i] = Math.max(a.min[i], b.min[i])
    max[i] = Math.min(a.max[i], b.max[i])
    if (min[i] > max[i]) return null
  }
  return { min, max }
}

export function inBox(rgb: [number, number, number], box: Box): boolean {
  for (let i = 0; i < 3; i++) if (rgb[i] < box.min[i] || rgb[i] > box.max[i]) return false
  return true
}

/**
 * Leave-one-out interpolation RMS over reflectance: for each sample, rebuild the
 * interpolator without it and predict its spectrum from neighbours. Returns the
 * RMS reflectance error — the interpolation noise floor for this point set.
 */
export function looRms(points: InterpPoint[], opts: InterpOptions = {}): number {
  if (points.length < 2) throw new Error('looRms: need ≥ 2 points')
  let sumSq = 0
  let n = 0
  for (let hold = 0; hold < points.length; hold++) {
    const rest = points.filter((_, i) => i !== hold)
    const interp = buildInterpolator(rest, opts)
    const pred = interp.query(points[hold].rgb)
    const truth = points[hold].spectrum
    for (let b = 0; b < truth.length; b++) {
      const e = pred[b] - truth[b]
      sumSq += e * e
      n++
    }
  }
  return Math.sqrt(sumSq / n)
}
